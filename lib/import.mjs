import { randomUUID } from 'node:crypto';
import { schemas } from './schema.mjs';
import { validateRecord, validateSettings, fail, integer, text } from './validation.mjs';
/** Importación deliberada a una base vacía; nunca mezcla ni sincroniza dos bases. */
export async function importData(store,bundle) {
 if(!bundle||bundle.format!=='allnutrition-export-v2')fail('Formato de respaldo no reconocido.');
 return store.transaction(async tx=>{
  await tx.lockWrites();
  if(Number((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('records')}`)).n)||Number((await tx.db.get(`SELECT COUNT(*) AS n FROM ${tx.t('orders')}`)).n))fail('El destino debe estar vacío: no se sobrescriben ni mezclan datos.');
  await tx.db.run(`UPDATE ${tx.t('settings')} SET data=?,version=version+1 WHERE id=1`,[JSON.stringify({...validateSettings(bundle.settings),launchApproved:false})]);
  let count=0;
  for(const kind of Object.keys(schemas)){
   if(!Array.isArray(bundle[kind]))fail(`Falta la colección ${kind}.`);
   for(const record of bundle[kind]){
    const clean=validateRecord(kind,record),id=text(record.id,'ID',100,true),stamp=text(record.createdAt,'Fecha',50,true);
    await tx.db.run(`INSERT INTO ${tx.t('records')}(id,kind,slug,title,status,sort_order,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,[id,kind,clean.slug,clean.title,clean.status,clean.sort,JSON.stringify(clean),integer(record.version,'Versión',1),stamp,text(record.updatedAt||stamp,'Fecha',50,true)]);count++;
   }
  }
  for(const kind of ['products','combos'])for(const record of await tx.list(kind))await tx.validateRelations(kind,record);
  if(!Array.isArray(bundle.orders))fail('Falta la colección de pedidos.');
  for(const order of bundle.orders){
   const {id,number,version,createdAt,updatedAt,history=[],...data}=order;
   text(id,'ID de pedido',100,true);integer(number,'Número de pedido',1);integer(version,'Versión',1);
   if(!Array.isArray(data.items)||!data.items.length)fail('Pedido sin referencias.');
   for(const line of data.items)if(!await tx.get(line.kind,line.itemId))fail('El respaldo contiene un pedido con una referencia inexistente.');
   await tx.db.run(`INSERT INTO ${tx.t('orders')}(id,number,data,version,created_at,updated_at) VALUES(?,?,?,?,?,?)`,[id,number,JSON.stringify(data),version,text(createdAt,'Fecha',50,true),text(updatedAt||createdAt,'Fecha',50,true)]);
   for(const event of history){const {actorId,createdAt:stamp,...rest}=event;await tx.db.run(`INSERT INTO ${tx.t('order_audit')}(id,order_id,actor_id,data,created_at) VALUES(?,?,?,?,?)`,[randomUUID(),id,text(actorId||'importado','Actor',100,true),JSON.stringify(rest),text(stamp,'Fecha del evento',50,true)]);}
  }
  await tx.db.run(`UPDATE ${tx.t('counters')} SET value=(SELECT COALESCE(MAX(number),0) FROM ${tx.t('orders')}) WHERE id='orders'`);
  return {records:count,orders:bundle.orders.length};
 });
}
