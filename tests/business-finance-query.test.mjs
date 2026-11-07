import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../lib/db/index.mjs';
import {createBusinessFixture,settleBusinessFixture,requestId} from './business-fixtures.mjs';
import {financeQuery,reverseFinancialDocument} from '../lib/business/finance.mjs';
import {recordExpense} from '../lib/business/expenses.mjs';
import {saveResource} from '../lib/business/settings.mjs';
import {saveAccount,recordIncome,closeCash} from '../lib/business/cash.mjs';
import {bogotaDate,addDays} from '../lib/business/dates.mjs';

async function closingFixture(fn) {
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  const actor='closing-preview-admin',today=bogotaDate(),openingOn=addDays(today,-3);
  try {
    const person=await saveResource(store,'people',{name:'Responsable de cierre',requestId:requestId()},actor);
    const account=(overrides={})=>saveAccount(store,{name:'Caja de cierre',type:'cash',responsibleId:person.id,openingOn,openingBalanceMinor:10000000,requestId:requestId(),...overrides},actor);
    const cash=await account();
    const preview=(overrides={})=>financeQuery(store,'closings',{preview:'1',account:cash.id,closingOn:addDays(today,-2),...overrides});
    await fn({store,actor,today,openingOn,person,account,cash,preview});
  } finally {await store.close();}
}

async function closingState(store) {
  const state={};
  for(const table of ['cash_entries','cash_closings','business_audit','counters']){
    state[table]=await store.db.all(`SELECT * FROM ${store.t(table)} ORDER BY id`);
  }
  state.business_requests=await store.db.all(`SELECT * FROM ${store.t('business_requests')} ORDER BY scope,request_id`);
  return state;
}

test('Finance selectors expose real scoped gross and signed credits, excluding reversed facts',async()=>{
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {
    const f=await createBusinessFixture(store,{year:2025});
    const query=(candidates,extra={})=>financeQuery(store,'settlements',{candidates,source:f.source.id,...extra});
    const initial=await query('collections',{q:'0000123456789'});
    assert.equal(initial.pageSize,20);assert.equal(initial.total,1);
    assert.equal(initial.records[0].id,f.collectionId);assert.equal(initial.records[0].availableGrossMinor,12200000);
    assert.equal(initial.records[0].date,'2025-09-03');
    assert.equal(Object.hasOwn(initial.records[0],'phone'),false);
    const expenses=await query('expenses',{collection:f.collectionId});
    assert.equal(expenses.total,2);
    await settleBusinessFixture(store,f);
    assert.equal((await query('collections')).total,0);
    const expense=await financeQuery(store,'expenses',{record:f.shippingExpenseId});
    await recordExpense(store,{requestId:requestId(),expenseId:expense.id,version:expense.version,amountMinor:1000000,reason:'Corrección documentada de costo'},f.actorId);
    const credit=await query('expenses',{collection:f.collectionId});
    assert.equal(credit.total,1);assert.equal(credit.records[0].id,f.shippingExpenseId);assert.equal(credit.records[0].availableMinor,-500000);
    await reverseFinancialDocument(store,{requestId:requestId(),documentType:'settlement_receipt',documentId:f.receipt.id,version:1,effectiveOn:'2025-09-10',reason:'Recibo registrado por error'},f.actorId);
    assert.equal((await query('collections')).records[0].availableGrossMinor,12200000);
    await reverseFinancialDocument(store,{requestId:requestId(),documentType:'collection',documentId:f.collectionId,version:1,effectiveOn:'2025-09-10',reason:'Recaudo registrado por error'},f.actorId);
    assert.equal((await query('collections')).total,0);
    await assert.rejects(()=>query('arbitrary'),{status:400});
  } finally {await store.close();}
});

test('Finance detail identifies linked reversal document instead of allowing isolated bank reversal',async()=>{
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try {
    const f=await createBusinessFixture(store,{year:2025,settle:true});
    const entry=await financeQuery(store,'movements',{record:f.receipt.cashEntryId});
    assert.equal(entry.documentType,'settlement_receipt');assert.equal(entry.documentId,f.receipt.id);assert.equal(entry.documentVersion,1);
    const detail=await financeQuery(store,'settlements',{record:f.settlement.id});
    assert.match(detail.lines[0].label,/AN-/);assert.match(detail.lines[0].label,/0000123456789/);
    assert.equal(detail.remainingNetMinor,0);
  } finally {await store.close();}
});

