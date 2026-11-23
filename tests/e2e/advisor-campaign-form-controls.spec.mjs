import { devices, expect, test } from '@playwright/test';
import { execFileSync, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { hash, insertRow } from '../../lib/business/commands.mjs';
import { getSocialCampaign, saveSocialCampaign, socialCampaignAction } from '../../lib/business/social.mjs';
import { estimateSocialCampaign } from '../../lib/business/social-analysis.mjs';
import { handleSocialChangeTx } from '../../lib/business/social-changes.mjs';
import { createSocialAsset, processSocialAssetTurn, uploadSocialAsset } from '../../lib/business/social-media.mjs';
import { saveSocialSettings } from '../../lib/business/social-settings.mjs';
import { openStore } from '../../lib/db/index.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const spec = fileURLToPath(import.meta.url);
const campaigns = '/api/admin/social/campaigns';
const editorPath = id => `/admin?section=advertising&tab=campaigns&record=${id}`;
const button = (scope, name) => scope.getByRole('button', { name, exact: true });
const ali = page => page.getByRole('dialog', { name: 'Ali, asistente del negocio', exact: true });
const declarationName = '¿La imagen o video contiene contenido generado con IA?';
const helpName = 'Ayúdame con este borrador';

async function ask(chat, message) {
  await chat.getByLabel('Mensaje para Ali').fill(message);
  await button(chat, 'Enviar').click();
}

async function reach(page, via, capability, query, target) {
  if (via === 'panel') {
    await expect(target).toBeVisible();
    return;
  }
  await button(page.getByRole('banner'), 'Ali').click();
  let overlay = ali(page);
  const find = scope => scope.locator(`[data-capability-id="advertising.${capability}"]`);
  let card;
  if (via === 'chat') {
    if (await button(overlay, 'Responder').count()) await button(overlay, '‹ Conversaciones').click();
    const count = await find(overlay).count();
    await ask(overlay, `¿Dónde encuentro ${query}?`);
    await expect(find(overlay)).toHaveCount(count + 1, { timeout: 30000 });
    card = find(overlay).last();
  } else {
    await button(overlay, '¿Qué quieres hacer?').click();
    overlay = page.getByRole('dialog', { name: '¿Qué quieres hacer?', exact: true });
    await overlay.getByRole('searchbox', { name: 'Buscar una acción' }).fill(query);
    await button(overlay, 'Buscar').click();
    card = find(overlay);
  }
  await card.getByRole('button', { name: /^Abrir en el panel:/ }).click();
  await expect(overlay).toHaveCount(0);
  await expect(ali(page)).toHaveCount(0);
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('data-advisor-arrival', '');
  await expect(target).toBeInViewport();
}

if(process.argv[2]==='--serve-campaign-controls'){
  const scratch=process.argv[3],config=pathToFileURL(join(root,'next.config.mjs')).href,distDir=relative(root,join(scratch,'next'));
  registerHooks({load(url,opts,load){
    if(url===config)return {format:'module',shortCircuit:true,source:`import config from ${JSON.stringify(`${config}?base`)}; export default {...config,distDir:${JSON.stringify(distDir)}};`};
    return load(url,opts);
  }});
  process.argv.splice(2,2,'--serve',scratch,'--empty-business');
  await import('../heka-browser.mjs');
} else test('Ali @advisor-c6: declaración, ayuda, revisión y autorizaciones nativas en la publicación exacta', async ({ browser }, info) => {
  test.setTimeout(480000);
  const tmp = join(root, '.test-data');
  await mkdir(tmp, { recursive: true });
  const scratch = await mkdtemp(join(tmp, 'heka-browser-'));
  const env = { DB_DRIVER: 'sqlite', SQLITE_PATH: join(scratch, 'browser.sqlite'), SOCIAL_MEDIA_DIR: join(scratch, 'media'),
    INTEGRATION_SECRETS_DIR: join(scratch, 'keys'), SOCIAL_BROWSER_CONTROL_DIR: join(scratch, 'browser-control') };
  let server, context, store;
  try {
    await writeFile(join(scratch, 'provider.jsonl'), '', { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', join(scratch, 'https.key'), '-out', join(scratch, 'https.crt')], { stdio: 'ignore' });
    server = fork(spec, ['--serve-campaign-controls', scratch], { cwd: root, execArgv: [], env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development' } });
    const origin = await Promise.race([once(server, 'message').then(([url]) => url), once(server, 'exit').then(([code]) => { throw new Error(`Fixture HTTPS detenida (${code}).`); })]);
    expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
    const mobile = info.project.name === 'mobile';
    const viewport = mobile ? { width: 320, height: 740 } : { width: 1440, height: 900 };
    context = await browser.newContext({ ...(mobile ? devices['iPhone 13'] : devices['Desktop Chrome']), viewport, baseURL: origin, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
    const external = [], socialWrites = [], assistantBodies = [];
    let editablePhotoDraft=null;
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin) { external.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith('/api/admin/social/') && !['GET', 'HEAD'].includes(request.method())) {
        socialWrites.push([request.method(), url.pathname, request.postDataJSON()]);
        const draftWrite = request.method() === 'PATCH' && /^\/api\/admin\/social\/campaigns\/[^/]+$/.test(url.pathname);
        const forecast = request.method() === 'POST' && /^\/api\/admin\/social\/campaigns\/[^/]+\/forecast$/.test(url.pathname);
        const approve = request.method() === 'POST' && /^\/api\/admin\/social\/campaigns\/[^/]+\/actions$/.test(url.pathname) && request.postDataJSON().action === 'approve-organic';
        const studioWrite=editablePhotoDraft&&(
          request.method()==='POST'&&url.pathname==='/api/admin/social/creative-threads'&&request.postDataJSON().campaignId===editablePhotoDraft||
          request.method()==='PATCH'&&/^\/api\/admin\/social\/creative-threads\/[^/]+$/.test(url.pathname)&&['attach','select'].includes(request.postDataJSON().action));
        if (!draftWrite && !forecast && !approve && !studioWrite) return route.abort();
      }
      if (url.pathname.startsWith('/api/admin/assistant/') && request.postData()) assistantBodies.push(request.postData());
      return route.continue();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const login=await context.request.post('/api/auth/login',{headers:{origin},data:{email:'e2e@example.test',password:'clave-e2e-solo-pruebas'}});
    expect(login.status()).toBe(200);
    expect(page.viewportSize()).toEqual(viewport);
    store = await openStore(env);
    const { id: actor } = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#336688' } }).png().toBuffer();
    async function seedAsset(name, generation = null, bytes = image) {
      const reserved = await createSocialAsset(store, { name, contentType: 'image/png', expectedBytes: bytes.length, requestId: randomUUID() }, actor, { env, generation });
      await uploadSocialAsset(store, reserved.id, { version: reserved.version, contentType: 'image/png', contentLength: bytes.length, body: Readable.from([bytes]), requestId: randomUUID() }, actor, { env });
      expect(await processSocialAssetTurn(store, { env })).toMatchObject({ processed: 1 });
      return reserved.id;
    }
    const manualId = await seedAsset('Pieza propia sintética C6');
    const generatedId = await seedAsset('Pieza generada sintética C6', { model: 'fixture' });
    const draft = (name, assetId, aiDisclosure = null) => saveSocialCampaign(store, {
      requestId: randomUUID(), name, mode: 'organic', objective: 'reach', platforms: [], caption: 'Texto inicial C6', assetId, aiDisclosure,
    }, actor);
    const other = await draft('Borrador ajeno al contexto C6', manualId);
    const untouched = await getSocialCampaign(store, other.id);
    const unchanged = async (record, expected) => {
      expect(await getSocialCampaign(store, record.id)).toMatchObject({ id: record.id, state: 'draft', revisions: [], deliveries: [], operations: [], ...expected });
    };
    const assertExact = id => expect(page).toHaveURL(url => url.searchParams.get('tab') === 'campaigns' && url.searchParams.get('record') === id);
    for (const via of ['panel', 'chat', 'directorio']) await test.step(via, async () => {
      const saved = await draft(`Declaración propia C6 ${via}`, manualId);
      const generated = await draft(`Declaración bloqueada C6 ${via}`, generatedId, true);
      await page.goto(editorPath(saved.id));
      const editor = page.locator(`[data-campaign-draft-editor="${saved.id}"]`);
      const declaration = editor.getByLabel(declarationName, { exact: true });
      const help = button(editor, helpName);
      await expect(declaration).toHaveValue('');
      if (via !== 'panel') {
        await button(editor, 'Continuar a revisión').click();
        await expect(declaration).toBeHidden();
      }
      const offset = socialWrites.length;
      await reach(page, via, 'declare-ai-origin', 'procedencia creativa', declaration);
      await assertExact(saved.id);
      await expect(declaration).toHaveValue('');
      await unchanged(saved, { version: saved.version, aiDisclosure: null });
      expect(socialWrites.slice(offset)).toEqual([]);
      await declaration.selectOption('false');
      await unchanged(saved, { version: saved.version, aiDisclosure: null });
      await button(editor, 'Guardar borrador').click();
      await expect(editor.getByRole('status').filter({ hasText: 'Borrador guardado. No se publicó ni se autorizó gasto.' })).toBeVisible();
      await unchanged(saved, { version: saved.version + 1, aiDisclosure: false });
      expect(socialWrites.slice(offset)).toEqual([['PATCH', `${campaigns}/${saved.id}`, expect.objectContaining({ version: saved.version, aiDisclosure: false })]]);

      await reach(page, via, 'assist-draft', 'revisar idea con Ali', help);
      await assertExact(saved.id);
      await expect(declaration).toHaveValue('false');
      await help.click();
      const chat = ali(page);
      await expect(chat).toBeVisible();
      await expect(button(chat, 'Volver al formulario')).toBeVisible();
      const caption = `Texto propuesto C6 ${via}`;
      await ask(chat, JSON.stringify({ patch: { caption } }));
      const proposal = chat.getByRole('region', { name: 'Propuesta de cambio', exact: true }).last();
      await expect(proposal).toContainText(`Destino: campaign-draft · ${saved.id}`, { timeout: 30_000 });
      await expect(proposal.locator('ins')).toHaveText(caption);
      await unchanged(saved, { version: saved.version + 1, aiDisclosure: false, caption: 'Texto inicial C6' });
      await button(proposal, 'Aplicar valores').click();
      await expect(chat).toHaveCount(0);
      await expect(editor.getByLabel('Texto que acompaña la imagen o video')).toHaveValue(caption);
      await expect(declaration).toHaveValue('false');
      await unchanged(saved, { version: saved.version + 1, aiDisclosure: false, caption: 'Texto inicial C6' });
      const accept = dialog => dialog.accept();
      page.on('dialog', accept);
      try {
        await button(editor, 'Guardar borrador').click();
        await expect.poll(async () => (await getSocialCampaign(store, saved.id)).caption).toBe(caption);
      } finally { page.off('dialog', accept); }
      await unchanged(saved, { version: saved.version + 2, aiDisclosure: false, caption });
      expect(socialWrites.slice(offset)).toHaveLength(1);

      await page.goto(editorPath(generated.id));
      const generatedEditor = page.locator(`[data-campaign-draft-editor="${generated.id}"]`);
      const fixed = generatedEditor.getByLabel(declarationName, { exact: true });
      await expect(fixed).toHaveValue('true');
      await reach(page, via, 'declare-ai-origin', 'procedencia creativa', fixed.locator('..'));
      await assertExact(generated.id);
      await expect(fixed).toBeDisabled();
      await expect(fixed).toHaveValue('true');
      await expect(generatedEditor.getByText('La pieza fue generada con IA. Esta declaración se conserva y no se puede quitar.')).toBeVisible();
      await unchanged(generated, { version: generated.version, aiDisclosure: true });
      const edit = generatedEditor.getByLabel('Texto que acompaña la imagen o video');
      await edit.fill('Otro texto para la pieza generada');
      const saving = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === `${campaigns}/${generated.id}`);
      await button(generatedEditor, 'Guardar borrador').click();
      const savedGenerated = await saving;
      expect(savedGenerated.ok(), await savedGenerated.text()).toBe(true);
      await expect(generatedEditor.getByRole('status').filter({ hasText: 'Borrador guardado. No se publicó ni se autorizó gasto.' })).toBeVisible();
      await unchanged(generated, { version: generated.version + 1, aiDisclosure: true });
      expect(socialWrites.slice(offset).at(-1)).toEqual(['PATCH', `${campaigns}/${generated.id}`, expect.objectContaining({ aiDisclosure: true })]);
      expect(await getSocialCampaign(store, other.id)).toEqual(untouched);
    });
    expect(socialWrites).toHaveLength(6);
    const connectionId = randomUUID(), now = new Date().toISOString();
    await saveSocialSettings(store,{ requestId:randomUUID(),version:0,publicBaseUrl:origin,appId:'100001',loginConfigId:'100002',
      appSecret:'solo-fixture-local',publishingEnabled:true,browserEnabled:true },actor,{ env,allowedOrigins:[origin] });
    await insertRow(store, 'social_connections', {
      id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected', version: 1, created_at: now, updated_at: now,
      data: JSON.stringify({ name: 'Cuenta editorial local C6', authenticationMethod: 'oauth',
        identities: { userId: '100', businessId: '500', pageId: '200', adAccountId:'400' },
        capabilities: { facebookPublish: true, adsPublish: true }, currency:'COP', timeZone:'America/Bogota',
        resources: { pages: [{ id: '200', name: 'Página sintética', businessId: '500', tasks: ['CREATE_CONTENT'] }] } }),
    });
    for (const via of ['panel', 'chat', 'directorio']) await test.step(`revisión orgánica · ${via}`, async () => {
      const saved = await saveSocialCampaign(store, {
        requestId: randomUUID(), name: `Previsión orgánica local C6 ${via}`, mode: 'organic', objective: 'engagement',
        connectionId, assetId: manualId, aiDisclosure: false, marketCountries: ['CO'], platforms: ['facebook'],
        placements: ['facebook_feed'], caption: 'Revisión editorial sin publicación',
      }, actor);
      await page.goto(editorPath(saved.id));
      const editor = page.locator(`[data-campaign-draft-editor="${saved.id}"]`);
      const section = editor.getByRole('region', { name: 'Consulta una estimación' });
      if (via !== 'panel') await button(editor, '1. Definir publicación').click();
      const scenario = section.getByText('Agregar mi propia hipótesis', { exact: true });
      const start = socialWrites.length;
      await reach(page, via, 'prepare-forecast-scenario', 'agregar mi propia hipótesis', scenario);
      await assertExact(saved.id);
      expect(socialWrites.slice(start)).toEqual([]);
      await scenario.click();
      await section.getByRole('checkbox', { name: /Quiero incluir mi hipótesis/ }).check();
      await section.getByLabel('Métrica primaria').selectOption('facebook.interactions');
      await section.getByLabel('Límite inferior').fill('15');
      await section.getByLabel('Límite superior').fill('5');
      await section.getByLabel('Fundamento explícito').fill('Hipótesis editorial, no garantía.');
      const estimate = button(section, 'Guardar y obtener estimación');
      await reach(page, via, 'request-forecast', 'estimar publicación orgánica', estimate);
      await estimate.click();
      await expect(editor.getByRole('alert')).toContainText(/límite|rango/i);
      await unchanged(saved, { version: saved.version });
      expect(socialWrites.slice(start)).toEqual([]);
      await section.getByLabel('Límite superior').fill('25');
      await estimate.click();
      const review = section.getByRole('group', { name: 'Autorización de la revisión' });
      await expect(review).toBeVisible();
      expect(socialWrites.slice(start)).toEqual([['POST', `${campaigns}/${saved.id}/forecast`, expect.objectContaining({ version: saved.version })]]);
      await reach(page, via, 'approve-organic', 'aprobar orgánica', review);
      await assertExact(saved.id);
      await expect(button(review, 'Aprobar sin publicar')).toBeDisabled();
      await unchanged(saved, { version: saved.version });
      expect(socialWrites.slice(start)).toHaveLength(1);
      for (const checkbox of await review.getByRole('checkbox').all()) {
        await expect(checkbox).not.toBeChecked();
        await checkbox.check();
      }
      await button(review, 'Aprobar sin publicar').click();
      await expect(editor.getByText('Revisión aprobada sin publicar. Todavía no se ha solicitado ninguna entrega.', { exact: true })).toBeVisible();
      expect(await getSocialCampaign(store, saved.id)).toMatchObject({
        id: saved.id, state: 'ready', deliveries: [], operations: [], revisions: [{ rightsAccepted: true }],
      });
      expect(socialWrites.slice(start)).toHaveLength(2);
      const scheduled=await saveSocialCampaign(store,{
        requestId:randomUUID(),name:`Agenda orgánica local C6 ${via}`,mode:'organic',objective:'engagement',
        connectionId,assetId:manualId,aiDisclosure:false,marketCountries:['CO'],platforms:['facebook'],placements:['facebook_feed'],
        caption:'Revisión de agenda, no se enviará',publishAt:new Date(Date.now()+86400000).toISOString(),
      },actor);
      const forecast=await estimateSocialCampaign(store,scheduled.id,{version:scheduled.version,requestId:randomUUID(),env},actor);
      const prepared=await getSocialCampaign(store,scheduled.id);
      await socialCampaignAction(store,scheduled.id,'approve-organic',{version:scheduled.version,requestId:randomUUID(),rightsAccepted:true,
        acceptedWarnings:prepared.validation.warnings.map(warning=>warning.key),specHash:forecast.specHash,forecastId:forecast.id},actor,{env});
      for(const [record,label,capability,query,confirm] of [
        [saved,'Publicar','publish-organic-now','publicar sin programar','Confirmar publicación'],
        [scheduled,'Programar','schedule-organic-publication','programar publicación','Confirmar programación'],
      ]){
        if(record===scheduled)await page.goto(editorPath(record.id));
        const exactEditor=page.locator(`[data-campaign-draft-editor="${record.id}"]`);
        const publish=button(exactEditor,label);
        await reach(page,via,capability,query,publish);
        await publish.click();
        const permission=exactEditor.getByRole('dialog',{name:`${label} revisión aprobada`});
        await expect(permission.getByRole('checkbox')).not.toBeChecked();
        await expect(button(permission,confirm)).toBeDisabled();
        await button(permission,'Volver sin ejecutar').click();
      }
      expect(socialWrites.slice(start)).toHaveLength(2);
    });
    const rec={version:1,created_at:now,updated_at:now};
    const startAt=new Date(Date.now()+86400000).toISOString(),endAt=new Date(Date.now()+2*86400000).toISOString();
    const savePaidDraft=(name,id=connectionId)=>saveSocialCampaign(store,{
      requestId:randomUUID(),name,mode:'paid',objective:'engagement',connectionId:id,assetId:manualId,aiDisclosure:false,
      marketCountries:['CO'],platforms:['facebook'],placements:['facebook_feed'],caption:'Pauta que no se debe activar',
      budgetMinor:2000000,startAt,endAt,audience:{countries:['CO']},
    },actor);
    async function paidFixture(state,{uncertain=false,restored=false}={}){
      const base=await savePaidDraft(`Pauta sintética ${state} ${randomUUID().slice(0,6)}`);
      const draft=await getSocialCampaign(store,base.id);
      const budgetSnapshot={budgetMinor:draft.budgetMinor,remainingMinor:1000000,currency:'COP',startAt,endAt,checkedAt:now};
      const spec={...draft,...budgetSnapshot,integrationMethod:'api',timeZone:'America/Bogota',assetHash:draft.asset.sha256,assetType:'image'};
      const specHash=hash(spec),deliveryId=randomUUID(),operationId=randomUUID();
      await insertRow(store,'social_revisions',{campaign_id:base.id,revision:1,spec_hash:specHash,approved_at:now,actor_id:actor,
        data:JSON.stringify({spec,rightsAccepted:true,acceptedWarnings:[]})});
      const remoteId=state==='ready'?null:`9${BigInt(`0x${deliveryId.replaceAll('-','')}`).toString().slice(0,14)}`;
      await insertRow(store,'social_deliveries',{id:deliveryId,campaign_id:base.id,revision:1,channel:'meta_ads',
        state:uncertain?'uncertain':state,remote_id:remoteId,next_sync_at:null,...rec,
        data:JSON.stringify({integrationMethod:'api',budgetSnapshot,preparedRefs:{campaignId:remoteId||'900101',adSetId:'900102',adId:'900103'},
          remoteRefs:remoteId?{campaignId:remoteId,adSetId:'900102',adId:'900103'}:null,lastConfirmedAt:remoteId?now:null,lastConfirmedState:uncertain?'active':state})});
      if(uncertain)await insertRow(store,'social_operations',{id:operationId,campaign_id:base.id,delivery_id:deliveryId,
        operation_key:`delivery:${deliveryId}:activate`,step:'activate',state:'uncertain',next_attempt_at:null,...rec,
        data:JSON.stringify({actorId:actor,specHash,integrationMethod:'api',channel:'meta_ads'})});
      if(state==='paused'&&!restored)await insertRow(store,'social_operations',{id:operationId,campaign_id:base.id,delivery_id:deliveryId,
        operation_key:`delivery:${deliveryId}:verify_prepared`,step:'verify_prepared',state:'confirmed',next_attempt_at:null,...rec,
        data:JSON.stringify({actorId:actor,specHash,integrationMethod:'api',channel:'meta_ads',result:{evidence:{remoteRead:true}}})});
      await store.db.run(`UPDATE ${store.t('social_campaigns')} SET state=?,data=json_set(data,'$.restoreHold',?) WHERE id=?`,[state,restored?1:0,base.id]);
      return {id:base.id,operationId,deliveryId};
    }
    const ready=await paidFixture('ready'),active=await paidFixture('active'),paused=await paidFixture('paused');
    const uncertain=await paidFixture('needs_attention',{uncertain:true}),restored=await paidFixture('paused',{restored:true});
    const handoffs=[
      [ready,'activate-paid','activar pauta','Autorizar inversión','Autorizar inversión'],
      [active,'pause-paid','pausar pauta','Pausar para detener gasto','Solicitar pausa remota'],
      [paused,'resume-paid','reanudar inversión','Revisar y autorizar reanudación','Autorizar reanudación'],
      [active,'cancel-issued-ads','cancelar pauta emitida','Cancelar trabajo / detener anuncios','Cancelar trabajo o pausar anuncios emitidos'],
      [uncertain,'reconcile-campaign','reconciliar publicación','Comprobar en Meta sin reenviar'],
      [uncertain,'reconcile-delivery','reconciliar entrega','Comprobar estado en Meta sin reenviar esta intención'],
      [uncertain,'link-remote-object','vincular ID remoto','Vincular ID o enlace permanente existente','Vincular un objeto remoto existente'],
      [uncertain,'confirm-remote-absence','confirmar ausencia','Confirmar ausencia y riesgo','Confirmar ausencia y riesgo antes de reintentar'],
      [restored,'resume-restored','quitar bloqueo de restauración','Revisar recuperación explícita','Comprobar estado en Meta y aceptar recuperación'],
    ];
    for(const via of ['panel','chat','directorio'])await test.step(`traspasos de pauta · ${via}`,async()=>{
      let previous=null;
      for(const [record,id,query,label,dialog] of handoffs){
        if(record!==previous)await page.goto(editorPath(record.id));
        previous=record;
        const editor=page.locator(`[data-campaign-draft-editor="${record.id}"]`);
        const before=await getSocialCampaign(store,record.id),writes=socialWrites.length;
        const target=button(editor,label);
        await reach(page,via,id,query,target);
        await assertExact(record.id);
        expect(await getSocialCampaign(store,record.id)).toEqual(before);
        expect(socialWrites).toHaveLength(writes);
        if(dialog){
          await target.click();
          const permission=editor.getByRole('dialog',{name:dialog,exact:true});
          await expect(permission).toBeVisible();
          for(const checkbox of await permission.getByRole('checkbox').all())await expect(checkbox).not.toBeChecked();
          if(['link-remote-object','confirm-remote-absence'].includes(id))await expect(permission).toContainText(record.operationId);
          await button(permission,'Volver sin ejecutar').click();
        }
        expect(socialWrites).toHaveLength(writes);
      }
    });
    const browserId=randomUUID();
    await insertRow(store,'social_connections',{id:browserId,provider:'meta',integration_method:'browser',state:'connected',...rec,
      data:JSON.stringify({name:'Conexión privada sintética C6',currency:'COP',timeZone:'America/Bogota',
        identities:{userId:'101',businessId:'501',pageId:'201',adAccountId:'401'},capabilities:{facebookPublish:true,adsPublish:true}})});
    const apiDraft=await savePaidDraft('Estimación oficial sin consulta externa');
    const browserNew=await savePaidDraft('Primer borrador privado sin preparar',browserId);
    const browserExisting=await savePaidDraft('Borrador privado referenciado',browserId);
    const paidData=await getSocialCampaign(store,apiDraft.id);
    expect(paidData.validation.valid,JSON.stringify(paidData.validation)).toBe(true);
    const forecastId=randomUUID(),privateReference='9920020030145';
    await insertRow(store,'social_forecasts',{id:forecastId,campaign_id:apiDraft.id,spec_hash:paidData.validation.specHash,
      generated_at:now,data:JSON.stringify({source:'insufficient',metricRanges:{},audienceEstimate:{status:'not_reported',reason:'Sin lectura externa en la prueba'}})});
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=json_set(data,'$.preflight',json(?)) WHERE id=?`,[
      JSON.stringify({kind:'prepare',remoteDraftRef:privateReference,adapterVersion:'meta-ui-v2',checkedAt:now}),browserExisting.id,
    ]);
    for(const via of ['panel','chat','directorio'])await test.step(`revisión de pauta · ${via}`,async()=>{
      const offset=socialWrites.length;
      await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=json_remove(data,'$.forecastId') WHERE id=?`,[apiDraft.id]);
      await page.goto(editorPath(apiDraft.id));
      const apiEditor=page.locator(`[data-campaign-draft-editor="${apiDraft.id}"]`);
      await reach(page,via,'request-api-paid-forecast','alcance potencial de Meta',button(apiEditor,'Guardar y obtener estimación'));
      expect(socialWrites).toHaveLength(offset);
      await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=json_set(data,'$.forecastId',?) WHERE id=?`,[forecastId,apiDraft.id]);
      await page.reload();
      const approval=apiEditor.getByRole('group',{name:'Autorización de la revisión'});
      await reach(page,via,'prepare-paid','preparar sin activar',approval);
      for(const checkbox of await approval.getByRole('checkbox').all())await expect(checkbox).not.toBeChecked();
      await expect(button(approval,'Preparar sin activar')).toBeDisabled();
      await page.goto(editorPath(browserNew.id));
      const browserEditor=page.locator(`[data-campaign-draft-editor="${browserNew.id}"]`);
      const privateConsent=browserEditor.getByRole('checkbox',{name:/Acepto crear un borrador privado recuperable/});
      await reach(page,via,'prepare-browser-draft','crear borrador privado por navegador',privateConsent);
      await expect(privateConsent).not.toBeChecked();
      await expect(button(browserEditor,'Guardar y preparar borrador privado')).toBeDisabled();
      await page.goto(editorPath(browserExisting.id));
      const referenced=page.locator(`[data-campaign-draft-editor="${browserExisting.id}"]`);
      await reach(page,via,'validate-browser-draft','validar mismo borrador',button(referenced,'Guardar y validar el mismo borrador'));
      const details=referenced.getByText('Detalles del borrador privado',{exact:true});
      await reach(page,via,'read-browser-preflight','referencia recuperable de Meta',details);
      await details.click();
      await expect(referenced.getByText(`Referencia recuperable: ${privateReference}`,{exact:false})).toBeVisible();
      expect(socialWrites).toHaveLength(offset);
      expect(await getSocialCampaign(store,apiDraft.id)).toMatchObject({version:apiDraft.version,revisions:[],deliveries:[],operations:[]});
      expect(await getSocialCampaign(store,browserExisting.id)).toMatchObject({version:browserExisting.version,preflight:{remoteDraftRef:privateReference},operations:[]});
    });
    const photo=await seedAsset('Segunda foto propia C6',null,await sharp({create:{width:400,height:400,channels:3,background:'#285b43'}}).png().toBuffer());
    const source=await getSocialCampaign(store,paused.id);
    for(const via of ['panel','chat','directorio'])await test.step(`cambio de imagen · ${via}`,async()=>{
      const recommendation={id:randomUUID(),campaignId:source.id,state:'suggested',version:1,evidenceHash:hash([source.id,via]),ruleKey:`imagen-${via}`,
        proposedChange:{type:'creative',text:'Probar otra foto propia'},primaryEvidence:{channel:'meta_ads'}};
      await insertRow(store,'social_recommendations',{id:recommendation.id,campaign_id:source.id,state:'suggested',evidence_hash:recommendation.evidenceHash,
        rule_key:recommendation.ruleKey,...rec,data:JSON.stringify({proposedChange:recommendation.proposedChange,primaryEvidence:recommendation.primaryEvidence})});
      const same=await store.transaction(tx=>handleSocialChangeTx(tx,{recommendation,campaign:source,action:'prepare-in-place',
        input:{deliveryId:paused.deliveryId},actorId:actor,now,env}));
      editablePhotoDraft=same.id;
      const readDraft=async()=>{
        const response=await page.request.get(`${campaigns}/${same.id}`);
        expect(response.ok(),await response.text()).toBe(true);
        return response.json();
      };
      await page.goto(editorPath(same.id));
      const editor=page.getByRole('heading',{name:'Cambiar esta campaña',exact:true}).locator('../..');
      const open=button(editor,'Abrir estudio visual');
      await reach(page,via,'save-in-place-image','guardar foto de la misma pieza',open);
      await open.click();
      await button(editor,'Elegir de biblioteca').click();
      await editor.getByRole('combobox',{name:'Archivo de biblioteca'}).selectOption(photo);
      await button(editor,'Usar esta pieza y continuar').click();
      await expect(editor.getByRole('region', { name: 'Estudio visual', exact: true })).toHaveCount(0);
      await editor.getByLabel(declarationName).selectOption('false');
      await expect(editor.getByLabel(declarationName)).toHaveValue('false');
      const save=button(editor,'Guardar borrador de cambio'),offset=socialWrites.length;
      await reach(page,via,'save-in-place-image','guardar foto de la misma pieza',save);
      expect((await readDraft()).assetId).toBe(manualId);
      await save.click();
      await expect.poll(async()=>(await readDraft()).assetId).toBe(photo);
      expect(socialWrites.slice(offset)).toEqual([['PATCH',`${campaigns}/${same.id}`,expect.objectContaining({assetId:photo,aiDisclosure:false})]]);
      expect(await readDraft()).toMatchObject({state:'draft',operations:[],changeDraft:{variable:'asset',deliveryId:paused.deliveryId,budget:source.deliveries[0].budgetSnapshot}});
      const after=await getSocialCampaign(store,source.id);
      expect(after.deliveries).toEqual(source.deliveries);
      expect(after.operations).toEqual(source.operations);
      editablePhotoDraft=null;
    });
    expect(assistantBodies.length).toBeGreaterThan(0);
    for (const body of assistantBodies) expect(body).not.toContain('aiDisclosure');
    expect(external).toEqual([]);
  } finally {
    await context?.close();
    await store?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
