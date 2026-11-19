import { fail, integer } from '../validation-core.mjs';
import { META_CURRENCY_OFFSETS } from '../social/meta.mjs';
import { entity } from './commands.mjs';
import { MAX_MONEY_MINOR } from './money.mjs';
import { accountAnalysisStale, campaignContentRow, campaignObservationSql } from './social-account-projection.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REMOTE_ID = /^\d{1,40}$/;
const ACCOUNT_ID = /^act_\d{1,40}$/;
const FILTERS = ['connection', 'account', 'metaCampaign', 'snapshot', 'page', 'pageSize'];
const accountKey = (account, campaign) => `${account}:${campaign}`;
const normalizeAccount = value => typeof value === 'string' && /^(?:act_)?\d{1,40}$/.test(value) ? `act_${value.replace(/^act_/, '')}` : null;
const safeName = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 300) || null : null;
const jsonField = (store, alias, path) => store.provider === 'sqlite'
  ? `json_extract(${alias}.data,'$.${path.join('.')}')` : `${alias}.data::jsonb#>>'{${path.join(',')}}'`;
const bindKeys = (keys, params) => {
  for (const { accountId, resourceId } of keys) params.push(accountId, resourceId);
  return `(VALUES ${keys.map(() => '(?,?)').join(',')})`;
};

function inventoryQuery(query) {
  if (query instanceof URLSearchParams) {
    if ([...query.keys()].some(key => !FILTERS.includes(key) || query.getAll(key).length !== 1)) fail('Filtro de campañas de Meta no válido.');
    query = Object.fromEntries(query);
  } else if (Object.keys(query).some(key => !FILTERS.includes(key))) fail('Filtro de campañas de Meta no válido.');
  const read = (field, pattern, label) => {
    const value = query[field];
    if (value === undefined) return null;
    if (typeof value !== 'string' || !pattern.test(value)) fail(`${label} no válido.`);
    return value;
  };
  const connection = read('connection', UUID, 'Identificador de conexión')?.toLowerCase() || null;
  const account = read('account', ACCOUNT_ID, 'Identificador de cuenta');
  const campaign = read('metaCampaign', REMOTE_ID, 'Identificador de campaña');
  const snapshot = read('snapshot', UUID, 'Identificador de consulta')?.toLowerCase() || null;
  if (campaign && !account) fail('Selecciona la cuenta publicitaria de la campaña.');
  if (snapshot && (!campaign || !connection)) fail('Selecciona la conexión y la campaña de la consulta.');
  const page = integer(Number(read('page', /^\d{1,7}$/, 'Número de página') ?? 1), 'Página', 1, 1000000);
  const pageSize = integer(Number(read('pageSize', /^\d{1,2}$/, 'Tamaño de página') ?? 20), 'Tamaño de página', 1, 50);
  return { connection, account, campaign, snapshot, page, pageSize };
}

// Campaign identity and observation dates use the same expressions as the connection projection.
function captureSql(store, params, { connection, account, campaign, keys } = {}) {
  const { accountId, resourceId, observedAt, validResourceId } = campaignObservationSql(store);
  const filters = ["i.resource_kind IN ('campaigns','ads_campaign')", `(${accountId}) IS NOT NULL`, `(${validResourceId})`];
  if (connection) { filters.push('a.connection_id=?'); params.push(connection); }
  if (account) { filters.push(`(${accountId})=?`); params.push(account); }
  if (campaign) { filters.push(`${resourceId}=?`); params.push(campaign); }
  if (keys) filters.push(`((${accountId}),${resourceId}) IN ${bindKeys(keys, params)}`);
  return `observations AS (
    SELECT i.id,i.analysis_id,a.connection_id,${accountId} AS account_id,${resourceId} AS resource_id,${observedAt} AS observed_at
    FROM ${store.t('social_account_analysis_items')} i JOIN ${store.t('social_account_analyses')} a ON a.id=i.analysis_id
    JOIN ${store.t('social_connections')} c ON c.id=a.connection_id AND c.provider='meta' AND c.integration_method='api'
    WHERE ${filters.join(' AND ')}
  ), captures AS (
    SELECT analysis_id,connection_id,account_id,resource_id,MAX(observed_at) AS observed_at
    FROM observations GROUP BY analysis_id,connection_id,account_id,resource_id
  )`;
}

