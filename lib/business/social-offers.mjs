import { fail, integer, text } from '../validation-core.mjs';
import { inventoryAvailability, stockAvailable } from '../inventory.mjs';
import { exactSocialOfferObject, normalizeSocialOfferRef, SOCIAL_OFFER_HASH, SOCIAL_OFFER_ID, SOCIAL_OFFER_KINDS } from '../social/offer-ref.mjs';
import { hash } from './commands.mjs';

export const LOCAL_IMAGE = /^\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export const PUBLIC_IMAGE = /^\/brand\/[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.(?:jpe?g|png|webp)$/i;
export const socialLocalImage = value => typeof value === 'string' && (LOCAL_IMAGE.test(value) || PUBLIC_IMAGE.test(value)) ? value : null;
const kindOf = record => record.kind === 'combos' ? 'combo' : record.productType ?? 'product';
const enabled = record => record && record.status !== 'archived' && (record.orderable ?? record.status === 'published');
const validProduct = product => enabled(product) && kindOf(product) === 'product' && !product.items?.length;
const decode = row => ({ ...JSON.parse(row.data), id: row.id, kind: row.kind, title: row.title, status: row.status });
const composed = record => ['combo', 'gift'].includes(kindOf(record));
const quantityOk = quantity => Number.isSafeInteger(quantity) && quantity > 0;
const idOk = id => typeof id === 'string' && SOCIAL_OFFER_ID.test(id);
const priceOk = price => Number.isSafeInteger(price) && price >= 0;
const placeholders = values => values.map(() => '?').join(',');

async function componentsFor(store, records) {
  const ids = [...new Set(records.flatMap(record => composed(record) && Array.isArray(record.items) ? record.items.map(item => item?.productId).filter(idOk) : []))];
  if (!ids.length) return new Map();
  const rows = await store.db.all(`SELECT id,kind,title,status,data FROM ${store.t('records')} WHERE kind='products' AND id IN (${placeholders(ids)})`, ids);
  return new Map(rows.map(row => [row.id, decode(row)]));
}
function variant(record) {
  return { id: record.id, title: record.title, presentation: record.presentation || '', flavor: record.flavor || '', image: socialLocalImage(record.image) };
}
function factsOf(record, products) {
  return { ...variant(record), kind: kindOf(record), brand: record.brand || '', description: record.description || '', productInfo: record.productInfo || '',
    price: priceOk(record.price) ? record.price : null, conditions: kindOf(record) === 'combo' ? record.conditions || '' : '',
    components: (composed(record) && Array.isArray(record.items) ? record.items : []).flatMap(item => {
      const component = products.get(item?.productId);
      return component && quantityOk(item.quantity) ? [{ ...variant(component), quantity: item.quantity }] : [];
    }) };
}
function availability(record, products) {
  if (!enabled(record)) return 'unavailable';
  if (composed(record)) {
    if (!record.items?.length || record.items.some(item => !validProduct(products.get(item?.productId)) || !quantityOk(item?.quantity))) return 'unavailable';
  } else if (!validProduct(record)) return 'unavailable';
  return inventoryAvailability(record, products);
}
const eligible = state => state === 'consult' || state === 'available';
function summary(record, products) {
  const status = availability(record, products);
  return { ...variant(record), kind: kindOf(record), sku: record.sku || '', price: priceOk(record.price) ? record.price : null, availability: status, selectable: eligible(status) };
}
async function findRecords(store, selectors) {
  const ids = [...new Set(selectors.map(selector => selector.id))];
  const rows = await store.db.all(`SELECT id,kind,title,status,data FROM ${store.t('records')} WHERE kind IN ('products','combos') AND id IN (${placeholders(ids)})`, ids);
  const byId = new Map(rows.map(row => [row.id, decode(row)]));
  return selectors.map(selector => {
    const record = byId.get(selector.id);
    return record && kindOf(record) === selector.kind ? record : null;
  });
}

export async function listSocialOffers(store, filters = {}) {
  const { kind } = filters;
  if (kind != null && !SOCIAL_OFFER_KINDS.includes(kind)) fail('Tipo de oferta no válido.');
  const query = text(filters.query ?? '', 'Búsqueda', 100);
  if (['offset', 'limit'].some(key => filters[key] != null && !/^\d+$/.test(String(filters[key])))) fail('Paginación de ofertas no válida.');
  const offset = integer(Number(filters.offset ?? 0), 'Desplazamiento', 0, 1000000), limit = integer(Number(filters.limit ?? 12), 'Límite', 1, 30);
  const field = key => store.provider === 'sqlite' ? `json_extract(data,'$.${key}')` : `data::json->>'${key}'`;
  const type = `CASE WHEN kind='combos' THEN 'combo' ELSE COALESCE(${field('productType')},'product') END`;
  const fold = store.provider === 'sqlite' ? 'offer_casefold' : 'LOWER';
  const on = store.provider === 'sqlite' ? '1' : "'true'", off = store.provider === 'sqlite' ? '0' : "'false'";
  const pattern = `%${query.toLocaleLowerCase('es').replace(/[!%_]/g, char => '!' + char)}%`;
  const search = ['title', ...['presentation', 'flavor', 'sku'].map(field)].map(value => `${fold}(COALESCE(${value},'')) LIKE ? ESCAPE '!'`).join(' OR ');
  const rows = await store.db.all(`SELECT id,kind,title,status,data FROM ${store.t('records')}
    WHERE kind IN ('products','combos') AND status<>'archived'
      AND COALESCE(${field('orderable')},CASE WHEN status='published' THEN ${on} ELSE ${off} END)=${on}
      AND ${type} ${kind == null ? "IN ('product','gift','combo')" : '=?'} AND (${search})
    ORDER BY ${fold}(title),title,id LIMIT ? OFFSET ?`, [...(kind == null ? [] : [kind]), pattern, pattern, pattern, pattern, limit + 1, offset]);
  const records = rows.slice(0, limit).map(decode), products = await componentsFor(store, records);
  return { offers: records.map(record => summary(record, products)), nextOffset: rows.length > limit ? offset + limit : null };
}

export async function getSocialOffer(store, kind, id) {
  if (!SOCIAL_OFFER_KINDS.includes(kind) || !idOk(id)) fail('Referencia de oferta no válida.');
  const [record] = await findRecords(store, [{ kind, id }]);
  if (!record) fail('La referencia ya no existe o cambió de tipo.', 404);
  const products = await componentsFor(store, [record]), facts = factsOf(record, products);
  return { ...summary(record, products), ...facts, factsHash: hash(facts) };
}

export async function resolveSocialOffer(store, offerRef, { requireCondition = false } = {}) {
  if (offerRef == null) return {};
  offerRef = normalizeSocialOfferRef(offerRef);
  const refs = [offerRef.primary, ...(offerRef.gift ? [{ ...offerRef.gift, kind: 'gift' }] : [])];
  const records = await findRecords(store, refs);
  if (records.some(record => !record)) fail('La oferta cambió de tipo o ya no existe. Vuelve a revisar la ficha o quita la selección.', 409);
  const products = await componentsFor(store, records), facts = records.map(record => factsOf(record, products));
  if (facts.some((value, idx) => hash(value) !== refs[idx].factsHash)) fail('Cambió la ficha comercial de la oferta. Vuelve a revisar sus datos o quita la selección.', 409);
  if (records.some(record => !eligible(availability(record, products)))) fail('La oferta o sus componentes ya no están disponibles. Cambia la referencia o quita la selección.', 409);
  if (offerRef.gift) {
    const counts = new Map();
    for (const record of records) {
      const items = composed(record) ? record.items : [{ productId: record.id, quantity: 1 }];
      for (const item of items) counts.set(item.productId, (counts.get(item.productId) || 0) + item.quantity);
    }
    for (const [id, quantity] of counts) {
      const available = stockAvailable(products.get(id) || records[0]);
      if (available !== null && available < quantity) fail('No hay existencias para una unidad de la compra y el obsequio juntos. Cambia la selección.', 409);
    }
    if (requireCondition && !offerRef.gift.condition) fail('Escribe la condición exacta del obsequio adicional antes de preparar la imagen o aprobar.', 409);
  }
  const offerSnapshot = { primary: facts[0], gift: offerRef.gift ? { ...facts[1], condition: offerRef.gift.condition } : null };
  return { offerRef, offerSnapshot, offerHash: hash(offerSnapshot) };
}

export async function assertSocialOfferCurrent(store, campaign) {
  if (!campaign.offerRef && !campaign.offerHash && !campaign.offerSnapshot) return;
  const current = await resolveSocialOffer(store, campaign.offerRef, { requireCondition: true });
  if (!current.offerHash || current.offerHash !== campaign.offerHash || hash(campaign.offerSnapshot ?? null) !== current.offerHash) fail('La oferta guardada no coincide con la que se revisó. Vuelve a revisarla.', 409);
  return current;
}

const variantKeys = ['id', 'title', 'presentation', 'flavor', 'image'];
const factKeys = [...variantKeys, 'kind', 'brand', 'description', 'productInfo', 'price', 'conditions', 'components'];
export function assertSocialOfferSnapshot(snapshot, expectedHash, ref) {
  if (snapshot == null && expectedHash == null && ref == null) return;
  exactSocialOfferObject(snapshot, ['primary', 'gift']);
  const verifyVariant = value => {
    if (!idOk(value.id) || value.image !== null && !socialLocalImage(value.image) || ['title', 'presentation', 'flavor'].some(key => typeof value[key] !== 'string')) fail('Variante histórica de oferta no válida.');
  };
  const verifyFacts = (value, isGift) => {
    exactSocialOfferObject(value, [...factKeys, ...(isGift ? ['condition'] : [])]);
    verifyVariant(value);
    if (!SOCIAL_OFFER_KINDS.includes(value.kind) || isGift && value.kind !== 'gift' || value.price !== null && !priceOk(value.price) || ['brand', 'description', 'productInfo', 'conditions'].some(key => typeof value[key] !== 'string') || !Array.isArray(value.components) || isGift && (typeof value.condition !== 'string' || value.condition.length > 500)) fail('Ficha histórica de oferta no válida.');
    for (const component of value.components) {
      exactSocialOfferObject(component, [...variantKeys, 'quantity']);
      verifyVariant(component);
      if (!quantityOk(component.quantity)) fail('Cantidad histórica de oferta no válida.');
    }
  };
  verifyFacts(snapshot.primary, false);
  if (snapshot.gift !== null) {
    verifyFacts(snapshot.gift, true);
    if (snapshot.primary.kind === 'gift' || snapshot.primary.id === snapshot.gift.id) fail('Obsequio adicional histórico no válido.');
  }
  if (!SOCIAL_OFFER_HASH.test(expectedHash || '') || hash(snapshot) !== expectedHash) fail('Hash histórico de oferta incoherente.');
  if (ref !== undefined) {
    ref = normalizeSocialOfferRef(ref);
    const { primary, gift } = snapshot;
    const expected = { primary: { kind: primary.kind, id: primary.id, factsHash: hash(primary) }, gift: null };
    if (gift) { const { condition, ...facts } = gift; expected.gift = { id: facts.id, factsHash: hash(facts), condition }; }
    if (hash(ref) !== hash(expected)) fail('Selector histórico de oferta incoherente.');
  }
}
