import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { createBrowserClient } from '../social/browser-client.mjs';
import { queueJobTx, finishJob, withLeaseHeartbeat, LEASE_MILLISECONDS } from './job-leases.mjs';
import { fail, integer, text } from '../validation-core.mjs';
import { entity, hash, newId, stamp, insertRow, updateVersioned, audit, runCommand, assertLease } from './commands.mjs';
import { getSocialConnection, listSocialConnections } from './social.mjs';
import { aggregateSocialCampaignState, queueSocialBrowserJobTx } from './social-jobs.mjs';
import { requireIntegration, socialConfig, secretKey } from '../social/config.mjs';
import { encryptCredentials, decryptCredentials } from '../social/credentials.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { createMetaClient } from '../social/meta.mjs';
import { withBrowserSession } from './social-browser.mjs';

export const SOCIAL_CONNECTION_RETURN_PATH = '/admin?section=advertising&tab=connections';
const capabilityKeys = ['facebookPublish', 'instagramPublish', 'adsPublish', 'insights', 'whatsappAds'];
const identityKeys = ['userId', 'userName', 'businessId', 'pageId', 'instagramId', 'adAccountId'];
const selectionKeys = ['businessId', 'pageId', 'instagramId', 'adAccountId'];
const noCapabilities = () => Object.fromEntries(capabilityKeys.map(key => [key, false]));
const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const dataOf = row => JSON.parse(row.data || '{}');
function assertSession(session, now) {
  if (!session?.user?.id || !session.csrf || !(session.expires > Date.parse(now))) fail('La sesión administrativa venció. Inicia sesión y reinicia la conexión.', 401);
}
function assertVersion(connection, version) {
  integer(version, 'Versión', 1);
  if (connection.version !== version) fail('La conexión cambió en otra sesión. Recarga antes de continuar.', 409);
}
function recordData(connection) {
  const { id, provider, integrationMethod, state, version, createdAt, updatedAt, ...data } = connection;
  return data;
}
function discoveredData(result) {
  return {
    identities: pick(result.identities, identityKeys),
    resources: {
      businesses: (result.resources?.businesses || []).map(resource => pick(resource, ['id', 'name'])),
      pages: (result.resources?.pages || []).map(resource => pick(resource, ['id', 'name', 'tasks', 'businessId', 'instagramId', 'whatsappNumber'])),
      adAccounts: (result.resources?.adAccounts || []).map(resource => pick(resource, ['id', 'name', 'currency', 'timeZone', 'businessId', 'accountStatus', 'tasks']))
    },
    capabilities: Object.fromEntries(capabilityKeys.map(key => [key, result.capabilities?.[key] === true])),
    currency: result.currency || null, timeZone: result.timeZone || null,
    expiresAt: result.expiresAt || null, validatedAt: result.validatedAt || null,
    locale: result.locale || null, adapterVersion: result.adapterVersion || null,
    resourceNotice: result.resourceNotice || (!result.resources?.pages?.length && !result.resources?.adAccounts?.length ? 'No se encontraron recursos profesionales elegibles.' : null),
    permissions: Array.isArray(result.permissions) ? result.permissions.filter(value => typeof value === 'string') : []
  };
}
export function socialConnectionDTO(connection) {
  const pending = connection.disconnectPending;
  const disconnectStatus = pending && ['waiting_for_pause', 'needs_confirmation'].includes(pending.state) && ['disconnect', 'delete-platform-data'].includes(pending.action)
    ? { ...pick(pending, ['state', 'action', 'requestedAt', 'receiptId']), ...(['SPEC_MISMATCH', 'PERMISSION_REQUIRED'].includes(pending.errorCode) ? { errorCode: pending.errorCode } : {}) } : null;
  return { ...pick(connection, ['id', 'provider', 'integrationMethod', 'state', 'name', 'version', 'createdAt', 'updatedAt', 'sessionEpoch']), ...discoveredData(connection), disconnectStatus };
}
export async function getSocialConnections(store, options = {}) {
  const result = await listSocialConnections(store, options);
  const requirements = result.requirements.find(item => item.integrationMethod === 'browser');
  const browserRunner = { status: !requirements.enabled ? 'disabled' : !requirements.configured ? 'unconfigured' : 'unavailable', checkedAt: options.now || stamp() };
  if (requirements.enabled && requirements.configured) {
    const env = options.env || process.env;
    const client = options.client || createBrowserClient({ baseUrl: socialConfig(env).browserUrl, controlKey: secretKey('SOCIAL_BROWSER_CONTROL_KEY', env) });
    browserRunner.status = await client.health() ? 'available' : 'unavailable';
  }
  return { ...result, browserRunner, connections: result.connections.map(socialConnectionDTO) };
}
export async function startSocialOAuth(store, input, session, { env = process.env, now = stamp() } = {}) {
  assertSession(session, now);
  const config = requireIntegration('api', env);
  const connectionId = input?.connectionId ? text(input.connectionId, 'Conexión', 100, true) : null;
  const state = randomBytes(32).toString('base64url');
  await store.transaction(async tx => {
    await tx.lockWrites();
    if (connectionId) {
      const connection = await getSocialConnection(tx, connectionId);
      if (connection.integrationMethod !== 'api') fail('La vía de una conexión no se puede cambiar.', 409);
    }
    await insertRow(tx, 'social_oauth_states', { state_hash: hash(state), actor_id: session.user.id, csrf_hash: hash(session.csrf), connection_id: connectionId, expires_at: new Date(Date.parse(now) + 600000).toISOString(), consumed_at: null });
  });
  const url = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  url.search = new URLSearchParams({ client_id: env.META_APP_ID, config_id: env.META_LOGIN_CONFIG_ID, response_type: 'code', redirect_uri: `${config.appUrl}/api/admin/social/oauth/callback`, state }).toString();
  return { authorizationUrl: url.href, expiresAt: new Date(Date.parse(now) + 600000).toISOString() };
}
export async function consumeSocialOAuthState(store, state, session, { now = stamp() } = {}) {
  assertSession(session, now);
  if (typeof state !== 'string' || !/^[\w-]{43}$/.test(state)) fail('Estado OAuth no válido. Reinicia la conexión.', 403);
  return store.transaction(async tx => {
    await tx.lockWrites();
    const row = await tx.db.get(`SELECT * FROM ${tx.t('social_oauth_states')} WHERE state_hash=?`, [hash(state)]);
    if (!row || row.consumed_at || row.expires_at <= now || row.actor_id !== session.user.id || row.csrf_hash !== hash(session.csrf)) fail('La conexión venció o pertenece a otra sesión. Reinicia OAuth.', 403);
    const changed = await tx.db.run(`UPDATE ${tx.t('social_oauth_states')} SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?`, [now, row.state_hash, now]);
    if (!changed.changes) fail('Esta conexión OAuth ya se completó. Reinicia el flujo.', 409);
    const connection = row.connection_id ? await getSocialConnection(tx, row.connection_id) : null;
    const credentials = connection ? await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]) : null;
    return { connection, credentialVersion: credentials?.version || 0 };
  });
}
async function storeTokenTx(tx, connection, credentials, env) {
  const sealed = encryptCredentials(connection, credentials, env);
  const prior = await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  if (prior) await tx.db.run(`UPDATE ${tx.t('social_credentials')} SET ciphertext=?,iv=?,auth_tag=?,version=version+1,updated_at=? WHERE connection_id=? AND version=?`, [sealed.ciphertext, sealed.iv, sealed.auth_tag, stamp(), connection.id, prior.version]);
  else await insertRow(tx, 'social_credentials', { connection_id: connection.id, ...sealed, version: 1, updated_at: stamp() });
}
async function credentialSnapshot(store, connection, env) {
  const row = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  return { value: decryptCredentials(connection, row, env), version: row?.version || 0 };
}
async function assertCredentialVersion(tx, id, expectedVersion) {
  const row = await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [id]);
  if ((row?.version || 0) !== expectedVersion) fail('Las credenciales cambiaron durante la operación. Recarga la conexión.', 409);
}
function assertPinnedIdentity(connection, result) {
  for (const key of ['userId', ...selectionKeys]) {
    if (connection.identities?.[key] && result.identities?.[key] !== connection.identities[key]) fail('La identidad Meta cambió. Conserva esta conexión y crea otra para la nueva cuenta.', 409);
  }
}
function connectorFor(connection, credentials, options) {
  return (options.connectorFactory || createSocialConnector)({ connection: { ...connection, data: recordData(connection) }, credentials, transport: { browserClient: options.browserSession?.client, appId: options.env?.META_APP_ID, appSecret: options.env?.META_APP_SECRET, graphVersion: options.env?.META_GRAPH_VERSION || 'v26.0', fetchImpl: options.fetchImpl, now: typeof options.now === 'string' ? Date.parse(options.now) : options.now } });
}
export async function completeSocialOAuth(store, input, session, options = {}) {
  const env = options.env || process.env, now = options.now || stamp();
  const config = requireIntegration('api', env);
  const { connection: existing, credentialVersion } = await consumeSocialOAuthState(store, input?.state, session, { now });
  if (input.error) fail('Meta no autorizó la conexión. La conexión anterior no se modificó.');
  const code = text(input.code, 'Código OAuth', 4096, true);
  const client = createMetaClient({ appSecret: env.META_APP_SECRET, graphVersion: config.graphVersion, fetchImpl: options.fetchImpl });
  const exchanged = await client.exchangeCode({ code, appId: env.META_APP_ID, redirectUri: `${config.appUrl}/api/admin/social/oauth/callback`, signal: options.signal });
  const longLived = await client.exchangeLongLivedToken({ accessToken: exchanged.accessToken, appId: env.META_APP_ID, signal: options.signal });
  const credentials = { ...longLived, pageTokens: {} };
  const candidate = existing || { id: newId(), provider: 'meta', integrationMethod: 'api', state: 'connected', sessionEpoch: 0, identities: {} };
  const connector = await connectorFor(candidate, credentials, { ...options, env, now });
  const result = await connector.validateConnection({ signal: options.signal });
  if (result.state !== 'connected') fail('Meta requiere volver a autorizar la conexión.', 409);
  if (existing) assertPinnedIdentity(existing, result);
  return store.transaction(async tx => {
    await tx.lockWrites();
    assertSession(session, options.now || stamp());
    if (existing) assertVersion(await getSocialConnection(tx, existing.id), existing.version);
    if (existing) await assertCredentialVersion(tx, existing.id, credentialVersion);
    const data = { ...(existing ? recordData(existing) : {}), ...discoveredData(result), sessionEpoch: (candidate.sessionEpoch || 0) + 1 };
    if (existing) await updateVersioned(tx, 'social_connections', existing.id, existing.version, { state: 'connected', data: JSON.stringify(data) });
    else await insertRow(tx, 'social_connections', { id: candidate.id, provider: 'meta', integration_method: 'api', state: 'connected', data: JSON.stringify(data), version: 1, created_at: now, updated_at: now });
    const current = await getSocialConnection(tx, candidate.id);
    await storeTokenTx(tx, current, { ...credentials, ...(result.credentials || {}) }, env);
    await audit(tx, { entityType: 'social_connection', entityId: current.id, actorId: session.user.id, next: { state: current.state, integrationMethod: 'api' }, reason: existing ? 'Reconexión OAuth verificada' : 'Conexión OAuth verificada' });
    return { connection: socialConnectionDTO(current), redirectTo: SOCIAL_CONNECTION_RETURN_PATH };
  });
}
export async function createBrowserSocialConnection(store, input, actorId) {
  if (input.integrationMethod !== 'browser') fail('Las conexiones API se crean mediante OAuth.');
  const name = text(input.name, 'Nombre', 200, true);
  return runCommand(store, { scope: 'social:connection:create', requestId: input.requestId, payload: { name, integrationMethod: 'browser' }, actorId, affectsIndicators: false }, async tx => {
    const now = stamp(), id = newId();
    await insertRow(tx, 'social_connections', { id, provider: 'meta', integration_method: 'browser', state: 'login_required', data: JSON.stringify({ name, identities: {}, capabilities: noCapabilities(), sessionEpoch: 0 }), version: 1, created_at: now, updated_at: now });
    await audit(tx, { entityType: 'social_connection', entityId: id, actorId, next: { state: 'login_required', integrationMethod: 'browser' } });
    return socialConnectionDTO(await getSocialConnection(tx, id));
  });
}
function selectedCandidate(connection, input, resources) {
  const identities = { ...connection.identities };
  for (const key of selectionKeys) {
    if (Object.hasOwn(input, key)) {
      if (input[key] !== null && typeof input[key] !== 'string') fail('Identidad Meta no válida.');
      if (input[key]) identities[key] = text(input[key], 'Identidad Meta', 100, true);
      else delete identities[key];
    }
  }
  const find = (list, id) => (list || []).find(item => item.id === id);
  const business = identities.businessId && find(resources.businesses, identities.businessId);
  const page = identities.pageId && find(resources.pages, identities.pageId);
  const account = identities.adAccountId && find(resources.adAccounts, identities.adAccountId);
  if (identities.businessId && !business || identities.pageId && !page || identities.adAccountId && !account) fail('Selecciona únicamente recursos comprobados de esta conexión.');
  if (identities.instagramId && page?.instagramId !== identities.instagramId) fail('La cuenta Instagram no pertenece a la página seleccionada.');
  if (business && (page?.businessId && page.businessId !== business.id || account?.businessId && account.businessId !== business.id)) fail('Los recursos no pertenecen al negocio seleccionado.');
  return { ...connection, identities };
}
async function graphFor(store, id) {
  const campaigns = await store.db.all(`SELECT * FROM ${store.t('social_campaigns')} WHERE connection_id=?`, [id]);
  const deliveries = [], operations = [], recommendations = [], measurements = [], forecasts = [], revisions = [], orderLinks = [], expenseLinks = [];
  for (const campaign of campaigns) {
    for (const [table, target] of [['social_deliveries', deliveries], ['social_operations', operations], ['social_recommendations', recommendations], ['social_forecasts', forecasts], ['social_revisions', revisions], ['social_order_links', orderLinks], ['social_expense_links', expenseLinks]]) target.push(...await store.db.all(`SELECT * FROM ${store.t(table)} WHERE campaign_id=?`, [campaign.id]));
  }
  for (const delivery of deliveries) measurements.push(...await store.db.all(`SELECT * FROM ${store.t('social_measurements')} WHERE delivery_id=?`, [delivery.id]));
  return { campaigns, deliveries, operations, recommendations, measurements, forecasts, revisions, orderLinks, expenseLinks };
}
function countsOf(graph) { return Object.fromEntries(Object.entries(graph).map(([key, rows]) => [key, rows.length])); }
export async function previewSocialConnectionDeletion(store, id) { return { counts: countsOf(await graphFor(store, id)), warning: 'Eliminar datos locales no elimina publicaciones ni detiene anuncios en Meta.' }; }
function references(value, ids) {
  if (typeof value === 'string') return [...ids].some(id => value.includes(id));
  if (Array.isArray(value)) return value.some(item => references(item, ids));
  return value && typeof value === 'object' ? Object.values(value).some(item => references(item, ids)) : false;
}
function graphIds(connectionId, graph) {
  return new Set([connectionId, ...Object.values(graph).flat().map(row => row.id).filter(Boolean)]);
}
async function cancelLocalTx(tx, connection, graph, { deleting = false } = {}) {
  const now = stamp(), ids = graphIds(connection.id, graph);
  const jobs = await tx.db.all(`SELECT * FROM ${tx.t('job_runs')} WHERE key LIKE 'social:%'`);
  for (const job of jobs) {
    if (!references(job.key, ids) && !references(dataOf(job), ids)) continue;
    if (deleting) await tx.db.run(`DELETE FROM ${tx.t('job_runs')} WHERE key=?`, [job.key]);
    else await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='failed',lease_token=NULL,lease_until=NULL,error_code='SOCIAL_DISCONNECTED',data='{}',finished_at=?,updated_at=?,version=version+1 WHERE key=?`, [now, now, job.key]);
  }
  for (const operation of graph.operations) {
    if (operation.state === 'sent') await updateVersioned(tx, 'social_operations', operation.id, operation.version, { state: 'uncertain', next_attempt_at: null });
    else if (['prepared', 'retry_wait'].includes(operation.state)) await updateVersioned(tx, 'social_operations', operation.id, operation.version, { state: 'failed', next_attempt_at: null });
  }
  for (const delivery of graph.deliveries) {
    if (delivery.state === 'paused' && dataOf(delivery).lastConfirmedState === 'paused') continue;
    const uncertain = graph.operations.some(op => op.delivery_id === delivery.id && ['sent', 'uncertain'].includes(op.state));
    if (uncertain || ['publishing', 'uncertain'].includes(delivery.state)) await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state: 'uncertain', next_sync_at: null });
    else if (['queued', 'preparing', 'ready', 'scheduled', 'blocked'].includes(delivery.state)) await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { state: 'cancelled', next_sync_at: null });
  }
  for (const campaign of graph.campaigns) {
    const states = await tx.db.all(`SELECT state FROM ${tx.t('social_deliveries')} WHERE campaign_id=?`, [campaign.id]);
    const state = aggregateSocialCampaignState(states, campaign.mode);
    if (state && state !== campaign.state) await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state });
  }
  await tx.db.run(`UPDATE ${tx.t('social_browser_controls')} SET state='cancelled',updated_at=? WHERE connection_id=? AND state='active'`, [now, connection.id]);
  await tx.db.run(`DELETE FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connection.id]);
  await tx.db.run(`DELETE FROM ${tx.t('social_oauth_states')} WHERE connection_id=?`, [connection.id]);
}
async function closeBrowser(connection, options) {
  if (connection.integrationMethod !== 'browser') return;
  const env = options.env || process.env;
  if (!env.SOCIAL_BROWSER_CONTROL_KEY) return;
  try {
    const client = options.client || createBrowserClient({ baseUrl: socialConfig(env).browserUrl, controlKey: secretKey('SOCIAL_BROWSER_CONTROL_KEY', env), fetchImpl: options.fetchImpl });
    await client.close({ connectionId: connection.id, sessionEpoch: connection.sessionEpoch || 0, lease: options.closeLease });
  } catch { /* Local epoch and lease revocation remain authoritative if the runner is offline. */ }
}
async function activeAds(store, graph) {
  return graph.deliveries.filter(delivery => delivery.channel === 'meta_ads' && ['active', 'in_review', 'publishing', 'uncertain', 'scheduled'].includes(delivery.state));
}
async function pauseAds(store, connection, graph, input, actorId, options) {
  const active = await activeAds(store, graph);
  if (!active.length) return false;
  if (!input.pauseAndDisconnect) {
    if (input.acceptActiveAdsWarning !== true) fail('Hay anuncios que podrían seguir gastando. Pausa y desconecta o acepta detenerlos directamente en Meta.', 409);
    return false;
  }
  if (connection.integrationMethod !== 'api') fail('La pausa del navegador requiere el adaptador operativo. Detén los anuncios en Meta antes de desconectar.', 409);
  const snapshot = await credentialSnapshot(store, connection, options.env || process.env), credentials = snapshot.value;
  if (!credentials?.accessToken) fail('No hay permiso para verificar una pausa. Detén los anuncios en Meta.', 409);
  const client = createMetaClient({ accessToken: credentials.accessToken, appSecret: (options.env || process.env).META_APP_SECRET, fetchImpl: options.fetchImpl });
  for (const delivery of active) {
    const refs = dataOf(delivery).remoteRefs || {}, remoteId = refs.campaignId;
    if (!remoteId) fail('No se puede identificar inequívocamente la campaña remota. Detén los anuncios en Meta.', 409);
    const key = `social:delivery:${delivery.id}`;
    const lease = await store.transaction(async tx => {
      await tx.lockWrites();
      assertVersion(await getSocialConnection(tx, connection.id), input.version);
      await queueJobTx(tx, key, { kind: 'delivery', id: delivery.id, nextRunAt: stamp() });
      const now = stamp(), token = newId(), leaseUntil = new Date(Date.parse(now) + LEASE_MILLISECONDS).toISOString();
      await tx.db.run(`UPDATE ${tx.t('job_runs')} SET state='running',lease_token=?,lease_until=?,started_at=?,version=version+1,updated_at=? WHERE key=?`, [token, leaseUntil, now, now, key]);
      return { key, token, leaseUntil };
    });
    const operationId = newId(), step = `pause:${input.requestId}`;
    let prepared = false, sent = false, confirmed = false;
    try {
      await withLeaseHeartbeat(store, lease, async ({ assertActive }) => {
        const remote = await client.get(remoteId, { fields: 'id,account_id,status,effective_status' });
        const accountId = String(connection.identities?.adAccountId || '').replace(/^act_/, '');
        if (remote.id !== remoteId || !accountId || String(remote.account_id) !== accountId) fail('La campaña remota no pertenece a la cuenta verificada.', 409);
        await store.transaction(async tx => {
          await tx.lockWrites();
          await assertLease(tx, lease);
          assertVersion(await getSocialConnection(tx, connection.id), input.version);
          await assertCredentialVersion(tx, connection.id, snapshot.version);
          if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado para pausar.', 403);
          const currentDelivery = await tx.db.get(`SELECT * FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id]);
          const revision = await tx.db.get(`SELECT spec_hash FROM ${tx.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [delivery.campaign_id, currentDelivery.revision]);
          if (!revision) fail('No se puede verificar el historial de esta campaña; detén el gasto directamente en Meta.', 409);
          await updateVersioned(tx, 'social_deliveries', delivery.id, currentDelivery.version, { data: JSON.stringify({ ...dataOf(currentDelivery), controlIntent: { id: input.requestId, kind: 'pause', actorId, requestedAt: stamp() } }) });
          const prior = await tx.db.get(`SELECT state FROM ${tx.t('social_operations')} WHERE delivery_id=? AND step=?`, [delivery.id, step]);
          if (prior) fail('La pausa ya se envió. Reconcilia su estado antes de repetirla.', 409);
          const now = stamp();
          await insertRow(tx, 'social_operations', { id: operationId, campaign_id: delivery.campaign_id, delivery_id: delivery.id, operation_key: `delivery:${delivery.id}:${step}`, step, state: 'prepared', next_attempt_at: null, data: JSON.stringify({ integrationMethod: 'api', requestedState: 'PAUSED', actorId, channel: 'meta_ads', specHash: revision.spec_hash, controlId: input.requestId, progress: { controlStage: 'campaign' }, payloadHash: hash({ campaignId: remoteId, status: 'PAUSED' }) }), version: 1, created_at: now, updated_at: now });
        });
        prepared = true;
        await store.transaction(async tx => {
          await tx.lockWrites();
          await assertLease(tx, lease);
          assertVersion(await getSocialConnection(tx, connection.id), input.version);
          await assertCredentialVersion(tx, connection.id, snapshot.version);
          if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado para pausar.', 403);
          const operation = await tx.db.get(`SELECT data FROM ${tx.t('social_operations')} WHERE id=?`, [operationId]);
          await updateVersioned(tx, 'social_operations', operationId, 1, { state: 'sent', data: JSON.stringify({ ...dataOf(operation), sentAt: stamp() }) });
        });
        sent = true;
        await client.post(remoteId, { status: 'PAUSED' });
        const observed = await client.get(remoteId, { fields: 'id,status,effective_status' });
        assertActive();
        if (observed.id !== remoteId || observed.status !== 'PAUSED' || !['PAUSED', 'CAMPAIGN_PAUSED'].includes(observed.effective_status)) fail('Meta no confirmó la pausa. Verifica el gasto directamente en Meta.', 409);
        await store.transaction(async tx => {
          await tx.lockWrites();
          await assertLease(tx, lease);
          assertVersion(await getSocialConnection(tx, connection.id), input.version);
          await assertCredentialVersion(tx, connection.id, snapshot.version);
          await updateVersioned(tx, 'social_operations', operationId, 2, { state: 'confirmed' });
          const current = await tx.db.get(`SELECT version,data FROM ${tx.t('social_deliveries')} WHERE id=?`, [delivery.id]);
          await updateVersioned(tx, 'social_deliveries', delivery.id, current.version, { state: 'paused', next_sync_at: null, data: JSON.stringify({ ...dataOf(current), lastConfirmedState: 'paused', lastConfirmedAt: stamp(), lastConfirmedEvidence: { remoteRead: true } }) });
          const campaign = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_campaigns')} WHERE id=?`, [delivery.campaign_id]));
          const deliveries = (await tx.db.all(`SELECT state FROM ${tx.t('social_deliveries')} WHERE campaign_id=?`, [campaign.id]));
          await updateVersioned(tx, 'social_campaigns', campaign.id, campaign.version, { state: aggregateSocialCampaignState(deliveries, campaign.mode) });
          await audit(tx, { entityType: 'social_operation', entityId: operationId, actorId, next: { state: 'confirmed' }, reason: 'Pausa remota comprobada antes de desconexión' });
        });
        confirmed = true;
      });
    } finally {
      if (sent && !confirmed) await store.transaction(async tx => {
        await tx.lockWrites();
        await tx.db.run(`UPDATE ${tx.t('social_operations')} SET state='uncertain',version=version+1,updated_at=? WHERE id=? AND state='sent'`, [stamp(), operationId]);
      });
      if (prepared && !sent) await store.transaction(async tx => {
        await tx.lockWrites();
        await tx.db.run(`UPDATE ${tx.t('social_operations')} SET state='failed',version=version+1,updated_at=? WHERE id=? AND state='prepared'`, [stamp(), operationId]);
      });
      try { await finishJob(store, lease, { state: confirmed ? 'succeeded' : 'failed', errorCode: confirmed ? null : 'PAUSE_UNCONFIRMED' }); }
      catch (error) { if (error.status !== 409) throw error; }
    }
  }
  return true;
}
async function deleteGraphTx(tx, connection, graph, actorId, remoteSpendStopped, receiptId = newId()) {
  const ids = graphIds(connection.id, graph), counts = countsOf(graph);
  const removedRecommendations = new Set(graph.recommendations.map(row => row.id)), removedCampaigns = new Set(graph.campaigns.map(row => row.id));
  for (const row of await tx.db.all(`SELECT * FROM ${tx.t('social_campaigns')} WHERE state='draft'`)) {
    if (removedCampaigns.has(row.id)) continue;
    const data = dataOf(row);
    if (!removedCampaigns.has(data.parentCampaignId) && !removedRecommendations.has(data.sourceRecommendationId)) continue;
    if (removedCampaigns.has(data.parentCampaignId)) delete data.parentCampaignId;
    if (removedRecommendations.has(data.sourceRecommendationId)) delete data.sourceRecommendationId;
    await updateVersioned(tx, 'social_campaigns', row.id, row.version, { data: JSON.stringify(data) });
  }
  for (const delivery of graph.deliveries) await tx.db.run(`DELETE FROM ${tx.t('social_measurements')} WHERE delivery_id=?`, [delivery.id]);
  for (const campaign of graph.campaigns) {
    for (const table of ['social_order_links', 'social_expense_links', 'social_recommendations', 'social_forecasts', 'social_operations', 'social_deliveries', 'social_revisions']) await tx.db.run(`DELETE FROM ${tx.t(table)} WHERE campaign_id=?`, [campaign.id]);
    await tx.db.run(`DELETE FROM ${tx.t('social_campaigns')} WHERE id=?`, [campaign.id]);
  }
  await tx.db.run(`DELETE FROM ${tx.t('social_browser_controls')} WHERE connection_id=?`, [connection.id]);
  await tx.db.run(`DELETE FROM ${tx.t('social_connections')} WHERE id=?`, [connection.id]);
  for (const row of await tx.db.all(`SELECT * FROM ${tx.t('business_requests')} WHERE scope LIKE 'social:%'`)) {
    if (references(row.scope, ids) || references(JSON.parse(row.result_json), ids)) await tx.db.run(`DELETE FROM ${tx.t('business_requests')} WHERE scope=? AND request_id=?`, [row.scope, row.request_id]);
  }
  for (const row of await tx.db.all(`SELECT * FROM ${tx.t('business_audit')} WHERE entity_type LIKE 'social_%'`)) {
    if (row.entity_type.startsWith('social_') && (ids.has(row.entity_id) || references(dataOf(row), ids))) await tx.db.run(`DELETE FROM ${tx.t('business_audit')} WHERE id=?`, [row.id]);
  }
  const receipt = { receiptId, deletedAt: stamp(), counts, remoteContentDeleted: false, remoteSpendStopped };
  await audit(tx, { entityType: 'social_deletion_receipt', entityId: receipt.receiptId, actorId, next: receipt, reason: 'Eliminación administrativa de datos locales de plataforma' });
  return receipt;
}
export async function socialConnectionAction(store, id, action, input, actorId, options = {}) {
  if (!['select-assets', 'validate', 'disconnect', 'delete-platform-data', 'preview-delete-platform-data'].includes(action)) fail('Acción de conexión no válida.');
  if (action === 'preview-delete-platform-data') {
    await getSocialConnection(store, id);
    return previewSocialConnectionDeletion(store, id);
  }
  if (typeof input.requestId !== 'string' || !/^[\w:-]{8,100}$/.test(input.requestId)) fail('Identificador de operación no válido.');
  const command = { scope: `social:connection:${id}:${action}`, requestId: input.requestId, payload: { action, ...input }, actorId, affectsIndicators: false };
  const prior = await store.db.get(`SELECT request_id FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`, [command.scope, input.requestId]);
  if (prior) return runCommand(store, command, () => fail('La operación ya terminó.', 409));
  const connection = await getSocialConnection(store, id);
  assertVersion(connection, input.version);
  if (connection.integrationMethod === 'browser' && ['select-assets', 'validate'].includes(action) && !options.browserSession) {
    return withBrowserSession(store, id, { ...options, owner: actorId, purpose: 'validate' }, browserSession =>
      socialConnectionAction(store, id, action, input, actorId, { ...options, browserSession, signal: browserSession.signal }));
  }
  let closeLease = null;
  const env = options.env || process.env;
  let result = null, paused = false, credentialVersion = null, expectedDeletionCounts = input.confirmCounts;
  if (['select-assets', 'validate'].includes(action)) {
    const snapshot = await credentialSnapshot(store, connection, env), credentials = snapshot.value;
    credentialVersion = snapshot.version;
    if (!credentials) fail('La conexión necesita autenticarse de nuevo.', 409);
    let discovery;
    try { discovery = await (await connectorFor(connection, credentials, { ...options, env })).validateConnection({ signal: options.signal }); }
    catch (error) {
      if (error.kind !== 'reconnect_required') throw error;
      discovery = { ...discoveredData(connection), state: 'reconnect_required', capabilities: noCapabilities() };
    }
    if (action === 'select-assets' && discovery.state === 'connected') {
      const candidate = selectedCandidate(connection, input.identities || input, discovery.resources || {});
      const approved = await store.db.get(`SELECT r.campaign_id FROM ${store.t('social_revisions')} r JOIN ${store.t('social_campaigns')} c ON c.id=r.campaign_id WHERE c.connection_id=? LIMIT 1`, [id]);
      if (approved && selectionKeys.some(key => candidate.identities?.[key] !== connection.identities?.[key])) fail('Una conexión con aprobaciones no cambia sus recursos. Crea otra conexión.', 409);
      result = await (await connectorFor(candidate, { ...credentials, ...(discovery.credentials || {}) }, { ...options, env })).validateConnection({ signal: options.signal, selectAssets: connection.integrationMethod === 'browser' });
      for (const key of selectionKeys) if (candidate.identities?.[key] && result.identities?.[key] !== candidate.identities[key]) fail('Meta no confirmó los recursos seleccionados.', 409);
    } else result = discovery;
    if (action === 'validate' && result.state === 'connected') assertPinnedIdentity(connection, result);
  } else {
    credentialVersion = (await store.db.get(`SELECT version FROM ${store.t('social_credentials')} WHERE connection_id=?`, [id]))?.version || 0;
    const graph = await graphFor(store, id);
    if (action === 'delete-platform-data' && (input.confirmDelete !== true || !input.confirmCounts || hash(input.confirmCounts) !== hash(countsOf(graph)))) fail('Confirma las cantidades actuales de campañas y evidencia antes de eliminar.', 409);
    if (connection.integrationMethod === 'browser' && input.pauseAndDisconnect === true && (await activeAds(store, graph)).length) return queueBrowserDisconnect(store, connection, action, input, actorId, { ...options, env }, command);
    paused = await pauseAds(store, connection, graph, input, actorId, options);
    if (!paused && connection.disconnectPending?.deliveryIds?.length && connection.disconnectPending.deliveryIds.every(deliveryId => {
      const delivery = graph.deliveries.find(value => value.id === deliveryId);
      return delivery && ['paused', 'cancelled'].includes(delivery.state) && dataOf(delivery).lastConfirmedState === 'paused';
    })) paused = true;
    if (paused && action === 'delete-platform-data') expectedDeletionCounts = { ...input.confirmCounts, operations: input.confirmCounts.operations + (await activeAds(store, graph)).length };
  }
  if (options.browserSession) command.lease = { ...options.browserSession.lease, now: options.browserSession.clock() };
  const response = await runCommand(store, command, async tx => {
    if (options.browserSession) {
      await assertLease(tx, { ...options.browserSession.lease, now: options.browserSession.clock() });
      if ((await getSocialConnection(tx, id)).sessionEpoch !== options.browserSession.sessionEpoch) fail('La sesión social fue sustituida.', 409);
    }
    const current = await getSocialConnection(tx, id); assertVersion(current, input.version);
    await assertCredentialVersion(tx, id, credentialVersion);
    if (result) {
      const data = { ...recordData(current), ...discoveredData(result) };
      await updateVersioned(tx, 'social_connections', id, current.version, { state: result.state, data: JSON.stringify(data) });
      if (result.credentials) await storeTokenTx(tx, await getSocialConnection(tx, id), result.credentials, env);
      if (result.state === 'reconnect_required') await cancelLocalTx(tx, current, await graphFor(tx, id));
      await audit(tx, { entityType: 'social_connection', entityId: id, actorId, previous: { state: current.state }, next: { state: result.state }, reason: action });
      return socialConnectionDTO(await getSocialConnection(tx, id));
    }
    const graph = await graphFor(tx, id);
    if (action === 'delete-platform-data' && hash(expectedDeletionCounts) !== hash(countsOf(graph))) fail('La evidencia cambió. Revisa y confirma las cantidades otra vez.', 409);
    const disconnected = recordData(current);
    delete disconnected.disconnectPending;
    if (current.integrationMethod === 'browser') {
      const lock = await tx.db.get(`SELECT key,lease_token,lease_until FROM ${tx.t('job_runs')} WHERE key=?`, [`social:browser-lock:${id}`]);
      closeLease = lock?.lease_token ? { key: lock.key, token: lock.lease_token, leaseUntil: lock.lease_until } : null;
    }
    await cancelLocalTx(tx, current, graph, { deleting: action === 'delete-platform-data' });
    if (action === 'delete-platform-data') {
      await updateVersioned(tx, 'social_connections', id, current.version, { state: 'disconnected', data: JSON.stringify({ ...disconnected, sessionEpoch: (current.sessionEpoch || 0) + 1 }) });
      return deleteGraphTx(tx, current, graph, actorId, paused, current.disconnectPending?.receiptId);
    }
    await updateVersioned(tx, 'social_connections', id, current.version, { state: 'disconnected', data: JSON.stringify({ ...disconnected, capabilities: noCapabilities(), sessionEpoch: (current.sessionEpoch || 0) + 1 }) });
    await audit(tx, { entityType: 'social_connection', entityId: id, actorId, next: { state: 'disconnected', remoteSpendStopped: paused }, reason: 'Desconexión local; no elimina contenido remoto' });
    return { connection: socialConnectionDTO(await getSocialConnection(tx, id)), remoteSpendStopped: paused, warning: paused ? null : 'La desconexión local no confirma que los anuncios hayan dejado de gastar. Verifica y detenlos en Meta.' };
  });
  if (!result && closeLease) await closeBrowser(connection, { ...options, closeLease });
  return response;
}
export function verifyMetaSignedRequest(signedRequest, appSecret, { now = stamp() } = {}) {
  if (typeof appSecret !== 'string' || !appSecret) fail('META_APP_SECRET no está configurado.', 409);
  if (typeof signedRequest !== 'string' || signedRequest.length > 16384) fail('Firma Meta no válida.', 403);
  const parts = signedRequest.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) fail('Firma Meta no válida.', 403);
  const expected = createHmac('sha256', appSecret).update(parts[1]).digest(), received = Buffer.from(parts[0], 'base64url');
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail('Firma Meta no válida.', 403);
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { fail('Firma Meta no válida.', 403); }
  if (!payload || payload.algorithm !== 'HMAC-SHA256' || typeof payload.user_id !== 'string' || !/^\d{1,100}$/.test(payload.user_id) || !Number.isSafeInteger(payload.issued_at) || payload.issued_at < 0 || payload.issued_at * 1000 > Date.parse(now) + 30000) fail('Solicitud Meta no válida.', 403);
  return { userId: payload.user_id };
}
export async function deauthorizeSocialMeta(store, signedRequest, { env = process.env, now = stamp() } = {}) {
  const { userId } = verifyMetaSignedRequest(signedRequest, env.META_APP_SECRET, { now });
  await store.transaction(async tx => {
    await tx.lockWrites();
    const rows = await tx.db.all(`SELECT * FROM ${tx.t('social_connections')} WHERE integration_method='api'`);
    for (const row of rows) {
      const connection = entity(row);
      if (connection.identities?.userId !== userId) continue;
      const graph = await graphFor(tx, row.id);
      await cancelLocalTx(tx, connection, graph);
      if (connection.state === 'reconnect_required' && capabilityKeys.every(key => !connection.capabilities?.[key])) continue;
      await updateVersioned(tx, 'social_connections', row.id, row.version, { state: 'reconnect_required', data: JSON.stringify({ ...recordData(connection), capabilities: noCapabilities(), sessionEpoch: (connection.sessionEpoch || 0) + 1 }) });
      await audit(tx, { entityType: 'social_connection', entityId: row.id, actorId: 'meta:deauthorization', next: { state: 'reconnect_required', remoteSpendStopped: false }, reason: 'Revocación de permisos API comunicada por Meta' });
    }
  });
  return { success: true };
}

