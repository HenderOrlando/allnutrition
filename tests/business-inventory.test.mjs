import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { businessInventoryContracts } from './business-inventory-contract.mjs';

export { businessInventoryContracts };
for(const [name,execute] of businessInventoryContracts) {
  test(name,async t=>{
    const store=await openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'});
    t.after(()=>store.close());
    await execute(store);
  });
}
