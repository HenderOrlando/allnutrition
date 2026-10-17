import { fail, integer } from '../validation-core.mjs';
import { schemas } from '../schema.mjs';
import { addDays, bogotaDate, instant, priorPeriodBounds } from './dates.mjs';
import { stamp } from './commands.mjs';
import { buildBusinessReportTx, normalizeReportQuery } from './reports.mjs';
import { financeOverviewTx } from './finance.mjs';
import { getBusinessSettings } from './settings.mjs';
import { buildInsights } from './insights.mjs';
import { schedulerHealth } from './job-leases.mjs';
import { alertClientData } from './alerts.mjs';

const severityOrder = {critical:0,warning:1,info:2};
const DAY = 86400000;
const taskOrder = (a,b) => severityOrder[a.severity]-severityOrder[b.severity]
  || (a.firstSeenAt || '\uffff').localeCompare(b.firstSeenAt || '\uffff') || a.id.localeCompare(b.id);

// Currency facts have calendar-day precision. Compare only completed days in an open period.
export async function dashboardComparisonTx(tx, report) {
  const {period,anchorDate,asOf,filters}=report.query;
  const previous=priorPeriodBounds(period,anchorDate), current=report.bounds;
  if (report.closed) return {equivalent:true,mode:'full',currentReport:report,
    report:await buildBusinessReportTx(tx,{period,anchorDate:previous.startDate,asOf,filters}),
    currentBounds:current,previousBounds:previous,reason:null};
  const today=bogotaDate(asOf), completed=Math.max(0,(Date.parse(today)-Date.parse(current.startDate))/DAY);
  const previousDays=(Date.parse(previous.endDateExclusive)-Date.parse(previous.startDate))/DAY;
  if (!completed || today<=current.startDate) return {equivalent:false,mode:'elapsed',currentReport:report,
    report:await buildBusinessReportTx(tx,{period,anchorDate:previous.startDate,asOf,filters}),
    currentBounds:current,previousBounds:previous,reason:'Aún no hay un día completo de este período para comparar sin inventar horas.'};
  const comparable=Math.min(completed,previousDays);
  const previousEnd=addDays(previous.startDate,comparable), currentEnd=today;
  const [currentReport,prior]=await Promise.all([
    buildBusinessReportTx(tx,report.query,{endDateExclusive:currentEnd}),
    buildBusinessReportTx(tx,{period,anchorDate:previous.startDate,asOf,filters},{endDateExclusive:previousEnd}),
  ]);
  return {equivalent:completed<=previousDays,mode:'elapsed',currentReport,report:prior,
    currentBounds:currentReport.bounds,previousBounds:prior.bounds,
    reason:completed>previousDays ? 'El período anterior no tiene tantos días completos; los valores no representan tramos equivalentes.'
      : 'Se comparan días calendario completos. Hoy aparece en las tarjetas, no en la comparación.'};
}

export async function completedComparisonReportTx(tx, report) {
  if (report.closed) return report;
  const today=bogotaDate(report.query.asOf);
  if (today<=report.bounds.startDate) fail('Todavía no hay días completos para este detalle.');
  return buildBusinessReportTx(tx,report.query,{endDateExclusive:today});
}

function coverageTasks(report,responsibleName) {
  return report.coverage.pending.map(pending=>({id:`data:${pending.metric}:${pending.code}`,kind:'data',type:'business_data_missing',severity:'info',
    firstSeenAt:null,title:pending.label,reason:'Este dato impide completar el cálculo; no confirma una pérdida ni un retraso.',
    count:pending.count,amountMinor:null,responsibleName,
    action:{label:'Completar registros',view:{section:'reports',period:report.query.period,anchor:report.query.anchorDate,
      record:pending.metric,issue:'missing'}}}));
}
async function attentionTx(tx,report,automation,{page,all,severity,responsibleName}) {
  const where="a.state IN ('open','acknowledged')"+(severity?' AND a.severity=?':'');
  const values=severity?[severity]:[];
  const count=Number((await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t('alerts')} a WHERE ${where}`,values)).count);
  const missingRule=await tx.db.get(`SELECT enabled FROM ${tx.t('alert_rules')} WHERE type='business_data_missing' AND scope_key='global'`);
  const missingCount=Number((await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t('alerts')} a JOIN ${tx.t('alert_rules')} r ON r.id=a.rule_id WHERE a.state IN ('open','acknowledged') AND r.type='business_data_missing'`)).count);
  let other=missingRule?.enabled && !missingCount ? coverageTasks(report,responsibleName) : [];
  if (automation.status!=='running') other.push({id:'automation:scheduler:heartbeat',kind:'automation',type:'scheduler_status',severity:automation.status==='never'?'info':'warning',
    firstSeenAt:automation.lastHeartbeatAt,title:automation.status==='stale'?'Actualización automática detenida':automation.status==='never'?'Sin ejecución automática registrada':'Automatización por revisar',
    reason:automation.status==='never'?'No existe una señal del proceso. No se confirma que los trabajos programados estén al día.':'La señal registrada no acredita una actualización automática vigente.',
    count:null,amountMinor:null,responsibleName,action:{label:'Ver estado del proceso',automation:true}});
  if (severity) other=other.filter(task=>task.severity===severity);
  const total=count+other.length, pageSize=all?20:5;
  page=all?Math.min(page,Math.max(1,Math.ceil(total/pageSize))):1;
  const offset=(page-1)*pageSize, alertOffset=Math.max(0,offset-other.length);
  const rows=await tx.db.all(`SELECT a.*,r.type,p.name AS responsible_name,
    COALESCE(s.order_id,c.order_id,CASE WHEN a.entity_type='order' THEN a.entity_id END) AS target_order_id,
    o.number AS order_number,cl.account_id AS target_account_id
    FROM ${tx.t('alerts')} a JOIN ${tx.t('alert_rules')} r ON r.id=a.rule_id
    LEFT JOIN ${tx.t('people')} p ON p.id=a.responsible_id
    LEFT JOIN ${tx.t('shipments')} s ON a.entity_type='shipment' AND s.id=a.entity_id
    LEFT JOIN ${tx.t('order_collections')} c ON a.entity_type='collection' AND c.id=a.entity_id
    LEFT JOIN ${tx.t('cash_closings')} cl ON a.entity_type='cash_closing' AND cl.id=a.entity_id
    LEFT JOIN ${tx.t('orders')} o ON o.id=COALESCE(s.order_id,c.order_id,CASE WHEN a.entity_type='order' THEN a.entity_id END)
    WHERE ${where} ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,a.first_seen_at,a.id LIMIT ? OFFSET ?`,
    [...values,pageSize+other.length,alertOffset]);
  const records=[...rows.map(alertClientData),...other].sort(taskOrder).slice(offset-alertOffset,offset-alertOffset+pageSize);
  return {records,total,page,pageSize};
}