const CAPTURE_ORDER = 'observed_at DESC NULLS LAST,analysis_id DESC,account_id,resource_id';
const RANKED = `ranked AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY account_id,resource_id ORDER BY ${CAPTURE_ORDER}) AS capture_rank FROM captures
)`;

function connectionName(connection) {
  const accounts = connection.resources?.adAccounts || [], pages = connection.resources?.pages || [];
  return safeName(connection.name) || safeName(pages.find(page => page.id === connection.identities?.pageId)?.name)
    || safeName(accounts.find(account => normalizeAccount(account.id) === normalizeAccount(connection.identities?.adAccountId))?.name)
    || safeName(connection.identities?.userName);
}

function accountName(connection, accountId) {
  return safeName(connection.resources?.adAccounts?.find(account => normalizeAccount(account.id) === accountId)?.name);
}

async function readSources(store, ids = []) {
  const scope = ids.length ? ` AND c.id IN (${ids.map(() => '?').join(',')})` : '';
  const analyses = store.t('social_account_analyses');
  const rows = await store.db.all(`SELECT c.*,k.version AS credential_version,a.id AS latest_analysis_id,a.state AS latest_analysis_state,${jsonField(store, 'a', ['coverage'])} AS latest_coverage
    FROM ${store.t('social_connections')} c LEFT JOIN ${store.t('social_credentials')} k ON k.connection_id=c.id
    LEFT JOIN ${analyses} a ON a.id=(SELECT z.id FROM ${analyses} z WHERE z.connection_id=c.id ORDER BY z.created_at DESC,z.id DESC LIMIT 1)
    WHERE c.provider='meta' AND c.integration_method='api'${scope} ORDER BY c.created_at,c.id`, ids);
  return new Map(rows.map(({ credential_version: credentialVersion, latest_analysis_id: latestAnalysisId, latest_analysis_state: latestAnalysisState, latest_coverage: latestCoverage, ...row }) => {
    const connection = entity(row);
    return [connection.id, { connection, name: connectionName(connection), credentialVersion: credentialVersion ?? undefined, latestAnalysisId, latestAnalysisState, latestCoverage: latestCoverage ? JSON.parse(latestCoverage) : null }];
  }));
}

function observedBudget(object, currency) {
  const amount = object?.configuration?.lifetime_budget;
  const offset = currency && Object.hasOwn(META_CURRENCY_OFFSETS, currency) && META_CURRENCY_OFFSETS[currency];
  if (!offset || typeof amount !== 'string' || !/^\d{1,80}(?:\.0+)?$/.test(amount)) return null;
  const numerator = BigInt(amount.split('.')[0]) * 100n, divisor = BigInt(offset);
  if (numerator % divisor !== 0n) return null;
  const minor = numerator / divisor;
  return minor <= BigInt(MAX_MONEY_MINOR) ? Number(minor) : null;
}

