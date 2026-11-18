import { fail, text } from '../validation-core.mjs';

export const SOCIAL_OFFER_KINDS = Object.freeze(['product', 'gift', 'combo']);
export const SOCIAL_OFFER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SOCIAL_OFFER_HASH = /^[a-f0-9]{64}$/;

export function exactSocialOfferObject(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('La referencia de oferta no tiene la forma esperada.');
}

export function normalizeSocialOfferRef(value) {
  if (value === null) return null;
  exactSocialOfferObject(value, ['primary', 'gift']);
  const { primary, gift } = value;
  exactSocialOfferObject(primary, ['kind', 'id', 'factsHash']);
  if (!SOCIAL_OFFER_KINDS.includes(primary.kind) || typeof primary.id !== 'string' || !SOCIAL_OFFER_ID.test(primary.id) || typeof primary.factsHash !== 'string' || !SOCIAL_OFFER_HASH.test(primary.factsHash)) fail('Selecciona una referencia de oferta válida.');
  let additional = null;
  if (gift !== null) {
    exactSocialOfferObject(gift, ['id', 'factsHash', 'condition']);
    if (primary.kind === 'gift' || typeof gift.id !== 'string' || !SOCIAL_OFFER_ID.test(gift.id) || primary.id === gift.id || typeof gift.factsHash !== 'string' || !SOCIAL_OFFER_HASH.test(gift.factsHash) || typeof gift.condition !== 'string') fail('Selecciona un obsequio adicional válido, distinto de la compra.');
    additional = { id: gift.id, factsHash: gift.factsHash, condition: text(gift.condition, 'Condición del obsequio', 500) };
  }
  return { primary: { kind: primary.kind, id: primary.id, factsHash: primary.factsHash }, gift: additional };
}
