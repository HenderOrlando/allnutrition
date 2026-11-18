import { entity, hash } from './commands.mjs';
import { fail } from '../validation-core.mjs';

export const isContentChange = operation => Boolean(operation?.step?.startsWith('amend:'));
export const openSocialOperation = operation => ['prepared', 'retry_wait', 'sent', 'uncertain'].includes(operation?.state);

export function socialContentDelta(base, proposed, variable) {
  if (!base || !proposed) return false;
  const keys = variable === 'caption' ? ['caption'] : variable === 'asset' ? ['assetId', 'assetHash', 'assetType'] : variable === 'placement' ? ['placements', 'targeting'] : [];
  if (!keys.length || hash(Object.fromEntries(Object.entries(base).filter(([key]) => !keys.includes(key)))) !== hash(Object.fromEntries(Object.entries(proposed).filter(([key]) => !keys.includes(key))))) return false;
  if (variable === 'caption') return typeof proposed.caption === 'string' && Boolean(proposed.caption.trim()) && proposed.caption !== base.caption;
  if (variable === 'asset') return proposed.assetType === 'image' && proposed.assetHash !== base.assetHash && /^[a-f0-9]{64}$/.test(proposed.assetHash || '') && typeof proposed.assetId === 'string';
  const mapping = { facebook_feed: ['facebook', 'feed'], facebook_reels: ['facebook', 'facebook_reels'], instagram_feed: ['instagram', 'stream'], instagram_reels: ['instagram', 'reels'] };
  const [network, position] = mapping[proposed.placements?.[0]] || [];
  if (!network || proposed.placements.length !== 1 || !base.placements?.includes(proposed.placements[0]) || base.placements.length < 2 || !base.targeting?.[`${network}_positions`]?.includes(position)) return false;
  const targeting = { ...base.targeting, publisher_platforms: [network] };
  delete targeting.facebook_positions; delete targeting.instagram_positions;
  targeting[`${network}_positions`] = [position];
  return hash(targeting) === hash(proposed.targeting);
}

export function effectiveSocialDelivery(revision, delivery, operations = []) {
  if (!revision?.spec || hash(revision.spec) !== revision.specHash || delivery.revision !== revision.revision) fail('No se puede verificar la aprobación original.', 409);
  let spec = revision.spec, specHash = revision.specHash, creativeName = null;
  let operationId = delivery.effectiveContentOperationId || null;
  const latestId = operationId, seen = new Set(), chain = [];
  while (operationId) {
    const op = operations.find(value => value.id === operationId);
    if (!op || !isContentChange(op) || op.state !== 'confirmed' || op.deliveryId !== delivery.id || op.campaignId !== delivery.campaignId || op.specHash !== revision.specHash ||
        op.change?.revision !== revision.revision || op.change?.remoteId !== delivery.remoteId || op.result?.status !== 'confirmed' ||
        op.result.operationComplete !== true || op.result.evidence?.remoteRead !== true || op.result.evidence?.specVerified !== true || seen.has(op.id)) fail('No se puede verificar la versión efectiva de la entrega.', 409);
    seen.add(op.id); chain.push(op);
    operationId = op.change.baseOperationId;
  }
  for (const op of chain.reverse()) {
    if (op.change.baseHash !== specHash || !op.change.spec || hash(op.change.spec) !== op.change.proposedHash || !socialContentDelta(spec, op.change.spec, op.change.variable)) fail('No coincide el historial efectivo de la entrega.', 409);
    spec = op.change.spec; specHash = op.change.proposedHash;
    if (['caption', 'asset'].includes(op.change.variable) && spec.mode === 'paid') creativeName = `social:${op.id}:change-creative`;
  }
  return { spec, specHash, operationId: latestId, creativeName };
}

export async function readEffectiveSocialDelivery(tx, revision, delivery) {
  const ops = delivery.effectiveContentOperationId ? (await tx.db.all(`SELECT * FROM ${tx.t('social_operations')} WHERE delivery_id=? AND step LIKE 'amend:%'`, [delivery.id])).map(entity) : [];
  return effectiveSocialDelivery(revision, delivery, ops);
}