async function inventoryItems(store, filters, sources, configurationVersion) {
  const params = [];
  const allCaptures = captureSql(store, params, filters);
  const selected = filters.campaign ? 'SELECT * FROM captures' : `SELECT * FROM ranked WHERE capture_rank=1 ORDER BY ${CAPTURE_ORDER} LIMIT ? OFFSET ?`;
  if (!filters.campaign) params.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
  const metadata = ['fence', 'credentialVersion', 'configurationVersion', 'period', 'coverage', 'resources'];
  const captureData = store.provider === 'sqlite'
    ? `json_object(${metadata.map(name => `'${name}',${jsonField(store, 'a', [name])}`).join(',')})`
    : `jsonb_build_object(${metadata.map(name => `'${name}',a.data::jsonb->'${name}'`).join(',')})::text`;
  const rows = await store.db.all(`WITH ${allCaptures}, ${RANKED}, selected AS (${selected})
    SELECT p.account_id,p.resource_id AS campaign_id,p.observed_at AS campaign_observed_at,p.connection_id,a.updated_at AS snapshot_updated_at,
      a.state AS analysis_state,${captureData} AS capture_data,i.*,t.total
    FROM (SELECT COUNT(*) AS total FROM ranked WHERE capture_rank=1) t LEFT JOIN selected p ON 1=1
    LEFT JOIN observations o ON o.analysis_id=p.analysis_id AND o.account_id=p.account_id AND o.resource_id=p.resource_id
    LEFT JOIN ${store.t('social_account_analysis_items')} i ON i.id=o.id
    LEFT JOIN ${store.t('social_account_analyses')} a ON a.id=p.analysis_id
    ORDER BY p.observed_at DESC NULLS LAST,p.analysis_id DESC,p.account_id,p.resource_id,i.resource_kind,i.id`, params);
  const captures = new Map(), now = new Date().toISOString();
  for (const { account_id: ownerId, campaign_id: resourceId, campaign_observed_at: observedAt, connection_id: connectionId,
    snapshot_updated_at: updatedAt, analysis_state: analysisState, capture_data: captureData, total: _total, ...row } of rows) {
    if (!row.id) continue;
    const key = `${row.analysis_id}:${ownerId}:${resourceId}`;
    let capture = captures.get(key);
    if (!capture) {
      const source = sources.get(connectionId);
      if (!source) continue;
      const data = JSON.parse(captureData);
      const account = `ad_account:${ownerId}`;
      const currency = data.resources?.[account]?.currency;
      capture = {
        ownerId, resourceId, evidence: [], observedAt, connectionId, connectionName: source.name,
        accountName: accountName(source.connection, ownerId), accountCurrency: /^[A-Z]{3}$/.test(currency || '') ? currency : null,
        analysisState, coverage: data.coverage?.[account] || null, period: data.period || null,
        historical: source.latestAnalysisId !== row.analysis_id,
        snapshot: { id: row.analysis_id, updatedAt, stale: accountAnalysisStale(source.connection, data, source.credentialVersion, configurationVersion, now) }
      };
      captures.set(key, capture);
    }
    capture.evidence.push(entity(row));
  }
  const items = Array.from(captures.values(), ({ evidence, ...capture }) => {
    const row = campaignContentRow(capture.ownerId, capture.resourceId, evidence);
    return { ...capture, ...row, observedBudgetMinor: observedBudget(row.object, capture.accountCurrency) };
  });
  return { items, total: Number(rows[0].total) };
}

function verifiedRef(row, operations) {
  const data = JSON.parse(row.delivery_data), remote = data.remoteRefs?.campaignId, prepared = data.preparedRefs?.campaignId;
  const remoteId = typeof remote === 'string' && REMOTE_ID.test(remote) ? remote : null;
  const preparedId = typeof prepared === 'string' && REMOTE_ID.test(prepared) ? prepared : null;
  if (remoteId && preparedId && remoteId !== preparedId) return null;
  if (remoteId && remoteId === row.remote_id && data.lastConfirmedAt) return remoteId;
  if (preparedId && data.lastConfirmedAt && data.evidence?.remoteRead === true) return preparedId;
  for (const { deliveryId, state, step, proof } of operations) {
    if (state !== 'confirmed' || proof.result?.status !== 'confirmed') continue;
    if (deliveryId === row.delivery_id) {
      if (remoteId && proof.result.remoteRefs?.campaignId === remoteId &&
          (proof.result.evidence?.remoteRead === true || ['create_campaign', 'create_adset', 'create_creative', 'create_ad', 'verify_prepared'].includes(step))) return remoteId;
      if (preparedId && proof.result.preparedRefs?.campaignId === preparedId && proof.result.evidence?.remoteRead === true) return preparedId;
    } else if (!deliveryId && step === 'validate' && preparedId && proof.specHash === row.spec_hash && data.specHash === row.spec_hash &&
        proof.result.preparedRefs?.campaignId === preparedId && proof.result.preparedRefs?.remoteDraftRef === data.preparedRefs?.remoteDraftRef && data.preparedRefs?.remoteDraftRef) return preparedId;
  }
  return null;
}

