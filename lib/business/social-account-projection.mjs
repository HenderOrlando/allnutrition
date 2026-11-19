import { entity, hash } from './commands.mjs';

const kinds = {
  all: ['facebook_post', 'instagram_media', 'campaigns', 'ads_campaign'],
  facebook: ['facebook_post'],
  instagram: ['instagram_media'],
  campaigns: ['campaigns', 'ads_campaign']
};

export function connectionFence(connection) {
  return hash({ epoch: connection.sessionEpoch || 0, configuration: connection.configurationFingerprint || null, identities: connection.identities || {}, resources: connection.resources || {}, authenticationMethod: connection.authenticationMethod || 'oauth', revalidationRequired: connection.revalidationRequired === true });
}

export function accountAnalysisStale(connection, data, credentialVersion, configurationVersion, now) {
  return connection.state !== 'connected' || connection.revalidationRequired === true || Boolean(connection.disconnectPending)
    || Boolean(now && connection.expiresAt && connection.expiresAt <= now)
    || connectionFence(connection) !== data.fence || credentialVersion !== data.credentialVersion || (configurationVersion || 0) !== data.configurationVersion;
}

function field(store, alias, path) {
  return store.provider === 'sqlite' ? `json_extract(${alias}.data,'$.${path.join('.')}')` : `${alias}.data::jsonb#>>'{${path.join(',')}}'`;
}

function decimalIdSql(store, value) {
  return store.provider === 'sqlite' ? `LENGTH(${value}) BETWEEN 1 AND 40 AND ${value} NOT GLOB '*[^0-9]*'` : `${value} ~ '^[0-9]{1,40}$'`;
}

export function campaignObservationSql(store, alias = 'i') {
  const raw = field(store, alias, ['accountId']);
  const digits = `CASE WHEN SUBSTR(${raw},1,4)='act_' THEN SUBSTR(${raw},5) ELSE ${raw} END`;
  const stringAccount = store.provider === 'sqlite' ? `json_type(${alias}.data,'$.accountId')='text'` : `jsonb_typeof(${alias}.data::jsonb->'accountId')='string'`;
  const resourceId = `${alias}.resource_id`;
  return {
    accountId: `CASE WHEN ${stringAccount} AND ${decimalIdSql(store, `(${digits})`)} THEN 'act_' || (${digits}) END`,
    resourceId,
    validResourceId: decimalIdSql(store, resourceId),
    observedAt: field(store, alias, ['observedAt'])
  };
}

export function campaignContentRow(accountId, resourceId, items) {
  return { kind: 'campaigns', resourceId, ownerId: accountId, object: items.find(item => item.resourceKind === 'campaigns') || null, metrics: items.filter(item => item.resourceKind === 'ads_campaign') };
}

export function validAnalysisContent(value) {
  return typeof value === 'string' && Object.hasOwn(kinds, value);
}

export async function readAnalysisContent(store, latest, { content, page, pageSize, active }) {
  const table = store.t('social_account_analysis_items');
  const { accountId, validResourceId } = campaignObservationSql(store);
  const owner = `CASE WHEN i.resource_kind IN ('campaigns','ads_campaign') THEN CASE WHEN ${validResourceId} THEN ${accountId} END ELSE ${field(store, 'i', ['ownerId'])} END`;
  const filter = `i.resource_kind IN (${kinds[content].map(() => '?').join(',')}) AND (${owner}) IS NOT NULL`;
  const analyses = store.t('social_account_analyses');
  const snapshot = active ? await store.db.get(`SELECT a.* FROM ${analyses} a
    WHERE a.connection_id=? AND (a.created_at<? OR (a.created_at=? AND a.id<=?))
      AND EXISTS (SELECT 1 FROM ${table} i WHERE i.analysis_id=a.id AND ${filter})
    ORDER BY a.created_at DESC,a.id DESC LIMIT 1`, [latest.connection_id, latest.created_at, latest.created_at, latest.id, ...kinds[content]]) || latest : latest;
  const metricIds = store.provider === 'sqlite'
    ? "json_each(o.data,'$.metricsItemIds')"
    : "jsonb_array_elements_text(COALESCE(o.data::jsonb->'metricsItemIds','[]'::jsonb))";
  const rows = await store.db.all(`WITH captures AS (
    SELECT i.id,i.resource_id,i.updated_at,${owner} AS owner_id,
      CASE i.resource_kind WHEN 'facebook_post' THEN 'facebook' WHEN 'instagram_media' THEN 'instagram' ELSE 'campaigns' END AS kind
    FROM ${table} i WHERE i.analysis_id=? AND ${filter}
  ), objects AS (
    SELECT kind,owner_id,resource_id,MAX(updated_at) AS captured_at
    FROM captures GROUP BY kind,owner_id,resource_id
  ), picked AS (
    SELECT * FROM objects ORDER BY captured_at DESC,kind,owner_id,resource_id LIMIT ? OFFSET ?
  ), evidence AS (
    SELECT p.kind,p.owner_id,p.resource_id,p.captured_at,c.id FROM picked p JOIN captures c
      ON c.kind=p.kind AND c.owner_id=p.owner_id AND c.resource_id=p.resource_id
    UNION ALL
    SELECT p.kind,p.owner_id,p.resource_id,p.captured_at,m.id FROM picked p JOIN captures c
      ON c.kind=p.kind AND c.owner_id=p.owner_id AND c.resource_id=p.resource_id
    JOIN ${table} o ON o.id=c.id
    JOIN ${table} m ON m.analysis_id=o.analysis_id AND m.resource_kind='organic_metrics'
      AND m.id IN (SELECT value FROM ${metricIds})
      AND ${field(store, 'm', ['dimensions', 'channel'])}=p.kind
      AND ${field(store, 'm', ['ownerId'])}=p.owner_id
      AND ${field(store, 'm', ['contentId'])}=p.resource_id
    WHERE p.kind IN ('facebook','instagram')
  )
  SELECT e.kind AS object_kind,e.owner_id AS object_owner,e.resource_id AS object_resource,i.*,t.total
  FROM (SELECT COUNT(*) AS total FROM objects) t
  LEFT JOIN evidence e ON 1=1 LEFT JOIN ${table} i ON i.id=e.id
  ORDER BY e.captured_at DESC,e.kind,e.owner_id,e.resource_id,i.updated_at DESC,i.id DESC`, [snapshot.id, ...kinds[content], pageSize, (page - 1) * pageSize]);
  const items = [];
  let previous, captures;
  function append() {
    if (!previous) return;
    const { kind, ownerId, resourceId } = previous;
    items.push(kind === 'campaigns' ? campaignContentRow(ownerId, resourceId, captures) : {
      ...previous, object: captures.find(item => item.resourceKind !== 'organic_metrics'), metrics: captures.filter(item => item.resourceKind === 'organic_metrics')
    });
  }
  for (const { object_kind: kind, object_owner: ownerId, object_resource: resourceId, total, ...row } of rows) {
    if (!kind) break;
    if (previous?.kind !== kind || previous.ownerId !== ownerId || previous.resourceId !== resourceId) {
      append(); previous = { kind, resourceId, ownerId }; captures = [];
    }
    captures.push(entity(row));
  }
  append();
  return { snapshot, items, total: Number(rows[0].total) };
}
