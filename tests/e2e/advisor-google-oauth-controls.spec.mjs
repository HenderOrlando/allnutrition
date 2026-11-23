import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { getSession, SESSION_COOKIE } from '../../lib/auth.mjs';
import { googleOAuthConfig } from '../../lib/assistant/google-oauth.mjs';
import { getAssistantSettings, loadAssistantRuntime, saveAssistantOAuthConnection, saveAssistantSettings } from '../../lib/assistant/settings.mjs';
import { openStore } from '../../lib/db/index.mjs';

const root=fileURLToPath(new URL('../..',import.meta.url));
const spec=fileURLToPath(import.meta.url);
const panelPath='/admin?section=business&tab=assistant';
const oauthPath='/api/admin/assistant/oauth';
const config={ASSISTANT_GOOGLE_CLIENT_ID:'SYNTHETIC-CLIENT.apps.googleusercontent.com',ASSISTANT_GOOGLE_CLIENT_SECRET:'SYNTHETIC-SECRET'};
const button=(root,name)=>root.getByRole('button',{name,exact:true});

async function serve(scratch){
  const config=pathToFileURL(join(root,'next.config.mjs')).href;
  const distDir=relative(root,join(scratch,'next'));
  registerHooks({load(url,opts,load){
    if(url===config)return {format:'module',shortCircuit:true,source:`import config from ${JSON.stringify(`${config}?base`)}; export default {...config,distDir:${JSON.stringify(distDir)}};`};
    return load(url,opts);
  }});
  process.argv.splice(2,2,'--serve',scratch,'--empty-business');
  await import('../heka-browser.mjs');
}
if(process.argv[2]==='--serve-google-oauth')await serve(process.argv[3]);
else test('Ali @advisor-c6: entrega OAuth de Google y retirada de la conexión local sin contacto real',async({browser},info)=>{
  test.setTimeout(240000);
  const temp=join(root,'.test-data');
  await mkdir(temp,{recursive:true});
  const scratch=await mkdtemp(join(temp,'heka-browser-'));
  let child,context,store;
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-days','1','-keyout',join(scratch,'https.key'),'-out',join(scratch,'https.crt')],{stdio:'ignore'});
    child=fork(spec,['--serve-google-oauth',scratch],{cwd:root,execArgv:[],env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'development',...config}});
    const origin=await Promise.race([once(child,'message').then(([url])=>url),once(child,'exit').then(([code])=>{throw new Error(`Fixture HTTPS detenida (${code}).`);})]);
    const env={...config,APP_URL:origin,DB_DRIVER:'sqlite',SQLITE_PATH:join(scratch,'browser.sqlite'),INTEGRATION_SECRETS_DIR:join(scratch,'keys'),SOCIAL_BROWSER_CONTROL_DIR:join(scratch,'browser-control')};
    store=await openStore(env);
    const original=await loadAssistantRuntime(store,{env});
    const {defaultBrowserType:_,...device}=info.project.use;
    const viewport=info.project.name==='mobile'?{width:320,height:740}:{width:1440,height:900};
    context=await browser.newContext({...device,baseURL:origin,ignoreHTTPSErrors:true,viewport,serviceWorkers:'block'});
    const writes=[],blocked=[];
    await context.route('**/*',route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==origin){
        blocked.push(url);
        if(url.origin==='https://accounts.google.com'&&url.pathname==='/o/oauth2/v2/auth')
          return route.fulfill({contentType:'text/plain',body:'Redirección interceptada: no se contactó a Google.'});
        return route.abort('blockedbyclient');
      }
      if(url.pathname.startsWith(oauthPath)&&request.method()!=='GET')writes.push({method:request.method(),path:url.pathname,body:request.postDataJSON()});
      return route.continue();
    });
    const page=await context.newPage();page.setDefaultTimeout(15000);
    const login=await context.request.post('/api/auth/login',{headers:{origin},data:{email:'e2e@example.test',password:'clave-e2e-solo-pruebas'}});
    expect(login.status()).toBe(200);
    const token=(await context.cookies()).find(cookie=>cookie.name===SESSION_COOKIE).value;
    const session={...await getSession(store,token),sessionTokenHash:createHash('sha256').update(token).digest('hex')};
    const chat=page.getByRole('dialog',{name:'Ali, asistente del negocio',exact:true});
    const showChat=()=>button(page.getByRole('banner'),'Ali').click();
    const actionCard=(scope,id)=>scope.locator(`[data-capability-id="assistant.settings-google-${id}"]`).last();
    async function askCard(id,query){
      await chat.getByLabel('Mensaje para Ali').fill(`¿Dónde encuentro ${query}?`);
      await button(chat,'Enviar').click();
      await expect(actionCard(chat,id)).toBeVisible({timeout:30000});
      await expect(actionCard(chat,id).getByRole('button',{name:/^Abrir en el panel:/})).toBeEnabled();
    }
    async function arrive(via,id,query,target){
      if(via==='panel'){await expect(target).toBeVisible();return;}
      if(!await chat.isVisible())await showChat();
      let entry=chat;
      if(via==='directorio'){
        await button(chat,'¿Qué quieres hacer?').click();
        entry=page.getByRole('dialog',{name:'¿Qué quieres hacer?',exact:true});
        await entry.getByRole('searchbox',{name:'Buscar una acción'}).fill(query);
        await button(entry,'Buscar').click();
      }
      await actionCard(entry,id).getByRole('button',{name:/^Abrir en el panel:/}).click();
      await expect(entry).toHaveCount(0);
      await expect(target).toBeFocused();
      await expect(target).toHaveAttribute('data-advisor-arrival','');
    }
    async function consent(target,accept){
      const prompt=page.waitForEvent('dialog'),clicked=target.click();
      const decision=await prompt;
      expect(decision.message()).toMatch(/Google|modelo y proyecto/);
      await (accept?decision.accept():decision.dismiss());
      await clicked;
    }
    for(const via of ['panel','chat','directorio'])await test.step(via,async()=>{
      await page.goto(panelPath);
      const before=await getAssistantSettings(store),initialWrites=writes.length;
      const project='ali-c6-synthetic',model='gemini-2.5-flash';
      const provider=page.getByRole('combobox',{name:'Proveedor',exact:true}),authentication=page.getByRole('combobox',{name:'Método de autenticación',exact:true});
      expect(before.provider).toBe('openai-compatible');
      await expect(provider).toHaveValue(before.provider);
      await provider.selectOption('gemini');
      await expect(provider).toHaveValue('gemini');
      await authentication.selectOption('oauth');
      await expect(authentication).toHaveValue('oauth');
      await page.getByRole('textbox',{name:'Modelo',exact:true}).fill(model);
      await page.getByRole('textbox',{name:'Proyecto de Google Cloud',exact:true}).fill(project);
      await expect(page.getByText('La aplicación OAuth de Google está configurada en el servidor.',{exact:true})).toBeVisible();
      if(via==='chat'){
        await showChat();
        await askCard('connect','conectar cuenta de google');
        await askCard('disconnect','desconectar gemini');
      }
      const connect=button(page,'Conectar cuenta de Google');
      await arrive(via,'connect','conectar cuenta de google',connect);
      await expect(page.getByRole('textbox',{name:'Proyecto de Google Cloud',exact:true})).toHaveValue(project);
      await consent(connect,false);
      expect(writes).toHaveLength(initialWrites);
      expect(await getAssistantSettings(store)).toEqual(before);
      const started=page.waitForResponse(response=>new URL(response.url()).pathname===`${oauthPath}/start`&&response.request().method()==='POST');
      const redirected=page.waitForRequest(request=>new URL(request.url()).origin==='https://accounts.google.com');
      await consent(connect,true);
      const [response,external]=await Promise.all([started,redirected]);
      await page.waitForURL(url=>url.origin==='https://accounts.google.com');
      expect(response.ok(),await response.text()).toBe(true);
      const redirect=new URL(external.url());
      expect(redirect.pathname).toBe('/o/oauth2/v2/auth');
      expect(redirect.searchParams.get('redirect_uri')).toBe(`${origin}${oauthPath}/callback`);
      expect(redirect.searchParams.get('client_secret')).toBeNull();
      expect(writes.at(-1)).toMatchObject({body:{version:before.version,model,projectId:project}});
      expect((await getAssistantSettings(store)).hasOAuthConnection).toBe(false);
      let threadTitle;
      if(via==='chat'){
        const index=await context.request.get('/api/admin/assistant/threads?page=1');
        const {threads}=await index.json();
        threadTitle=threads[0].title;
      }
      const connected=await saveAssistantOAuthConnection(store,{version:before.version,model,projectId:project,
        credentials:{fingerprint:googleOAuthConfig(env).fingerprint,accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,scope:'https://www.googleapis.com/auth/cloud-platform'}},session,{env,verify:async()=>{}});
      await page.goto(panelPath);
      if(via==='chat'){
        await showChat();
        await chat.getByRole('button').filter({hasText:threadTitle}).first().click();
        await expect(actionCard(chat,'disconnect')).toBeVisible();
      }
      const disconnect=button(page,'Desconectar cuenta de Google');
      await arrive(via,'disconnect','desconectar gemini',disconnect);
      await consent(disconnect,false);
      expect(writes).toHaveLength(initialWrites+1);
      expect((await getAssistantSettings(store)).hasOAuthConnection).toBe(true);
      const removed=page.waitForResponse(response=>new URL(response.url()).pathname===oauthPath&&response.request().method()==='DELETE');
      await consent(disconnect,true);
      expect(await (await removed).json()).toMatchObject({settings:{version:connected.version+1,hasOAuthConnection:false,enabled:false},revoked:false});
      await expect(page.getByRole('status').filter({hasText:'Conexión de Google eliminada localmente'})).toContainText('No se pudo confirmar la revocación remota');
      expect(await store.db.get(`SELECT id FROM ${store.t('assistant_oauth_credentials')}`)).toBeFalsy();
      if(via!=='directorio')await saveAssistantSettings(store,{requestId:randomUUID(),version:connected.version+1,enabled:true,provider:'openai-compatible',model:original.model,baseUrl:original.baseUrl,apiKey:original.apiKey,allowPrivateNetwork:true},session,{env});
    });
    expect(blocked.map(url=>url.origin)).toEqual(Array(3).fill('https://accounts.google.com'));
  }finally{
    await context?.close();await store?.close();
    if(child&&child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
    await rm(scratch,{recursive:true,force:true});
  }
});
