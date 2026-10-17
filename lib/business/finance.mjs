import { fail, text, integer } from '../validation-core.mjs';
import { businessDate, bogotaDate } from './dates.mjs';
import { moneyMinor } from './money.mjs';
import { runCommand, entity, audit } from './commands.mjs';
import { reverseCollectionTx } from './collections.mjs';
import { reverseExpensePaymentTx } from './expenses.mjs';
import { reverseSettlementReceiptTx, reverseSettlementTx, getSettlement } from './settlements.mjs';
import { reversePayrollPaymentTx, reverseAdvanceTx, getPayroll } from './payroll.mjs';
import { linkShipmentTx } from './shipments.mjs';
export { saveAccount, recordIncome, recordAdvance, transferMoney, closeCash, reopenCash, reverseCashEntry, accountBalance } from './cash.mjs';
export { recordCollection, recordRefund, registerReturn, resolveLegacyPayment } from './collections.mjs';
export { recordExpense, payExpense, recordExpenseRecovery } from './expenses.mjs';
export { saveSettlement, confirmSettlement } from './settlements.mjs';
export { preparePayroll, confirmPayroll, payPayroll } from './payroll.mjs';
export { completeOrderCosts } from './catalog.mjs';

export async function reverseFinancialDocument(store,input,actorId) {
  const type=text(input.documentType,'Tipo de documento',40,true),id=text(input.documentId,'Documento',100,true);
  const effectiveOn=businessDate(input.effectiveOn),reason=text(input.reason,'Motivo',2000,true);
  integer(input.version,'Versión',1);
  const allowed=['collection','refund','settlement','settlement_receipt','expense_payment','payroll_payment','advance'];
  if(!allowed.includes(type))fail('Tipo de documento no válido.');
  return runCommand(store,{scope:'financial:reverse',requestId:input.requestId,payload:input,actorId},async tx=>{
    const options={effectiveOn,reason,actorId,version:input.version};
    let result;
    if(type==='collection'||type==='refund') {
      const original=await tx.db.get(`SELECT kind FROM ${tx.t('order_collections')} WHERE id=?`,[id]);
      if(!original)fail('Documento no encontrado.',404);
      if(original.kind!==(type==='refund'?'refund':'receipt'))fail('El tipo no coincide con el documento.');
      result=await reverseCollectionTx(tx,id,options);
    } else if(type==='settlement')result=await reverseSettlementTx(tx,id,options);
    else if(type==='settlement_receipt')result=await reverseSettlementReceiptTx(tx,id,options);
    else if(type==='expense_payment')result=await reverseExpensePaymentTx(tx,id,options);
    else if(type==='payroll_payment')result=await reversePayrollPaymentTx(tx,id,options);
    else result=await reverseAdvanceTx(tx,id,options);
    await audit(tx,{entityType:'financial_reversal',entityId:id,actorId,previous:{documentType:type,documentId:id},next:result,reason});
    return result;
  });
}
export async function linkShipment(store,input,actorId) {
  return runCommand(store,{scope:'shipment:link',requestId:input.requestId,payload:input,actorId},tx=>linkShipmentTx(tx,input,actorId));
}

