import { fail, text } from '../validation-core.mjs';
import { entity } from './commands.mjs';
import { expenseBalanceTx } from './expenses.mjs';
import { getOrder } from './orders.mjs';
import { getSettlement } from './settlements.mjs';

// Only authoritative local links grant this shortcut. Provider status, amounts,
// customer names and carrier tracking searches are never finance evidence.
export function getShippingFinance(store,shipmentId) {
  shipmentId=text(shipmentId,'Envío',100,true);
  return store.readSnapshot(async tx=>{
    const shipment=await tx.db.get(`SELECT s.id,s.order_id,s.source_id,s.tracking FROM ${tx.t('shipments')} s
      JOIN ${tx.t('heka_api_order_links')} l ON l.shipment_id=s.id AND l.order_id=s.order_id AND l.guide_number=s.tracking AND l.local_carrier=s.carrier
      WHERE s.id=?`,[shipmentId]);
    if(!shipment)fail('La guía no tiene un vínculo local verificable.',404);
    const order=await getOrder(tx,shipment.order_id,{history:false});
    const direct=order && order.status!=='cancelled' && !order.paymentSummary.legacyReview && order.paymentSummary.outstandingMinor>0
      ? {id:order.id,version:order.version,number:order.number,paymentSummary:order.paymentSummary} : null;
    const expenseRows=await tx.db.all(`SELECT * FROM ${tx.t('expenses')} WHERE shipment_id=? AND (order_id=? OR order_id IS NULL) ORDER BY created_at,id`,[shipmentId,shipment.order_id]);
    const expenses=[];
    for(const row of expenseRows){
      const {id,version,concept,category,orderId,shipmentId}=entity(row), balance=await expenseBalanceTx(tx,id);
      if(balance.outstandingMinor>0)expenses.push({id,version,concept,category,orderId,shipmentId,outstandingMinor:balance.outstandingMinor});
    }
    const settlements=[];
    if(shipment.source_id){
      const lines=tx.provider==='sqlite' ? "json_each(s.data,'$.lines')" : "jsonb_array_elements(s.data::jsonb->'lines')";
      const collectionId=tx.provider==='sqlite' ? "json_extract(l.value,'$.collectionId')" : "l.value->>'collectionId'";
      const candidates=await tx.db.all(`SELECT s.id FROM ${tx.t('settlements')} s WHERE s.source_id=? AND s.state IN ('pending','partial')
        AND EXISTS (SELECT 1 FROM ${lines} l JOIN ${tx.t('order_collections')} c ON c.id=(${collectionId}) WHERE c.shipment_id=? AND c.order_id=? AND c.holder='platform')
        ORDER BY s.reported_on DESC,s.id`,[shipment.source_id,shipmentId,shipment.order_id]);
      if(candidates.length){
        const receipts=await tx.db.all(`SELECT c.id FROM ${tx.t('order_collections')} c WHERE c.shipment_id=? AND c.order_id=? AND c.holder='platform' AND c.kind='receipt'
          AND NOT EXISTS (SELECT 1 FROM ${tx.t('order_collections')} r WHERE r.reversal_of=c.id)`,[shipmentId,shipment.order_id]);
        const collectionIds=new Set(receipts.map(row=>row.id)), expenseIds=new Set(expenseRows.map(row=>row.id));
        for(const {id} of candidates){
          const doc=await getSettlement(tx,id);
          if(doc.reconciliationRequired)continue;
          const remainingLines=doc.remainingLines.filter(line=>collectionIds.has(line.collectionId)&&line.deductions.every(deduction=>expenseIds.has(deduction.expenseId)));
          if(remainingLines.length)settlements.push({id,version:doc.version,sourceId:doc.sourceId,label:doc.externalId||doc.reportedOn,reportedOn:doc.reportedOn,netMinor:doc.netMinor,lines:remainingLines});
        }
      }
    }
    return {shipment:{id:shipmentId,tracking:shipment.tracking},order:direct,expenses,settlements};
  });
}
