import { adminInventory, adminExclusions } from './assistant-panel-inventory-admin.mjs';
import { advertisingInventory, advertisingExclusions } from './assistant-panel-inventory-advertising.mjs';
import { cashInventory, cashExclusions } from './assistant-panel-inventory-cash.mjs';
import { orderInventory, orderExclusions } from './assistant-panel-inventory-orders.mjs';

// Native controls are the source for these observations, never Ali's registry.
export const panelInventory = Object.freeze([
  ...adminInventory, ...orderInventory, ...cashInventory, ...advertisingInventory,
]);
export const panelExclusions = Object.freeze([
  ...adminExclusions, ...orderExclusions, ...cashExclusions, ...advertisingExclusions,
]);
