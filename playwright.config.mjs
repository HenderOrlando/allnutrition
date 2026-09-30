import { defineConfig,devices } from '@playwright/test';
const configuredURL=process.env.E2E_BASE_URL;
const urlError='E2E_BASE_URL debe ser un origen HTTPS de localhost, sin credenciales, ruta, consulta ni fragmento.';
if(!configuredURL||!/^https:\/\/localhost(?::\d+)?\/?$/.test(configuredURL))throw new Error(urlError);
let baseURL;
try{
 const url=new URL(configuredURL);
 if(url.protocol!=='https:'||url.hostname!=='localhost'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error(urlError);
 baseURL=url.origin;
}catch{throw new Error(urlError);}
export default defineConfig({
 testDir:'./tests/e2e',fullyParallel:false,workers:1,
 outputDir:process.env.PLAYWRIGHT_OUTPUT_DIR||'test-results',
 use:{baseURL,ignoreHTTPSErrors:process.env.E2E_ALLOW_SELF_SIGNED==='1',trace:'retain-on-failure',screenshot:'only-on-failure'},
 projects:[{name:'desktop',use:{...devices['Desktop Chrome']}},{name:'mobile',use:{...devices['iPhone 13'],defaultBrowserType:'chromium'}}],
 reporter:[['list'],['html',{open:'never',outputFolder:process.env.PLAYWRIGHT_HTML_OUTPUT_DIR||'playwright-report'}]]
});