test('Closing preview uses the selected account and inclusive historical date without writing any financial state',()=>closingFixture(async({store,actor,today,openingOn,account,cash,preview})=>{
  for(const [effectiveOn,amountMinor] of [[addDays(today,-2),1000000],[addDays(today,-1),2000000]]){
    await recordIncome(store,{accountId:cash.id,effectiveOn,amountMinor,concept:'owner_funding',requestId:requestId()},actor);
  }
  const second=await account({name:'Segunda caja',openingBalanceMinor:700000});
  const before=await closingState(store);
  assert.deepEqual(await preview(),{
    accountId:cash.id,accountName:cash.name,closingOn:addDays(today,-2),expectedMinor:11000000
  });
  assert.deepEqual(await preview({closingOn:addDays(today,-1)}),{
    accountId:cash.id,accountName:cash.name,closingOn:addDays(today,-1),expectedMinor:13000000
  });
  assert.deepEqual(await preview({account:second.id}),{
    accountId:second.id,accountName:second.name,closingOn:addDays(today,-2),expectedMinor:700000
  });
  assert.equal((await preview({closingOn:openingOn})).expectedMinor,10000000);
  assert.equal((await preview()).expectedMinor,11000000);
  assert.deepEqual(await closingState(store),before);
}));

test('Closing preview enforces closing account, date, cutoff and responsible-person validations',()=>closingFixture(async({store,actor,today,openingOn,person,account,cash,preview})=>{
  const archived=await account({name:'Caja archivada'});
  await saveAccount(store,{active:false,version:archived.version,requestId:requestId()},actor,archived.id);
  const bank=await account({name:'Banco',type:'bank'});
  const wallet=await account({name:'Billetera',type:'wallet'});
  const before=await closingState(store);
  for(const [filters,status] of [
    [{account:undefined},400],
    [{account:''},400],
    [{account:'missing-cash-account'},404],
    [{closingOn:undefined},400],
    [{closingOn:''},400],
    [{closingOn:'not-a-date'},400],
    [{closingOn:'2025-02-30'},400],
    [{closingOn:addDays(openingOn,-1)},400],
    [{closingOn:addDays(today,1)},400],
    [{account:archived.id},409],
    [{account:bank.id},400],
    [{account:wallet.id},400]
  ])await assert.rejects(()=>preview(filters),{status});
  assert.deepEqual(await closingState(store),before);

  const closingOn=addDays(today,-1);
  await closeCash(store,{accountId:cash.id,closingOn,countedMinor:10000000,requestId:requestId()},actor);
  const afterClose=await closingState(store);
  await assert.rejects(()=>preview({closingOn}),{status:409});
  await assert.rejects(()=>preview({closingOn:openingOn}),{status:409});
  assert.deepEqual(await closingState(store),afterClose);

  const activeCash=await account({name:'Caja con responsable luego archivado'});
  await saveResource(store,'people',{name:person.name,active:false,version:person.version,requestId:requestId()},actor,person.id);
  const afterArchive=await closingState(store);
  await assert.rejects(()=>preview({account:activeCash.id}),{status:400});
  assert.deepEqual(await closingState(store),afterArchive);
}));

test('Closing preview accepts only preview=1 and rejects a saved record without changing list and detail queries',()=>closingFixture(async({store,actor,today,cash,preview})=>{
  const before=await closingState(store);
  for(const value of ['','0','2','true',1,null,undefined]){
    await assert.rejects(()=>preview({preview:value}),{status:400,message:'Vista previa de cierre no válida.'});
  }
  for(const record of ['saved-closing','']){
    await assert.rejects(()=>preview({record}),{status:400,message:'La vista previa no admite un cierre guardado.'});
  }
  assert.deepEqual(await closingState(store),before);
  const closing=await closeCash(store,{accountId:cash.id,closingOn:addDays(today,-1),countedMinor:10000000,requestId:requestId()},actor);
  const list=await financeQuery(store,'closings',{account:cash.id});
  assert.equal(list.total,1);
  assert.equal(list.records[0].id,closing.id);
  assert.deepEqual(await financeQuery(store,'closings',{record:closing.id}),closing);
}));
