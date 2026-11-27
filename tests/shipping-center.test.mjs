import test from 'node:test';
import { openStore } from '../lib/db/index.mjs';
import { runShippingCenterContracts } from './shipping-center-contract.mjs';

test('Centro de envíos en SQLite (proveedores sintéticos)',t=>runShippingCenterContracts(t,()=>openStore({DB_DRIVER:'sqlite',SQLITE_PATH:':memory:'})));