async function queueBrowserDisconnect(store, connection, action, input, actorId, { env }, command) {
  requireIntegration('browser', env);
  return runCommand(store, command, async tx => {
    await tx.lockWrites();
    if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
    const current = await getSocialConnection(tx, connection.id); assertVersion(current, input.version);
    const graph = await graphFor(tx, current.id), active = await activeAds(tx, graph);
    if (!active.length) fail('Los anuncios cambiaron; recarga la conexión para confirmar su desconexión.', 409);
    if (action === 'delete-platform-data' && (input.confirmDelete !== true || hash(input.confirmCounts || null) !== hash(countsOf(graph)))) fail('Revisa y confirma las cantidades de evidencia actuales.', 409);
    const now = stamp(), operationIds = [];
    for (const delivery of active) {
      const data = dataOf(delivery);
      if (!delivery.remote_id && !data.remoteRefs?.remoteDraftRef && !data.preparedRefs?.remoteDraftRef) fail('Falta una referencia inequívoca. Detén el gasto directamente en Meta antes de desconectar.', 409);
      const step = `pause:${input.requestId}`;
      if (await tx.db.get(`SELECT id FROM ${tx.t('social_operations')} WHERE delivery_id=? AND step=?`, [delivery.id, step])) fail('Ese identificador ya pertenece a otro control de campaña. Usa una solicitud nueva.', 409);
      const revision = await tx.db.get(`SELECT spec_hash FROM ${tx.t('social_revisions')} WHERE campaign_id=? AND revision=?`, [delivery.campaign_id, delivery.revision]);
      if (!revision) fail('No se puede verificar el historial de la campaña; detén el gasto directamente en Meta.', 409);
      const operationId = newId(), controlIntent = { id: input.requestId, kind: 'pause', actorId, requestedAt: now };
      await updateVersioned(tx, 'social_deliveries', delivery.id, delivery.version, { data: JSON.stringify({ ...data, controlIntent }) });
      await insertRow(tx, 'social_operations', { id: operationId, campaign_id: delivery.campaign_id, delivery_id: delivery.id, operation_key: `delivery:${delivery.id}:${step}`, step, state: 'prepared', next_attempt_at: now,
        data: JSON.stringify({ integrationMethod: 'browser', actorId, channel: 'meta_ads', specHash: revision.spec_hash, controlId: input.requestId, remoteDraftRef: data.remoteRefs?.remoteDraftRef || data.preparedRefs?.remoteDraftRef || null }), version: 1, created_at: now, updated_at: now });
      await queueSocialBrowserJobTx(tx, { kind: 'delivery', id: delivery.id, nextRunAt: now }, { now });
      operationIds.push(operationId);
    }
    const pending = { requestId: input.requestId, actorId, action, requestedAt: now, state: 'waiting_for_pause', deliveryIds: active.map(delivery => delivery.id),
      ...(action === 'delete-platform-data' ? { receiptId: newId(), confirmCounts: { ...countsOf(graph), operations: graph.operations.length + operationIds.length } } : {}) };
    await updateVersioned(tx, 'social_connections', current.id, current.version, { data: JSON.stringify({ ...recordData(current), disconnectPending: pending }) });
    await audit(tx, { entityType: 'social_connection', entityId: current.id, actorId, next: { disconnectPending: true, operationIds }, reason: 'Pausas nativas encoladas; se conserva la custodia hasta comprobar que el gasto está detenido.' });
    return { connection: socialConnectionDTO(await getSocialConnection(tx, current.id)), disconnectPending: true, remoteSpendStopped: false, operationIds, ...(pending.receiptId ? { receiptId: pending.receiptId } : {}), warning: 'Desconexión pendiente: el consumidor navegador debe confirmar cada pausa. No se ha afirmado que el gasto esté detenido.' };
  });
}