// Query only candidate deliveries for the visible local IDs or external identities. The revision join
// uses the delivery's own revision; today's selected connection/account does not prove attribution.
async function verifiedClaims(store, { localIds, keys }) {
  const account = jsonField(store, 'r', ['spec', 'identities', 'adAccountId']);
  const normalized = `CASE WHEN SUBSTR(${account},1,4)='act_' THEN ${account} ELSE 'act_' || (${account}) END`;
  const remote = jsonField(store, 'd', ['remoteRefs', 'campaignId']);
  const prepared = jsonField(store, 'd', ['preparedRefs', 'campaignId']);
  const accountIsString = store.provider === 'sqlite' ? "json_type(r.data,'$.spec.identities.adAccountId')='text'" : "jsonb_typeof(r.data::jsonb#>'{spec,identities,adAccountId}')='string'";
  const params = localIds ? [...localIds] : [];
  const keyCte = keys ? `requested(account_id,resource_id) AS ${bindKeys(keys, params)},` : '';
  const scope = localIds ? `d.campaign_id IN (${localIds.map(() => '?').join(',')})` :
    `EXISTS (SELECT 1 FROM requested q WHERE q.account_id=(${normalized}) AND (q.resource_id=${remote} OR q.resource_id=${prepared}))`;
  const rows = await store.db.all(`WITH ${keyCte} candidates AS (
    SELECT d.id AS delivery_id,d.campaign_id,d.remote_id,d.data AS delivery_data,r.spec_hash,${normalized} AS account_id
    FROM ${store.t('social_deliveries')} d JOIN ${store.t('social_revisions')} r ON r.campaign_id=d.campaign_id AND r.revision=d.revision
    WHERE d.channel='meta_ads' AND ${accountIsString} AND (${remote} IS NOT NULL OR ${prepared} IS NOT NULL) AND ${scope}
  ) SELECT c.*,o.delivery_id AS operation_delivery_id,o.state AS operation_state,o.step,o.data AS operation_data
    FROM candidates c LEFT JOIN ${store.t('social_operations')} o ON o.campaign_id=c.campaign_id AND o.state='confirmed'
      AND (o.delivery_id=c.delivery_id OR (o.delivery_id IS NULL AND o.step='validate'))`, params);
  const deliveries = new Map();
  for (const { operation_delivery_id: deliveryId, operation_state: state, step, operation_data: data, ...row } of rows) {
    if (!deliveries.has(row.delivery_id)) deliveries.set(row.delivery_id, { row, operations: [] });
    if (data) deliveries.get(row.delivery_id).operations.push({ deliveryId, state, step, proof: JSON.parse(data) });
  }
  const claims = new Map();
  for (const { row, operations } of deliveries.values()) {
    const accountId = normalizeAccount(row.account_id), resourceId = verifiedRef(row, operations);
    if (!accountId || !resourceId) continue;
    const key = accountKey(accountId, resourceId);
    if (!claims.has(key)) claims.set(key, { accountId, resourceId, owners: new Set() });
    claims.get(key).owners.add(row.campaign_id);
  }
  return claims;
}

export async function latestMetaCampaignReferences(store, campaigns) {
  const localIds = campaigns.filter(campaign => campaign.mode === 'paid').map(campaign => campaign.id);
  const references = new Map();
  if (!localIds.length) return references;
  const candidates = await verifiedClaims(store, { localIds });
  if (!candidates.size) return references;
  const params = [], sql = captureSql(store, params, { keys: [...candidates.values()] });
  const observations = await store.db.all(`WITH ${sql}, ${RANKED}
    SELECT account_id,resource_id,observed_at,analysis_id,connection_id FROM ranked WHERE capture_rank=1 ORDER BY ${CAPTURE_ORDER}`, params);
  if (!observations.length) return references;
  const claims = await verifiedClaims(store, { keys: observations.map(row => ({ accountId: row.account_id, resourceId: row.resource_id })) });
  for (const { account_id: accountId, resource_id: resourceId, observed_at: observedAt, analysis_id: snapshotId, connection_id: connectionId } of observations) {
    const owners = claims.get(accountKey(accountId, resourceId))?.owners;
    if (owners?.size !== 1) continue;
    const [id] = owners;
    if (localIds.includes(id) && !references.has(id)) references.set(id, { accountId, resourceId, observedAt, connectionId, snapshotId });
  }
  return references;
}

