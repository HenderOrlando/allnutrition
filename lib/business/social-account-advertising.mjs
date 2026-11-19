import { fail } from '../validation-core.mjs';
import { getSocialConnection } from './social.mjs';
import { socialConnectionDTO, socialMetaError } from './social-connections.mjs';
import { loadSocialRuntime, requireIntegration } from '../social/config.mjs';
import { decryptCredentials } from '../social/credentials.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { createMetaClient } from '../social/meta.mjs';
import { businessDate } from './dates.mjs';
import { updateVersioned, stamp } from './commands.mjs';

const metric = (value, decimal = false) => typeof value === 'string' && (decimal ? /^\d+(?:\.\d+)?$/ : /^\d+$/).test(value) ? value : null;

// This is a live, read-only account report, not a local campaign or attribution link.
export async function getSocialAccountAdvertising(store, id, query, actorId, options = {}) {
  const from = businessDate(query.from, 'Desde'), to = businessDate(query.to, 'Hasta');
  if (from > to) fail('Desde debe ser anterior o igual a Hasta.');
  const connection = await getSocialConnection(store, id);
  if (connection.integrationMethod !== 'api' || connection.state !== 'connected' || connection.disconnectPending || connection.revalidationRequired) fail('Selecciona una conexión API vigente y revalidada.', 409);
  const accountId = connection.identities?.adAccountId;
  if (!/^act_\d+$/.test(accountId || '')) fail('Selecciona y revalida una cuenta publicitaria de esta conexión.', 409);
  const runtime = requireIntegration('api', await loadSocialRuntime(store, options), connection.authenticationMethod || 'oauth');
  const credentialRow = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [id]);
  const credentials = decryptCredentials(connection, credentialRow, runtime);
  if (!credentials) fail('La conexión necesita autenticarse de nuevo.', 409);
  const credentialVersion = credentialRow.version;
  const check = async tx => {
    if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
    const current = await getSocialConnection(tx, id);
    const currentRuntime = await loadSocialRuntime(tx, options);
    const credential = await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [id]);
    if (current.version !== connection.version || credential?.version !== credentialVersion || currentRuntime.configurationVersion !== runtime.configurationVersion || currentRuntime.fingerprint !== runtime.fingerprint) fail('La conexión o sus credenciales cambiaron durante la consulta. Recarga antes de continuar.', 409);
    return current;
  };
  await store.transaction(async tx => { await tx.lockWrites(); await check(tx); });
  const connector = await createSocialConnector({ connection: { ...connection, data: connection }, credentials, runtime, transport: { fetchImpl: options.fetchImpl, now: options.now ? Date.parse(options.now) : undefined } });
  const client = createMetaClient({ accessToken: credentials.accessToken, appSecret: runtime.appSecret, graphVersion: runtime.graphVersion, fetchImpl: options.fetchImpl });
  let validation;
  try {
    validation = await connector.validateConnection({ signal: options.signal, purpose: 'insights', channel: 'meta_ads' });
    if (validation.state !== 'connected' || validation.identities?.adAccountId !== accountId || !validation.capabilities?.insights) fail('La conexión no acredita permiso de consulta para esta cuenta.', 409);
    const data = await client.pages(`${accountId}/insights`, { level: 'campaign', fields: 'account_id,account_currency,campaign_id,campaign_name,impressions,clicks,reach,spend', time_range: { since: from, until: to }, limit: 100 }, { signal: options.signal });
    const rows = data.map(row => {
      if (String(row.account_id) !== accountId.slice(4) || !/^\d+$/.test(row.campaign_id || '') || row.account_currency && validation.currency && row.account_currency !== validation.currency) fail('Meta devolvió resultados de una cuenta o moneda diferente.', 409);
      return { campaignId: row.campaign_id, campaignName: typeof row.campaign_name === 'string' ? row.campaign_name.slice(0, 300) : '', impressions: metric(row.impressions), clicks: metric(row.clicks), reach: metric(row.reach), spend: metric(row.spend, true) };
    });
    const usage = client.usageSnapshot();
    const evaluation = socialConnectionDTO({ ...connection, evaluation: { ...validation.evaluation, ...(usage.status === 'reported' ? { limits: usage } : {}) } }).evaluation;
    await store.transaction(async tx => {
      await tx.lockWrites(); const current = await check(tx);
      const { id: _id, provider, integrationMethod, state, version, createdAt, updatedAt, ...data } = current;
      await updateVersioned(tx, 'social_connections', id, current.version, { data: JSON.stringify({ ...data, evaluation }) });
    });
    return { accountId, currency: validation.currency || null, timeZone: validation.timeZone || null, from, to, fetchedAt: options.now || stamp(), rows, evaluation };
  } catch (error) {
    if (['permission', 'reconnect_required', 'rate_limit'].includes(error.kind)) {
      await store.transaction(async tx => {
        await tx.lockWrites(); const current = await check(tx);
        const { id: _id, provider, integrationMethod, state, version, createdAt, updatedAt, ...data } = current;
        const evaluation = socialConnectionDTO({ ...current, evaluation: { ...(validation?.evaluation || current.evaluation), ...(error.limits ? { limits: error.limits } : {}), restrictions: [socialMetaError(error)?.error || error.message] } }).evaluation;
        const capabilities = error.kind === 'reconnect_required' ? Object.fromEntries(Object.keys(current.capabilities || {}).map(key => [key, false])) : error.kind === 'permission' ? { ...current.capabilities, insights: false } : current.capabilities;
        await updateVersioned(tx, 'social_connections', id, current.version, { state: error.kind === 'reconnect_required' ? 'reconnect_required' : current.state, data: JSON.stringify({ ...data, capabilities, evaluation }) });
      });
    }
    throw error;
  }
}
