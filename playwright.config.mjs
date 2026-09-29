import { defineConfig,devices } from '@playwright/test';
import { resolve } from 'node:path';
export default defineConfig({
 testDir:'./tests/e2e',fullyParallel:false,workers:1,
 use:{baseURL:'http://127.0.0.1:3100',trace:'retain-on-failure'},
 projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
 webServer:{command:'node tests/e2e/setup.mjs && npm run dev -- --hostname 127.0.0.1 --port 3100',url:'http://127.0.0.1:3100',reuseExistingServer:false,timeout:120000,env:{DB_DRIVER:'sqlite',SQLITE_PATH:resolve('.test-data/e2e.sqlite'),APP_URL:'http://127.0.0.1:3100',NEXT_TELEMETRY_DISABLED:'1'}},
 reporter:[['list'],['html',{open:'never'}]]
});