function signedCollection(row,byId) {
  if(row.kind==='receipt')return row.amountMinor;
  if(row.kind==='refund')return -row.amountMinor;
  const original=byId.get(row.reversalOf);
  return original?.kind==='refund'?row.amountMinor:-row.amountMinor;
}
const active=rows=>{const reversed=new Set(rows.filter(r=>r.reversalOf).map(r=>r.reversalOf));return rows.filter(r=>!r.reversalOf&&!reversed.has(r.id));};
const safeMinorTotal=(value,label)=>integer(Number(value),label,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER);
async function expenseBalances(tx,rows) {
  if(!rows.length)return [];
  const ids=rows.map(r=>r.id),marks=ids.map(()=>'?').join(',');
  const payments=await tx.db.all(`SELECT expense_id,SUM(amount_minor) AS paid FROM ${tx.t('expense_payments')} WHERE expense_id IN (${marks}) GROUP BY expense_id`,ids);
  const byId=new Map(payments.map(r=>[r.expense_id,Number(r.paid)]));
  const offsets=active((await tx.db.all(`SELECT * FROM ${tx.t('payroll_offsets')} WHERE debit_expense_id IN (${marks}) OR credit_expense_id IN (${marks})`,[...ids,...ids])).map(entity));
  const offsetById=new Map();
  for(const offset of offsets){offsetById.set(offset.debitExpenseId,(offsetById.get(offset.debitExpenseId)||0)+offset.amountMinor);offsetById.set(offset.creditExpenseId,(offsetById.get(offset.creditExpenseId)||0)+offset.amountMinor);}
  return rows.map(raw=>{
    const row=entity(raw),paidMinor=byId.get(row.id)||0,offsetMinor=offsetById.get(row.id)||0;
    const balance=row.amountMinor>=0?row.amountMinor-paidMinor-offsetMinor:row.amountMinor-paidMinor+offsetMinor;
    return {...row,paidMinor,offsetMinor,outstandingMinor:Math.max(0,balance),creditMinor:Math.max(0,-balance)};
  });
}
export function financeOverview(store, options = {}) {
  return store.readSnapshot(tx=>financeOverviewTx(tx,options));
}
export async function financeOverviewTx(tx,{asOf=bogotaDate()}={}) {
  const on=businessDate(asOf);
    const accounts=(await tx.db.all(`SELECT a.*,p.name AS responsible_name FROM ${tx.t('cash_accounts')} a JOIN ${tx.t('people')} p ON p.id=a.responsible_id ORDER BY a.active DESC,a.name,a.id`)).map(entity);
    const balances=await tx.db.all(`SELECT account_id,SUM(amount_minor) AS balance FROM ${tx.t('cash_entries')} WHERE effective_on<=? GROUP BY account_id`,[on]);
    const byAccount=new Map(balances.map(r=>[r.account_id,safeMinorTotal(r.balance,'Saldo de cuenta')]));
    const collections=(await tx.db.all(`SELECT * FROM ${tx.t('order_collections')} WHERE occurred_on<=? OR occurred_on IS NULL`,[on])).map(entity),byCollection=new Map(collections.map(c=>[c.id,c]));
    const platformCollections=collections.reduce((sum,c)=>c.holder==='platform'?sum+BigInt(signedCollection(c,byCollection)):sum,0n);
    const receipts=active((await tx.db.all(`SELECT * FROM ${tx.t('settlement_receipts')} WHERE received_on<=?`,[on])).map(entity));
    const settledGross=receipts.reduce((sum,r)=>sum+(r.lines||[]).reduce((s,l)=>s+BigInt(l.grossMinor),0n),0n);
    const expenses=await expenseBalances(tx,await tx.db.all(`SELECT * FROM ${tx.t('expenses')}`));
    const availableMinor=safeMinorTotal(accounts.reduce((sum,a)=>sum+BigInt(byAccount.get(a.id)||0),0n),'Disponible consolidado');
    const pending=platformCollections-settledGross;
    let expenseOutstanding=0n,expenseCredits=0n,payrollOutstanding=0n,unassignedDateExpenses=0;
    for(const expense of expenses){
      expenseOutstanding+=BigInt(expense.outstandingMinor);expenseCredits+=BigInt(expense.creditMinor);
      if(['salary','bonus','commission'].includes(expense.category))payrollOutstanding+=BigInt(expense.outstandingMinor);
      if(!expense.incurredOn)unassignedDateExpenses++;
    }
    return {asOf:on,accounts:accounts.map(a=>({...a,balanceMinor:byAccount.get(a.id)||0})),availableMinor,
      platformPendingMinor:safeMinorTotal(pending>0n?pending:0n,'Por recibir de plataforma'),
      expensesOutstandingMinor:safeMinorTotal(expenseOutstanding,'Gastos pendientes'),
      expenseCreditsMinor:safeMinorTotal(expenseCredits,'Créditos por recuperar'),
      payrollOutstandingMinor:safeMinorTotal(payrollOutstanding,'Sueldos pendientes'),unassignedDateExpenses};
}
const jsonField=(tx,alias,key)=>tx.provider==='sqlite'?`json_extract(${alias}.data,'$.${key}')`:`(${alias}.data::jsonb->>'${key}')`;
async function settlementCandidates(tx,filters,page,q){
  const type=filters.candidates;
  if(!['collections','expenses'].includes(type))fail('Tipo de candidato no válido.');
  const source=text(filters.source,'Cuenta de plataforma',100,true),values=[source],where=[];
  const collection=type==='collections',alias=collection?'c':'e';
  const sourceExpr=collection?`COALESCE(${jsonField(tx,'c','sourceId')},s.source_id)`:`COALESCE(${jsonField(tx,'e','sourceId')},s.source_id)`;
  where.push(collection||!filters.collection?`${sourceExpr}=?`:`(${sourceExpr}=? OR (${sourceExpr} IS NULL AND e.order_id IS NOT NULL))`);
  if(collection)where.push(`c.kind='receipt' AND c.holder='platform' AND c.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ${tx.t('order_collections')} r WHERE r.reversal_of=c.id)`);
  else where.push(`e.category NOT IN ('salary','bonus','commission') AND e.amount_minor>=0`);
  if(filters.record){where.push(`${alias}.id=?`);values.push(text(filters.record,'Registro',100,true));}
  if(filters.collection){
    const c=entity(await tx.db.get(`SELECT c.*,COALESCE(${jsonField(tx,'c','sourceId')},s.source_id) AS resolved_source_id FROM ${tx.t('order_collections')} c LEFT JOIN ${tx.t('shipments')} s ON s.id=c.shipment_id WHERE c.id=? AND c.kind='receipt' AND c.holder='platform' AND c.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ${tx.t('order_collections')} r WHERE r.reversal_of=c.id)`,[text(filters.collection,'Cobro',100,true)]));
    if(!c||c.resolvedSourceId!==source)fail('Cobro vigente de esta cuenta no encontrado.',404);
    if(!collection){where.push('(e.order_id IS NULL OR e.order_id=?)');values.push(c.orderId);}
  }
  if(q){where.push(`(LOWER(COALESCE(s.tracking,'')) LIKE ? ESCAPE '!' OR CAST(o.number AS TEXT) LIKE ? ESCAPE '!' OR LOWER(${alias}.data) LIKE ? ESCAPE '!')`);const term='%'+q.toLowerCase().replace(/[!%_]/g,c=>'!'+c)+'%';values.push(term,term,term);}
  const from=`FROM ${tx.t(collection?'order_collections':'expenses')} ${alias} LEFT JOIN ${tx.t('shipments')} s ON s.id=${alias}.shipment_id LEFT JOIN ${tx.t('orders')} o ON o.id=${alias}.order_id`;
  const base=`SELECT ${alias}.*,o.number AS order_number,s.tracking,${sourceExpr} AS candidate_source_id ${from} WHERE ${where.join(' AND ')}`;
  // Availability is computed in SQL before pagination, not by filtering a page in the browser.
  const receiptLines=tx.provider==='sqlite'?`json_each(r.data,'$.lines') l`:`jsonb_array_elements(r.data::jsonb->'lines') l`;
  const lineId=tx.provider==='sqlite'?`json_extract(l.value,'$.collectionId')`:`l->>'collectionId'`;
  const lineGross=tx.provider==='sqlite'?`json_extract(l.value,'$.grossMinor')`:`(l->>'grossMinor')::bigint`;
  const availability=collection?`f.amount_minor-COALESCE((SELECT SUM(${lineGross}) FROM ${tx.t('settlement_receipts')} r CROSS JOIN ${receiptLines} WHERE ${lineId}=f.id AND r.reversal_of IS NULL AND NOT EXISTS(SELECT 1 FROM ${tx.t('settlement_receipts')} x WHERE x.reversal_of=r.id)),0)`:`f.amount_minor-COALESCE((SELECT SUM(p.amount_minor) FROM ${tx.t('expense_payments')} p WHERE p.expense_id=f.id),0)`;
  const cte=`WITH facts AS (${base}), balances AS (SELECT f.*,${availability} AS available_minor FROM facts f)`;
  const eligible=filters.record?'':collection?' WHERE available_minor>0':' WHERE available_minor<>0';
  const total=Number((await tx.db.get(`${cte} SELECT COUNT(*) AS count FROM balances${eligible}`,values)).count);
  const rows=await tx.db.all(`${cte} SELECT * FROM balances${eligible} ORDER BY id LIMIT 20 OFFSET ?`,[...values,(page-1)*20]);
  return {records:rows.map(raw=>{const r=entity(raw),available=moneyMinor(Number(r.availableMinor),'Saldo disponible',{signed:true});return {id:r.id,orderId:r.orderId,orderNumber:r.orderNumber,shipmentId:r.shipmentId,tracking:r.tracking,date:r.occurredOn||r.incurredOn||null,amountMinor:r.amountMinor,sourceId:r.candidateSourceId,category:r.category,concept:r.concept,...(collection?{availableGrossMinor:available}:{availableMinor:available})};}),total,page,pageSize:20};
}
export async function financeQuery(store,resource,filters={}) {
  if(resource==='overview')return financeOverview(store);
  if(!['movements','settlements','expenses','payroll','closings'].includes(resource))fail('Recurso de caja no encontrado.',404);
  const page=integer(Number(filters.page||1),'Página',1,100000),q=text(filters.q,'Búsqueda',100);
  const tables={movements:'cash_entries',settlements:'settlements',expenses:'expenses',payroll:'payroll_periods',closings:'cash_closings'};
  const table=tables[resource];
  return store.readSnapshot(async tx=>{
    if(resource==='settlements'&&filters.candidates)return settlementCandidates(tx,filters,page,q);
    if(filters.record){
      const id=text(filters.record,'Registro',100,true);
      const result=resource==='settlements'?await getSettlement(tx,id):resource==='payroll'?await getPayroll(tx,id):await tx.db.get(`SELECT * FROM ${tx.t(table)} WHERE id=?`,[id]);
      if(!result)fail('Registro no encontrado.',404);
      if(resource==='settlements'){
        const ids=result.lines.map(l=>l.collectionId),expenseIds=[...new Set(result.lines.flatMap(l=>l.deductions.map(d=>d.expenseId)))];
        const collections=ids.length?await tx.db.all(`SELECT c.id,o.number AS order_number,s.tracking,c.occurred_on FROM ${tx.t('order_collections')} c JOIN ${tx.t('orders')} o ON o.id=c.order_id LEFT JOIN ${tx.t('shipments')} s ON s.id=c.shipment_id WHERE c.id IN (${ids.map(()=>'?').join(',')})`,ids):[];
        const expenses=expenseIds.length?(await tx.db.all(`SELECT id,category,incurred_on,data FROM ${tx.t('expenses')} WHERE id IN (${expenseIds.map(()=>'?').join(',')})`,expenseIds)).map(entity):[];
        const labels=new Map(collections.map(c=>[c.id,`AN-${c.order_number} · ${c.tracking||'Sin guía'} · ${c.occurred_on||'Fecha desconocida'}`])),expenseLabels=new Map(expenses.map(e=>[e.id,`${e.concept||e.category} · ${e.incurredOn||'Fecha desconocida'}`]));
        result.lines=result.lines.map(l=>({...l,label:labels.get(l.collectionId),deductions:l.deductions.map(d=>({...d,label:expenseLabels.get(d.expenseId)}))}));
        return result;
      }
      if(resource==='expenses'){
        const row=(await expenseBalances(tx,[result]))[0];
        const payments=(await tx.db.all(`SELECT * FROM ${tx.t('expense_payments')} WHERE expense_id=? ORDER BY recorded_at,id`,[id])).map(entity);
        return {...row,payments,activePayments:active(payments)};
      }
      if(resource==='movements'){
        const row=entity(result),reversal=await tx.db.get(`SELECT id FROM ${tx.t('cash_entries')} WHERE reversal_of=?`,[id]);
        const document=await tx.db.get(`SELECT id,kind FROM ${tx.t('order_collections')} WHERE cash_entry_id=?`,[id]);
        const receipt=await tx.db.get(`SELECT id FROM ${tx.t('settlement_receipts')} WHERE cash_entry_id=?`,[id]);
        const payment=await tx.db.get(`SELECT id,data FROM ${tx.t('expense_payments')} WHERE cash_entry_id=?`,[id]);
        const type=document?(document.kind==='refund'?'refund':'collection'):receipt?'settlement_receipt':row.sourceType==='payroll_payment'?'payroll_payment':row.kind==='advance'?'advance':payment?'expense_payment':null;
        return {...row,reversed:Boolean(reversal),documentType:type,documentId:document?.id||receipt?.id||(type==='payroll_payment'?row.sourceId:type==='advance'?row.id:payment?.id),documentVersion:1};
      }
      return ['settlements','payroll'].includes(resource)?result:entity(result);
    }
    const where=[],values=[];
    for(const [filter,column,allowed] of [['account','account_id',['movements','closings']],['person','person_id',['expenses','payroll']],['source','source_id',['settlements']],['status','state',['settlements','payroll','closings']],['category','category',['expenses']]])if(filters[filter]&&allowed.includes(resource)){where.push(`${column}=?`);values.push(text(filters[filter],filter,100,true));}
    if(filters.startDate||filters.endDateExclusive){const column={movements:'effective_on',settlements:'reported_on',expenses:'incurred_on',payroll:'start_on',closings:'closing_on'}[resource];if(filters.startDate){where.push(`${column}>=?`);values.push(businessDate(filters.startDate));}if(filters.endDateExclusive){where.push(`${column}<?`);values.push(businessDate(filters.endDateExclusive));}}
    if(q){const escaped='%'+q.toLowerCase().replace(/[!%_]/g,c=>'!'+c)+'%';where.push(`(LOWER(id) LIKE ? ESCAPE '!' OR LOWER(data) LIKE ? ESCAPE '!')`);values.push(escaped,escaped);}
    const clause=where.length?' WHERE '+where.join(' AND '):'';
    const total=Number((await tx.db.get(`SELECT COUNT(*) AS count FROM ${tx.t(table)}${clause}`,values)).count);
    const dateColumn={movements:'effective_on',settlements:'reported_on',expenses:'incurred_on',payroll:'start_on',closings:'closing_on'}[resource];
    const raw=await tx.db.all(`SELECT * FROM ${tx.t(table)}${clause} ORDER BY ${dateColumn} DESC,id DESC LIMIT 20 OFFSET ?`,[...values,(page-1)*20]);
    const records=resource==='expenses'?await expenseBalances(tx,raw):raw.map(entity);
    if(records.length){
      const accounts=new Map((await tx.db.all(`SELECT id,name FROM ${tx.t('cash_accounts')}`)).map(r=>[r.id,r.name]));
      const people=new Map((await tx.db.all(`SELECT id,name FROM ${tx.t('people')}`)).map(r=>[r.id,r.name]));
      const sources=new Map((await tx.db.all(`SELECT s.id,s.name,p.name AS platform_name FROM ${tx.t('platform_sources')} s JOIN ${tx.t('platforms')} p ON p.id=s.platform_id`)).map(r=>[r.id,`${r.platform_name} · ${r.name}`]));
      for(const row of records){row.accountName=accounts.get(row.accountId);row.personName=people.get(row.personId);row.sourceName=sources.get(row.sourceId);}
    }
    if(resource==='settlements'&&records.length){const ids=records.map(r=>r.id),receipts=(await tx.db.all(`SELECT * FROM ${tx.t('settlement_receipts')} WHERE settlement_id IN (${ids.map(()=>'?').join(',')}) ORDER BY received_on,id`,ids)).map(entity);for(const row of records){row.receipts=receipts.filter(r=>r.settlementId===row.id);row.receivedNetMinor=active(row.receipts).reduce((s,r)=>s+r.netMinor,0);row.outstandingNetMinor=row.netMinor-row.receivedNetMinor;}}
    return {records,total,page,pageSize:20};
  });
}