async function readAdSets(store, selected, { page, pageSize }) {
  const { accountId } = campaignObservationSql(store);
  const parentIsString = store.provider === 'sqlite' ? "json_type(i.data,'$.configuration.campaignId')='text'" : "jsonb_typeof(i.data::jsonb#>'{configuration,campaignId}')='string'";
  const rows = await store.db.all(`WITH matched AS (
    SELECT i.* FROM ${store.t('social_account_analysis_items')} i WHERE i.analysis_id=? AND i.resource_kind='adsets' AND (${accountId})=? AND ${parentIsString} AND ${jsonField(store, 'i', ['configuration', 'campaignId'])}=?
  ), picked AS (SELECT * FROM matched ORDER BY resource_id,id LIMIT ? OFFSET ?)
  SELECT p.*,t.total FROM (SELECT COUNT(*) AS total FROM matched) t LEFT JOIN picked p ON 1=1 ORDER BY p.resource_id,p.id`,
  [selected.snapshot.id, selected.ownerId, selected.resourceId, pageSize, (page - 1) * pageSize]);
  return { adsets: rows.flatMap(({ total: _total, ...row }) => row.id ? [entity(row)] : []), pagination: { page, pageSize, total: Number(rows[0].total) } };
}

async function accountChoices(store, connection, sources) {
  const params = [], captures = captureSql(store, params, { connection });
  const rows = await store.db.all(`WITH ${captures} SELECT DISTINCT account_id,connection_id FROM observations ORDER BY account_id,connection_id`, params);
  const accounts = new Map();
  for (const { account_id: id, connection_id: sourceId } of rows) {
    if (accounts.get(id)) continue;
    const source = sources.get(sourceId);
    if (source) accounts.set(id, accountName(source.connection, id));
  }
  return Array.from(accounts, ([id, name]) => ({ id, name }));
}

export async function getSavedMetaCampaigns(store, query = new URLSearchParams(), actorId) {
  return store.readSnapshot(tx => savedMetaCampaigns(tx, query, actorId));
}

async function savedMetaCampaigns(store, query, actorId) {
  if (!actorId || !await store.db.get(`SELECT id FROM ${store.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
  const filters = inventoryQuery(query);
  const { connection, account, campaign, snapshot, page, pageSize } = filters;
  const sources = await readSources(store, campaign && connection ? [connection] : []);
  const configuration = await store.db.get(`SELECT version FROM ${store.t('social_integration_settings')} WHERE id=1`);
  const { items, total } = await inventoryItems(store, filters, sources, configuration?.version);
  const selected = campaign && (snapshot ? items.find(item => item.snapshot.id === snapshot) : items[0]);
  if (campaign && !selected) fail('No se encontró la campaña en esta consulta guardada.', 404);
  const keys = items.length ? (campaign ? [selected] : items).map(({ ownerId: accountId, resourceId }) => ({ accountId, resourceId })) : [];
  const claims = keys.length ? await verifiedClaims(store, { keys }) : new Map();
  for (const item of items) {
    const owners = claims.get(accountKey(item.ownerId, item.resourceId))?.owners;
    item.localCampaignId = owners?.size === 1 ? [...owners][0] : null;
  }
  if (selected) return { item: selected, snapshots: items, ...await readAdSets(store, selected, filters) };
  const availability = [];
  for (const [connectionId, source] of sources) {
    if (!source.latestAnalysisId || connection && connectionId !== connection) continue;
    const allCoverage = Object.values(source.latestCoverage || {}).filter(row => row.kind === 'ad_account');
    const matched = account ? allCoverage.filter(row => normalizeAccount(row.resourceId) === account) : allCoverage;
    availability.push({ connectionId, state: source.latestAnalysisState, coverage: account && !matched.length ? allCoverage.filter(row => !row.resourceId) : matched });
  }
  return { items, pagination: { page, pageSize, total }, connections: Array.from(sources, ([id, { name }]) => ({ id, name })), accounts: await accountChoices(store, connection, sources), availability };
}