export async function finalizeSocialBrowserDisconnects(store, { now = stamp() } = {}) {
  const pendingField = store.provider === 'sqlite' ? "json_extract(data,'$.disconnectPending')" : "data::jsonb->'disconnectPending'";
  const candidates = await store.db.all(`SELECT id FROM ${store.t('social_connections')} WHERE integration_method='browser' AND state<>'disconnected' AND ${pendingField} IS NOT NULL ORDER BY updated_at,id LIMIT 25`);
  let completed = 0, blocked = 0;
  for (const candidate of candidates) await store.transaction(async tx => {
    await tx.lockWrites();
    const current = await getSocialConnection(tx, candidate.id), pending = current.disconnectPending;
    if (!pending || pending.state !== 'waiting_for_pause') return;
    const lock = await tx.db.get(`SELECT state,lease_until FROM ${tx.t('job_runs')} WHERE key=?`, [`social:browser-lock:${current.id}`]);
    if (lock?.state === 'running' && lock.lease_until > now) return;
    const graph = await graphFor(tx, current.id);
    if (!Array.isArray(pending.deliveryIds) || !pending.deliveryIds.length || pending.deliveryIds.some(id => {
      const delivery = graph.deliveries.find(value => value.id === id);
      return !delivery || !['paused', 'cancelled'].includes(delivery.state) || dataOf(delivery).lastConfirmedState !== 'paused';
    })) return;
    const authorized = !!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [pending.actorId]);
    const countsMatch = pending.action !== 'delete-platform-data' || hash(pending.confirmCounts) === hash(countsOf(graph));
    if (!authorized || !countsMatch) {
      await updateVersioned(tx, 'social_connections', current.id, current.version, { data: JSON.stringify({ ...recordData(current), disconnectPending: { ...pending, state: 'needs_confirmation', errorCode: authorized ? 'SPEC_MISMATCH' : 'PERMISSION_REQUIRED' } }) });
      blocked++;
      return;
    }
    await cancelLocalTx(tx, current, graph, { deleting: pending.action === 'delete-platform-data' });
    const data = recordData(current); delete data.disconnectPending;
    await updateVersioned(tx, 'social_connections', current.id, current.version, { state: 'disconnected', data: JSON.stringify({ ...data, capabilities: noCapabilities(), sessionEpoch: (current.sessionEpoch || 0) + 1 }) });
    if (pending.action === 'delete-platform-data') await deleteGraphTx(tx, current, graph, pending.actorId, true, pending.receiptId);
    else await audit(tx, { entityType: 'social_connection', entityId: current.id, actorId: pending.actorId, next: { state: 'disconnected', remoteSpendStopped: true }, reason: 'Desconexión completada por el consumidor después de pausas nativas comprobadas.' });
    completed++;
  });
  return { completed, blocked };
}
