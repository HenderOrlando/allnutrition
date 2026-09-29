import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../lib/db/index.mjs';
import { productData,orderData } from './contract.mjs';
import { importData } from '../lib/import.mjs';
test('SQLite conserva pedidos después de cerrar y reabrir el archivo',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'allnutrition-test-')),env={DB_DRIVER:'sqlite',SQLITE_PATH:join(dir,'test.sqlite')};let store;
 try{store=await openStore(env);const p=await store.save('products',productData());const o=await store.saveOrder(orderData(p),'operador');await store.close();store=await openStore(env);assert.equal((await store.order(o.id)).total,64000);assert.equal((await store.orders()).length,1);}finally{await store?.close();rmSync(dir,{recursive:true,force:true});}
});
test('respaldo e importación conservan productos, pedido e historial',async()=>{
 const a=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'}),b=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
 try{const p=await a.save('products',productData());const o=await a.saveOrder(orderData(p),'operador');await importData(b,await a.exportData());assert.equal((await b.order(o.id)).history.length,1);assert.equal((await b.order(o.id)).items[0].itemId,p.id);const next=await b.saveOrder(orderData(p),'operador-nuevo');assert.equal(next.number,2);}finally{await a.close();await b.close();}
});