export function buildDashboard(store,input={},{now=stamp()}={}) {
  if (!input || typeof input!=='object' || Array.isArray(input)) fail('Consulta de inicio no válida.');
  now=instant(now);
  const query=normalizeReportQuery({period:input.period,anchorDate:input.anchorDate || input.anchor,asOf:now});
  const all=input.issue==='attention',severity=input.status || '';
  if (input.issue && !all) fail('Filtro de atención no válido.');
  if (severity && !Object.hasOwn(severityOrder,severity)) fail('Severidad no válida.');
  const page=integer(Number(input.page || 1),'Página',1,100000);
  return store.readSnapshot(async tx=>{
    const report=await buildBusinessReportTx(tx,query);
    const comparison=await dashboardComparisonTx(tx,report);
    const cash=await financeOverviewTx(tx,{asOf:bogotaDate(now)});
    const settings=await getBusinessSettings(tx);
    const responsible=settings.alertDefaults?.responsibleId ? await tx.db.get(`SELECT name FROM ${tx.t('people')} WHERE id=?`,[settings.alertDefaults.responsibleId]) : null;
    const automation=schedulerHealth(await tx.db.get(`SELECT state,updated_at,error_code FROM ${tx.t('job_runs')} WHERE key='scheduler:heartbeat'`),now);
    const counts=await tx.db.all(`SELECT kind,COUNT(*) AS total,SUM(CASE WHEN status='draft' THEN 1 ELSE 0 END) AS drafts FROM ${tx.t('records')} GROUP BY kind`);
    const byKind=new Map(counts.map(row=>[row.kind,row]));
    const pending=await tx.db.all(`SELECT kind,id,title FROM ${tx.t('records')} WHERE status='draft' ORDER BY created_at,id LIMIT 5`);
    const publicSettings=await tx.db.get(`SELECT data FROM ${tx.t('settings')} WHERE id=1`);
    const activity=await tx.db.get(`SELECT (SELECT COUNT(*) FROM ${tx.t('orders')})+(SELECT COUNT(*) FROM ${tx.t('shipments')})+(SELECT COUNT(*) FROM ${tx.t('expenses')})+(SELECT COUNT(*) FROM ${tx.t('cash_entries')} WHERE kind<>'opening') AS count`);
    const insights=buildInsights(report,comparison,{now,sourceFreshness:report.lastImportAt});
    const safeComparison={equivalent:comparison.equivalent,mode:comparison.mode,currentBounds:comparison.currentBounds,previousBounds:comparison.previousBounds,reason:comparison.reason};
    return {period:query.period,anchor:query.anchorDate,bounds:report.bounds,generatedAt:now,dataAsOf:report.dataAsOf,dataRevision:report.dataRevision,
      empty:Number(activity.count)===0,metrics:{netProductSales:report.metrics.netProductSales,operatingResult:report.metrics.operatingResult,onTimeDeliveries:report.metrics.onTimeDeliveries},
      cash:{asOf:cash.asOf,availableMinor:cash.availableMinor,accountsCount:cash.accounts.length},coverage:report.coverage,sourceFreshness:report.lastImportAt,
      comparison:safeComparison,insights,attention:await attentionTx(tx,report,automation,{page,all,severity:all?severity:'',responsibleName:responsible?.name || null}),automation,
      setup:{productCount:Number(byKind.get('products')?.total || 0),accountCount:cash.accounts.length,firstAccountId:settings.defaultReceiptAccountId || cash.accounts.find(a=>a.active)?.id || null},
      vitrina:{launchApproved:Boolean(publicSettings && JSON.parse(publicSettings.data).launchApproved),counts:Object.entries(schemas).map(([kind,schema])=>({kind,label:schema.label,total:Number(byKind.get(kind)?.total || 0),drafts:Number(byKind.get(kind)?.drafts || 0)})),pending}};
  });
}
