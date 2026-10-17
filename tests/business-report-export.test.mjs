import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { openStore } from '../lib/db/index.mjs';
import { saveResource } from '../lib/business/settings.mjs';
import { saveAccount,recordIncome } from '../lib/business/cash.mjs';
import { buildBusinessReport } from '../lib/business/reports.mjs';
import { exportBusinessReport } from '../lib/business/report-export.mjs';

const XLSX=createRequire(import.meta.url)('xlsx');

test('XLSX distinguishes a real cent at the safe aggregate boundary instead of rounding both balances to the same number',async()=>{
  const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
  try{
    const actor='xlsx-precision-admin',person=await saveResource(store,'people',{requestId:'xlsx-precision-person',name:'Responsable de precisión'},actor);
    const documentMaximum=10000000000000n,initial=BigInt(Number.MAX_SAFE_INTEGER)-1n;
    let last;
    for(let index=0;index<=900;index++)last=await saveAccount(store,{requestId:`xlsx-precision-bank-${index}`,name:`Banco sintético ${index}`,type:'bank',openingOn:'2025-01-01',openingBalanceMinor:Number(index<900?documentMaximum:initial-900n*documentMaximum),responsibleId:person.id},actor);
    const query={period:'month',anchorDate:'2025-01-01'};
    const first=await buildBusinessReport(store,{...query,asOf:'2025-01-01T12:00:00.000Z'});
    await recordIncome(store,{requestId:'xlsx-precision-cent',accountId:last.id,effectiveOn:'2025-01-02',amountMinor:1,concept:'owner_funding',description:'Un centavo adicional confirmado'},actor);
    const second=await buildBusinessReport(store,{...query,asOf:'2025-01-02T12:00:00.000Z'});
    assert.equal(first.metrics.cashAvailable.value,9007199254740990);
    assert.equal(second.metrics.cashAvailable.value,9007199254740991);
    const values=[first,second].map(report=>{
      const workbook=XLSX.read(exportBusinessReport(report),{type:'buffer'});
      const rows=XLSX.utils.sheet_to_json(workbook.Sheets.Resumen,{header:1,raw:true});
      return rows.find(row=>row[0]===report.metrics.cashAvailable.label)[1];
    });
    assert.deepEqual(values,['90071992547409,90','90071992547409,91']);
  }finally{await store.close();}
});
