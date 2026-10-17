import { fail, integer } from '../validation-core.mjs';
import { bogotaDate } from './dates.mjs';
import { buildBusinessReportTx, reportDetails } from './reports.mjs';
import { completedComparisonReportTx } from './dashboard.mjs';
import { writeExcelSheets } from './excel.mjs';

const GROUPS = ['products','sellers','accounts','payroll','shipments','returns','costs'];
const FILTERS = ['seller','product','platform','carrier','status','account','source'];
const PAGE_SIZE = 20;
const XLSX_MAX_ROWS = 1048576;
const unitLabel = unit => ({minor:'COP',count:'Unidades',bps:'%',days:'Días calendario'}[unit] || unit);
function exportedValue(value,unit){
  if(value==null)return null;
  if(unit==='minor'){
    integer(value,'Importe exportado',Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
    // Excel has 15 significant decimal digits; larger aggregates must remain exact text.
    if(Math.abs(value)>=1000000000000000){
      const amount=BigInt(value),absolute=amount<0n?-amount:amount;
      return `${amount<0n?'-':''}${absolute/100n},${String(absolute%100n).padStart(2,'0')}`;
    }
    return value/100;
  }
  return unit==='bps'?value/100:value;
}

export function reportRequestQuery(params) {
  return {
    period:params.get('period') || 'month',
    anchorDate:params.get('anchor') || bogotaDate(),
    filters:Object.fromEntries(FILTERS.flatMap(key => params.get(key) ? [[key,params.get(key)]] : [])),
  };
}

export function liveReportClientData(store,query,{page=1,metric=null,issue=null}={}) {
  if(issue&&!metric)fail('Selecciona una métrica para este detalle.');
  return store.readSnapshot(async tx=>{
    const report=await buildBusinessReportTx(tx,query);
    const detailsReport=issue==='comparison_elapsed'?await completedComparisonReportTx(tx,report):null;
    return reportClientData(report,{page,metric,issue:detailsReport?null:issue,detailsReport});
  });
}

export function reportClientData(report, {page = 1, metric = null,issue=null,detailsReport=null} = {}) {
  page = integer(Number(page), 'Página', 1, 100000);
  const offset = (page - 1) * PAGE_SIZE;
  const groups = {};
  for (const key of GROUPS) {
    const rows = report.groups[key];
    if (!Array.isArray(rows)) throw new TypeError(`Grupo de informe no válido: ${key}`);
    groups[key] = {records:rows.slice(offset,offset + PAGE_SIZE),total:rows.length,page,pageSize:PAGE_SIZE};
  }
  const result = {
    query:report.query,bounds:report.bounds,closed:report.closed,empty:report.empty,
    generatedAt:report.generatedAt,dataAsOf:report.dataAsOf,dataRevision:report.dataRevision,
    queryKey:report.queryKey,factHash:report.factHash,lastImportAt:report.lastImportAt,
    metrics:report.metrics,groups,coverage:report.coverage,definitions:report.definitions,
    filterOptions:report.filterOptions,
  };
  if (report.snapshot) {
    const {id,revision,state,staleSince,generatedAt,dataRevision,queryKey,factHash} = report.snapshot;
    result.snapshot = {id,revision,state,staleSince,generatedAt,dataRevision,queryKey,factHash};
  }
  if (metric) {
    result.details = reportDetails(detailsReport||report,{metric,issue,page,pageSize:PAGE_SIZE});
    if(detailsReport) {
      result.details.metricSummary={...detailsReport.metrics[metric],label:detailsReport.metrics[metric].label+' · días completos'};
      result.details.bounds=detailsReport.bounds;
    }
  }
  return result;
}

function explanation(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(explanation).filter(Boolean).join('; ');
  if (value.label || value.message) return `${value.label || value.message}${value.count == null ? '' : ` (${value.count})`}`;
  return Object.entries(value).map(([key,item]) => `${key}: ${explanation(item)}`).join('; ');
}

export function exportBusinessReport(report) {
  const summary = [['Métrica','Valor','Unidad','Completo','Subtotal conocido','Elegibles','Con dato','Excluidos','Motivos']];
  for (const metric of Object.values(report.metrics)) {
    summary.push([metric.label,exportedValue(metric.value,metric.unit),unitLabel(metric.unit),metric.complete ? 'Sí' : 'No',exportedValue(metric.knownValue,metric.unit),metric.eligibleCount,metric.knownCount,metric.excludedCount,explanation(metric.exclusionReasons)]);
  }
  const details = [['Métrica','Registro','Tipo','Identificador','Pedido','Producto histórico','Guía','Fecha del hecho','Cantidad','Precio unitario COP','Descuento de línea COP','Costo unitario COP','Valor','Unidad','Estado del dato','Motivo','Versión de regla','Fuente']];
  const rows = reportDetails(report,{page:1,pageSize:null}).records;
  if (rows.length + 1 > XLSX_MAX_ROWS) fail('El detalle supera el máximo de filas de Excel. Elige un período más corto o más filtros.',413);
  for (const row of rows) {
    const metric = row.metric || row.metricId;
    details.push([report.metrics[metric]?.label || metric || '',row.label,row.entityType,row.entityId,row.orderNumber == null ? '' : `AN-${row.orderNumber}`,row.productLabel || '',row.tracking || '',row.occurredOn,row.quantity ?? null,exportedValue(row.unitPriceMinor,'minor'),exportedValue(row.discountMinor,'minor'),exportedValue(row.unitCostMinor,'minor'),exportedValue(row.value,row.unit),unitLabel(row.unit),row.known ? 'Con dato' : 'Pendiente',row.reason || '',row.ruleVersionId || '',row.source || '']);
  }
  const definitions = [
    ['Clave','Concepto','Fórmula o valor','Criterio','Unidad'],
    ['currency','Moneda','COP','Importes en pesos colombianos con centavos','COP'],
    ['moneyPrecision','Precisión de importes','Centavos enteros exactos','Agregados con 16 o más dígitos en centavos se guardan como texto decimal COP; Excel no conserva esa precisión como número.','COP'],
    ['timeZone','Zona de negocio','America/Bogota','Fechas de negocio sin hora inventada',''],
    ['period','Período',report.query.period,`${report.bounds.startDate} ≤ fecha < ${report.bounds.endDateExclusive}`,''],
    ['generatedAt','Generado',report.generatedAt,'Instante UTC',''],
    ['dataAsOf','Datos al corte',report.dataAsOf,'El corte no sustituye fechas de hechos desconocidas',''],
    ['dataRevision','Revisión de datos',report.dataRevision,'Revisión consistente capturada al calcular',''],
    ['coverage','Cobertura',explanation(report.coverage),'Sin dato no significa cero',''],
  ];
  if (report.snapshot) definitions.push(['snapshot','Informe guardado',report.snapshot.id,`Revisión ${report.snapshot.revision} · ${report.snapshot.state}`,'']);
  for (const definition of report.definitions || []) definitions.push([definition.key,definition.label,explanation(definition.formula),explanation(definition.criteria),unitLabel(definition.unit)]);
  for (const source of report.lastImportAt || []) {
    const cut = source.sourceAsOf && source.precision !== 'instant' ? source.sourceDate || bogotaDate(source.sourceAsOf) : source.sourceAsOf;
    definitions.push([`source:${source.sourceId}`,`${source.platformName} · ${source.sourceName}`,cut,`Corte de fuente${source.precision !== 'instant' ? ' sin hora confirmada' : ''}; importado: ${source.importedAt || 'Sin dato'}`,'']);
  }
  return writeExcelSheets([{name:'Resumen',rows:summary},{name:'Detalle',rows:details},{name:'Definiciones',rows:definitions}]);
}
