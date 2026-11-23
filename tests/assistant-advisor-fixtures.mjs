import { randomUUID } from 'node:crypto';
import { emptyRecord } from '../lib/schema.mjs';
import { evaluateAlerts } from '../lib/business/alerts.mjs';
import { createImportBatch } from '../lib/business/imports.mjs';
import { listResources, saveResource } from '../lib/business/settings.mjs';

export async function stockEpisode(store, product, actorId, now, stockQuantity = 0) {
  const saved = await store.save('products', { ...product, stockQuantity }, product.id || null, product.version || null, actorId);
  await evaluateAlerts(store, { now });
  const current = await store.db.get(`SELECT id,state,version FROM ${store.t('alerts')} WHERE rule_id='stock_low' AND entity_id=? ORDER BY episode DESC LIMIT 1`, [saved.id]);
  return { product: saved, alert: current };
}

export async function seedAdvisorAlert(store, { title, actorId, now }) {
  return stockEpisode(store, { ...emptyRecord('products'), title, slug: `advisor-stock-${randomUUID()}`, price: 1000, presentation: 'Unidad', orderable: true }, actorId, now);
}

export async function setAdvisorImportResult(store, id, { state, now, label }) {
  const row = await store.db.get(`SELECT data FROM ${store.t('import_batches')} WHERE id=?`, [id]);
  const completed = state === 'completed_with_errors';
  const progress = {
    phase: 'apply', processed: completed ? 2 : 0, total: 2, groupsProcessed: completed ? 2 : 0, groupsTotal: 2,
    settlementsProcessed: 0, settlementsTotal: 0, created: completed ? 1 : 0, updated: 0, unchanged: 0,
    errors: completed ? 1 : 0, omitted: 0,
  };
  // C2 starts from material state already persisted by the import source. It does
  // not claim to apply a workbook; C4 proves the real preview and apply handlers.
  const data = { ...JSON.parse(row.data), acceptedRevision: { revision: 1, previewHash: 'a'.repeat(64) }, progress,
    ...(completed ? { completedAt: now, finishedAt: now } : {}) };
  await store.db.run(`UPDATE ${store.t('import_batches')} SET filename=?,state=?,version=version+1,updated_at=?,data=? WHERE id=?`, [label, state, now, JSON.stringify(data), id]);
}

export async function seedAdvisorImport(store, { label = 'C2-muestra.xlsx', actorId, now, state = 'queued' }) {
  const platform = await saveResource(store, 'platforms', { name: `Origen C2 ${randomUUID()}`, requestId: randomUUID() }, actorId);
  const [source] = await listResources(store, 'sources', { platform: platform.id });
  const batch = await createImportBatch(store, { sourceId: source.id, requestId: randomUUID() }, actorId);
  await setAdvisorImportResult(store, batch.id, { label, state, now });
  return batch.id;
}
