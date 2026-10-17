import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../lib/db/index.mjs';
import {createBusinessFixture,settleBusinessFixture,requestId} from './business-fixtures.mjs';
import {financeQuery,reverseFinancialDocument} from '../lib/business/finance.mjs';
import {recordExpense} from '../lib/business/expenses.mjs';

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
