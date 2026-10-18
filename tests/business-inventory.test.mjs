import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../lib/db/index.mjs';
import { businessInventoryContracts } from './business-inventory-contract.mjs';
import { inventoryState } from '../lib/business/inventory.mjs';

export { businessInventoryContracts };
for(const [name,execute] of businessInventoryContracts) {
  test(name,async t=>{
    const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
    t.after(()=>store.close());
    await execute(store);
  });
}

for (const [condition,consumed] of [['non_recoverable',2],['recoverable',1]]) {
  test(`devoluciones simultáneas preservan la salida ya asignada a la devolución ${condition}`,()=>{
    const order={status:'new',items:[{lineId:'line',itemId:'product',quantity:2}],inventory:{returns:[{returnId:'z-existing',lineId:'line',issuedQuantity:1}]}};
    const shipments=[{id:'shipment',status:'collected',assignments:[{lineId:'line',quantity:1}]}];
    const recordedAt='2026-09-03T12:00:00.000Z';
    const returns=[
      {id:'z-existing',recordedAt,lines:[{lineId:'line',quantity:1,condition}]},
      {id:'a-new',recordedAt,lines:[{lineId:'line',quantity:1,condition:'non_recoverable'}]}
    ];
    const state=inventoryState(order,shipments,new Map(),returns);
    assert.deepEqual(state.products,[{productId:'product',reserved:0,consumed}]);
    assert.deepEqual(state.returns,[
      {returnId:'a-new',lineId:'line',issuedQuantity:0},
      {returnId:'z-existing',lineId:'line',issuedQuantity:1}
    ]);
  });
}

test('conservar asignaciones de devolución no permite eliminar su evidencia de despacho',()=>{
  const order={status:'new',items:[{lineId:'line',itemId:'product',quantity:1}],inventory:{returns:[{returnId:'returned',lineId:'line',issuedQuantity:1}]}};
  const shipments=[{id:'shipment',status:'label_created',assignments:[{lineId:'line',quantity:1}]}];
  const returns=[{id:'returned',recordedAt:'2026-09-03T12:00:00.000Z',lines:[{lineId:'line',quantity:1,condition:'non_recoverable'}]}];
  assert.throws(()=>inventoryState(order,shipments,new Map(),returns),{status:409});
});
