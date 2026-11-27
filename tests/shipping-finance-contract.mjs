import assert from 'node:assert/strict';
import { insertRow, stamp } from '../lib/business/commands.mjs';
import { accountBalance } from '../lib/business/cash.mjs';
import { recordCollection } from '../lib/business/collections.mjs';
import { recordExpense, payExpense } from '../lib/business/expenses.mjs';
import { confirmSettlement } from '../lib/business/settlements.mjs';
import { createShipment } from '../lib/business/shipments.mjs';
import { getShippingFinance } from '../lib/business/shipping-finance.mjs';
import { businessOrderInput, createBusinessFixture, requestId } from './business-fixtures.mjs';

export function linkSyntheticGuide(store,{guideId,carrier,tracking,orderId,shipmentId,localCarrier=carrier,actorId}) {
  return insertRow(store,'heka_api_order_links',{guide_id:guideId,guide_number:tracking,carrier,local_carrier:localCarrier,order_id:orderId,shipment_id:shipmentId,actor_id:actorId,provider_status:'delivered',linked_at:stamp()});
}

export async function runShippingFinanceContracts(t,factory) {
  await t.test('only exact verified guide links expose manual finance; opening does not post and existing actions post only on submit',async t=>{
    const store=await factory();t.after(()=>store.close());
    const f=await createBusinessFixture(store), {actorId,shipmentId,orderId,account,year}=f;
    const tracking='0000123456789', before=await accountBalance(store,account.id);
    await assert.rejects(getShippingFinance(store,shipmentId),{status:404});
    await linkSyntheticGuide(store,{guideId:'1'.repeat(24),carrier:'coordinadora',localCarrier:'Transportadora sintética',tracking,shipmentId,orderId,actorId});
    const unrelated=await recordExpense(store,{requestId:requestId(),category:'operating',amountMinor:5500,incurredOn:`${year}-09-02`,orderId,concept:'Sin vínculo a la guía'},actorId);
    const exact=await getShippingFinance(store,shipmentId);
    assert.equal(exact.order,null);
    assert.deepEqual(exact.expenses.map(row=>row.id).sort(),[f.shippingExpenseId,f.platformExpenseId].sort());
    assert.ok(!exact.expenses.some(row=>row.id===unrelated.id));
    const [settlement]=exact.settlements;
    assert.equal(settlement.id,f.settlement.id);
    assert.deepEqual(settlement.lines.map(line=>line.collectionId),[f.collectionId]);
    assert.equal(await accountBalance(store,account.id),before);
    await confirmSettlement(store,{requestId:requestId(),settlementId:settlement.id,version:settlement.version,receivedOn:`${year}-09-05`,accountId:account.id,externalKey:'GUIA-PROOF',lines:settlement.lines},actorId);
    assert.deepEqual((await getShippingFinance(store,shipmentId)).settlements,[]);
    assert.equal(await accountBalance(store,account.id),before+10500000);
    const order=await store.saveOrder(businessOrderInput(f.a,{year}),actorId);
    const other=await createShipment(store,{requestId:requestId(),orderId:order.id,carrier:'coordinadora',tracking:'GUIA-DIRECTA'},actorId);
    await linkSyntheticGuide(store,{guideId:'2'.repeat(24),carrier:other.carrier,tracking:other.tracking,shipmentId:other.id,orderId:order.id,actorId});
    const owing=await recordExpense(store,{requestId:requestId(),category:'shipping_out',amountMinor:100000,incurredOn:`${year}-09-02`,shipmentId:other.id,orderId:order.id,concept:'Flete directo'},actorId);
    const direct=await getShippingFinance(store,other.id);
    assert.equal(direct.order.id,order.id);
    assert.deepEqual(direct.expenses.map(expense=>expense.id),[owing.id]);
    assert.equal(await accountBalance(store,account.id),before+10500000);
    await recordCollection(store,{requestId:requestId(),orderId:direct.order.id,version:direct.order.version,shipmentId:other.id,holder:'business',amountMinor:500000,occurredOn:`${year}-09-06`,method:'Transferencia',reference:'TEST-DIRECTO',accountId:account.id},actorId);
    await payExpense(store,{requestId:requestId(),expenseId:owing.id,version:owing.version,amountMinor:100000,accountId:account.id,effectiveOn:`${year}-09-06`},actorId);
    assert.equal(await accountBalance(store,account.id),before+10900000);
    assert.deepEqual((await getShippingFinance(store,other.id)).expenses,[]);
  });
}
