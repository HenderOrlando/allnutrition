import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fail, integer, text } from '../validation-core.mjs';
import { getAssistantSettings, loadAssistantRuntime, assertAssistantSession } from '../assistant/settings.mjs';
import { productImagePath } from '../media.mjs';
import { openSocialMediaFile } from '../social/media-files.mjs';
import { generateOpenAIImage, SOCIAL_IMAGE_MODEL } from '../social/openai-images.mjs';
import { entity, hash, insertRow, newId, stamp, assertLease, audit } from './commands.mjs';
import { claimJob, queueJobTx, finishJob, withLeaseHeartbeat, jobClock } from './job-leases.mjs';
import { createSocialAsset, uploadSocialAsset, getSocialAsset } from './social-media.mjs';
import { instant } from './dates.mjs';
import { assertSocialOfferCurrent, LOCAL_IMAGE, PUBLIC_IMAGE, socialLocalImage } from './social-offers.mjs';
import { socialPlacementMatches, unsupportedSocialDisclosure } from '../social/piece-compatibility.mjs';

const PREFIX = 'social:generation:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const IMAGE_FORMATS = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const SOCIAL_GENERATION_NOTICE = 'Esta solicitud envía a OpenAI las indicaciones, los datos mostrados y las imágenes seleccionadas. Puede generar un cargo variable sin tope garantizado. No incluyas datos de clientes ni información personal. Revisa el encuadre, producto, texto y derechos antes de publicar. Nunca se publica automáticamente.';
const UNCERTAIN = 'El envío pudo generar un cargo, pero no hay un resultado confirmado. No se repetirá automáticamente. Revisa el consumo en OpenAI y crea otra solicitud solo con nuevo consentimiento.';
const eligible = settings => settings.enabled && settings.provider === 'openai' && settings.authMethod === 'api-key' && settings.hasApiKey && settings.connectionStatus === 'ready' && (!settings.baseUrl || settings.baseUrl.replace(/\/$/, '') === 'https://api.openai.com/v1');
function exact(value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) fail('Solicitud de generación no válida.'); }
function ref(value) {
  exact(value, ['kind', 'id', 'version']);
  if (!['asset', 'product'].includes(value.kind) || !UUID.test(value.id || '')) fail('Fuente no válida; selecciona una pieza o un producto local.');
  return { kind: value.kind, id: value.id, version: integer(value.version, 'Versión de fuente', 1) };
}
const dataOf = job => Object.fromEntries(Object.entries(job).filter(([key]) => !['id', 'actorId', 'state', 'version', 'createdAt', 'updatedAt'].includes(key)));
async function readJob(store, id, actorId = null) {
  if (!UUID.test(id || '')) fail('Solicitud no válida.');
  const job = entity(await store.db.get(`SELECT * FROM ${store.t('social_generation_jobs')} WHERE id=?${actorId ? ' AND actor_id=?' : ''}`, [id, ...(actorId ? [actorId] : [])]));
  if (!job) fail('Solicitud no encontrada.', 404);
  return job;
}
async function saveJob(tx, job, state, patch, now) {
  const result = await tx.db.run(`UPDATE ${tx.t('social_generation_jobs')} SET state=?,data=?,version=version+1,updated_at=? WHERE id=? AND version=?`, [state, JSON.stringify({ ...dataOf(job), ...patch }), now, job.id, job.version]);
  if (!result.changes) fail('La solicitud cambió.', 409);
  return readJob(tx, job.id);
}
async function publicJob(store, job) {
  const safe = Object.fromEntries(['id', 'state', 'version', 'createdAt', 'updatedAt', 'campaignId', 'baseAssetId', 'briefHash', 'format', 'notice', 'sentAt', 'errorCode', 'assetId'].filter(key => job[key] !== undefined).map(key => [key, job[key]]));
  if (safe.assetId) {
    const asset = await getSocialAsset(store, safe.assetId);
    safe.asset = { id: asset.id, name: asset.name, version: asset.version, state: asset.state, kind: asset.kind, sha256: asset.sha256, contentType: asset.contentType, aiDisclosure: asset.aiDisclosure, reviewRequired: asset.reviewRequired, alignment: asset.generation?.alignment ?? null, diagnostic: asset.diagnostic || null, originalUrl: `/api/admin/social/assets/${asset.id}/content?variant=original`, previewUrl: asset.state === 'ready' ? `/api/admin/social/assets/${asset.id}/content` : null };
  }
  return safe;
}
async function productSource(store, id) {
  const row = await store.db.get(`SELECT * FROM ${store.t('records')} WHERE kind='products' AND id=?`, [id]);
  if (!row) fail('El producto ya no existe.', 409);
  const product = { ...JSON.parse(row.data), id: row.id, version: row.version };
  if (!socialLocalImage(product.image)) fail('El producto necesita una foto local subida o incluida en la vitrina; no se descargarán enlaces externos.', 409);
  return product;
}
async function fileBytes(key, sha256, size, env) {
  if (!SHA.test(sha256 || '') || !Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_BYTES) fail('La foto privada no tiene evidencia de integridad válida.', 409);
  const file = await openSocialMediaFile(key, { env, expectedSha256: sha256, expectedBytes: size });
  try {
    const bytes = await file.handle.readFile();
    if (bytes.length !== size || digest(bytes) !== sha256) fail('La foto privada cambió durante su lectura.', 409);
    return bytes;
  } finally { await file.handle.close(); }
}
async function localBytes(image, env) {
  const imageId = LOCAL_IMAGE.exec(image)?.[1];
  if (!imageId && !PUBLIC_IMAGE.test(image)) fail('La foto no es una referencia local segura.', 409);
  const directory = imageId ? env.MEDIA_DIR || join(process.cwd(), 'data', 'product-images') : join(process.cwd(), 'public');
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('El directorio de fotos no es seguro.', 409);
  const root = await realpath(directory), path = imageId ? await productImagePath(imageId, { directory: root }) : join(root, image.slice(1));
  if (!path || imageId && dirname(path) !== root || await realpath(path) !== path) fail('La foto local no está disponible de forma segura.', 409);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_SOURCE_BYTES) fail('La foto local no es válida.', 409);
    const bytes = await handle.readFile(), after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) fail('La foto cambió durante la lectura.', 409);
    return bytes;
  } finally { await handle.close(); }
}
async function privateAsset(store, id) {
  const asset = entity(await store.db.get(`SELECT * FROM ${store.t('social_assets')} WHERE id=?`, [id]));
  if (!asset) fail('La imagen privada ya no está disponible. Sube una foto nueva.', 409);
  return asset;
}
async function sourceBytes(store, source, env) {
  try {
    let bytes, snapshot, expectedFormat;
    if (['asset', 'base'].includes(source.kind)) {
      const asset = await privateAsset(store, source.id);
      if (asset.kind !== 'image' || !IMAGE_FORMATS[asset.contentType]) fail('Solo se puede ajustar una foto fija JPEG, PNG o WebP. Elige otra imagen.', 409);
      if (asset.state === 'ready' && asset.derivativeContentType === 'image/jpeg' && asset.sha256 === asset.derivativeSha256) {
        expectedFormat = 'jpeg';
        bytes = await fileBytes(asset.derivativeKey, asset.derivativeSha256, asset.derivativeBytes, env);
      } else if (source.kind === 'base' && asset.state === 'failed' && asset.diagnostic?.code === 'IMAGE_GEOMETRY' && !asset.derivativeKey && !asset.sha256) {
        expectedFormat = IMAGE_FORMATS[asset.contentType];
        const original = await fileBytes(asset.originalKey, asset.originalSha256, asset.originalBytes, env);
        const photo = sharp(original, { animated: true, limitInputPixels: 40000000, failOn: 'warning' });
        const metadata = await photo.metadata();
        if (metadata.format !== expectedFormat || (metadata.pages || 1) !== 1) fail('La foto original no es una imagen fija del tipo registrado. Reemplázala.', 409);
        bytes = await photo.rotate().resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').jpeg({ quality: 90 }).toBuffer();
        expectedFormat = 'jpeg';
      } else fail('La foto no está lista ni admite ajuste. Elige otro archivo o vuelve a subirlo.', 409);
      snapshot = { ...source, version: asset.version, title: source.kind === 'base' ? 'Imagen a modificar' : asset.name, facts: {}, state: asset.state };
    } else if (source.kind === 'catalog') {
      bytes = await localBytes(source.image, env);
      snapshot = source;
    } else {
      const product = await productSource(store, source.id);
      bytes = await localBytes(product.image, env);
      snapshot = { ...source, version: product.version, title: product.title, image: product.image, facts: catalogIdentity(product) };
    }
    const photo = sharp(bytes, { animated: true, limitInputPixels: 40000000, failOn: 'warning' }), metadata = await photo.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || expectedFormat && metadata.format !== expectedFormat || (metadata.pages || 1) !== 1) fail('Selecciona una foto fija válida.', 409);
    await photo.stats();
    const contentType = metadata.format === 'jpeg' ? 'image/jpeg' : `image/${metadata.format}`;
    return { bytes, contentType, snapshot: { ...snapshot, sha256: digest(bytes), bytes: bytes.length, contentType } };
  } catch (error) {
    if (error.status) throw error;
    fail('No se pudo comprobar una foto de referencia. Corrige la fuente o reemplázala antes de consentir.', 409);
  }
}

const DIRECTIONS = Object.freeze({
  reach: 'Haz reconocibles a primera vista la marca y la silueta o foto de la referencia. Usa un mensaje corto de descubrimiento sin forzar la compra.',
  engagement: 'Destaca un detalle real de la oferta y una pregunta breve sobre ese detalle para invitar a comentar. No inventes variantes, concursos ni premios.',
  traffic: 'Da jerarquía a una sola acción: conocer los detalles en el sitio elegido. No dibujes enlace o botón funcional, código QR ni un dominio inventado.',
  whatsapp: 'Destaca la oferta y su condición e invita a consultar por WhatsApp. No fabriques un número, conversación, botón funcional ni una venta asegurada.',
});
const privateText = /(?:https?:\/\/|www\.)\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\+?\d(?:[\s().-]*\d){7,}|(?:sk|pk)-[a-z0-9_-]{12,}/gi;
const storefrontText = value => typeof value === 'string' ? value.replace(privateText, '').trim() : '';
const catalogIdentity = value => ({ title: storefrontText(value.title), presentation: storefrontText(value.presentation), flavor: storefrontText(value.flavor), ...(value.brand ? { brand: storefrontText(value.brand) } : {}) });
const variantLabel = value => [value.title, value.presentation, value.flavor].filter(Boolean).join(' · ');
const catalogOffer = item => {
  if (!item) return null;
  for (const key of ['title', 'presentation', 'flavor', 'conditions', 'condition', 'productInfo']) {
    if (item[key] && storefrontText(item[key]) !== item[key].trim()) fail('La ficha contiene un enlace, teléfono u otro dato no apto para la pieza. Corrígelo en la oferta antes de preparar la imagen.', 409);
  }
  return { ...catalogIdentity(item), kind: item.kind, priceCOP: item.price, conditions: item.conditions, ...(item.condition ? { condition: item.condition } : {}),
    productInfo: item.productInfo, description: storefrontText(item.description),
    components: item.components.map(component => ({ ...catalogIdentity(component), quantity: component.quantity })) };
};
function destinationDomain(campaign) {
  if (campaign.objective !== 'traffic' || !campaign.destinationUrl) return null;
  const { hostname } = new URL(campaign.destinationUrl);
  return hostname.includes('.') && !/^\d+(?:\.\d+){3}$/.test(hostname) && !/\.(?:localhost|local|internal|test|example|invalid)$/i.test(hostname) ? hostname : null;
}
async function prepareBrief(store, { campaignId = null, baseAssetId = null, env = process.env } = {}) {
  for (const value of [campaignId, baseAssetId]) if (value !== null && !UUID.test(value || '')) fail('Identificador de borrador o foto no válido.');
  let campaign = null, currentOffer, connection = null;
  if (campaignId) {
    campaign = entity(await store.db.get(`SELECT * FROM ${store.t('social_campaigns')} WHERE id=?`, [campaignId]));
    if (!campaign) fail('Borrador no encontrado.', 404);
    if (campaign.state !== 'draft' || campaign.applicationMode === 'same' && campaign.recommendationInstructions?.changeType !== 'creative') fail('Este borrador no permite preparar otra imagen.', 409);
    currentOffer = await assertSocialOfferCurrent(store, campaign);
    if (campaign.connectionId) connection = entity(await store.db.get(`SELECT * FROM ${store.t('social_connections')} WHERE id=?`, [campaign.connectionId]));
  }
  if (baseAssetId && connection && campaign.platforms?.length) {
    if (unsupportedSocialDisclosure({ method: connection.integrationMethod, mode: campaign.mode, platforms: campaign.platforms, assetKind: 'image', disclosure: true })) fail('Esta vía de Meta no puede verificar la etiqueta del ajuste. Elige expresamente una vía compatible o usa otro archivo.', 409);
    if (connection.state !== 'connected' || connection.readOnly || connection.authenticationMethod === 'token' || (campaign.mode === 'paid' ? !connection.capabilities?.adsPublish : campaign.platforms.some(platform => !connection.capabilities?.[platform === 'facebook' ? 'facebookPublish' : 'instagramPublish']))) fail('Los destinos elegidos no tienen permiso de publicación. Revisa la conexión o elige otro archivo.', 409);
    if (campaign.placements.some(placement => !socialPlacementMatches(placement, 'image', campaign.mode))) fail('El ajuste entrega una imagen fija; revisa las ubicaciones elegidas antes de solicitarlo.', 409);
  }
  const settings = await store.settings(), logo = socialLocalImage(settings.logo), offer = currentOffer?.offerSnapshot ?? null;
  const ids = [...new Set([offer?.primary, offer?.gift].filter(Boolean).map(item => item.kind === 'combo' ? 'combos' : 'products'))];
  const catalogIds = new Set();
  if (ids.length) {
    const itemIds = [offer.primary.id, ...(offer.gift ? [offer.gift.id] : [])];
    for (const row of await store.db.all(`SELECT data FROM ${store.t('records')} WHERE kind IN ('products','combos') AND id IN (${itemIds.map(() => '?').join(',')})`, itemIds)) for (const id of JSON.parse(row.data).catalogIds || []) catalogIds.add(id);
  }
  const catalogs = catalogIds.size ? (await store.db.all(`SELECT title FROM ${store.t('records')} WHERE kind='catalogs' AND status='published' AND id IN (${[...catalogIds].map(() => '?').join(',')}) ORDER BY sort_order,id`, [...catalogIds])).map(row => storefrontText(row.title)).filter(Boolean) : [];
  const [messages, shipping] = await Promise.all([store.list('messages', { published: true }), store.list('shipping', { published: true })]);
  const brief = {
    brand: { name: storefrontText(settings.brandName), tagline: storefrontText(settings.tagline) },
    offer: offer ? { primary: catalogOffer(offer.primary), gift: catalogOffer(offer.gift) } : null,
    campaign: campaign ? { mode: campaign.mode, objective: campaign.objective, direction: DIRECTIONS[campaign.objective], platforms: campaign.platforms, placements: campaign.placements,
      headline: storefrontText(campaign.headline), caption: storefrontText(campaign.caption),
      destination: campaign.objective === 'traffic' ? { type: 'website', domain: destinationDomain(campaign) } : campaign.objective === 'whatsapp' ? { type: 'whatsapp' } : null,
      recommendation: storefrontText(campaign.recommendationInstructions?.text),
      businessObjective: connection?.measurementConfig?.updatedAt ? connection.measurementConfig.objective : null,
      instagramOrganic: campaign.mode === 'organic' && campaign.platforms?.includes('instagram') } : null,
    general: { catalogs, hours: storefrontText(settings.hours), messages: messages.map(row => ({ title: storefrontText(row.title), text: storefrontText(row.body) })),
      shipping: shipping.map(row => ({ area: storefrontText(row.zone), timing: storefrontText(row.estimatedTime) })) },
  };
  const base = baseAssetId ? await sourceBytes(store, { kind: 'base', id: baseAssetId }, env) : null;
  const candidates = new Map(), cap = base ? 3 : 4;
  function add(image, label) {
    if (!image) return;
    if (candidates.has(image)) { if (!candidates.get(image).includes(label)) candidates.get(image).push(label); }
    else if (candidates.size < cap) candidates.set(image, [label]);
  }
  if (campaign) {
    if (offer) {
      add(offer.primary.image, `Oferta principal: ${variantLabel(brief.offer.primary)}`);
      if (offer.gift) add(offer.gift.image, `Obsequio adicional: ${variantLabel(brief.offer.gift)}`);
      for (const [role, item] of [['oferta principal', offer.primary], ['obsequio adicional', offer.gift]]) for (const component of item?.components || []) add(component.image, `Componente de ${role}: ${variantLabel(catalogIdentity(component))}`);
    }
    add(logo, `Logo de ${brief.brand.name || 'la marca'}`);
  }
  const inputs = base ? [base] : [];
  for (const [image, labels] of candidates) inputs.push(await sourceBytes(store, { kind: 'catalog', image, labels }, env));
  const summaries = inputs.map(({ snapshot }) => snapshot);
  const briefHash = hash({ campaignId, campaignVersion: campaign?.version ?? null, offerHash: currentOffer?.offerHash ?? null, brief, sources: summaries });
  return { campaignId, campaignVersion: campaign?.version ?? null, briefHash, brief, inputs,
    alignment: campaign ? { mode: campaign.mode, objective: campaign.objective, offerHash: currentOffer?.offerHash ?? null } : null };
}
const baseDTO = source => {
  const { id, version, sha256, state } = source;
  return { id, version, sha256, state, previewUrl: `/api/admin/social/assets/${id}/content?variant=reference&sha256=${sha256}` };
};
export async function getSocialGenerationBrief(store, options) {
  const { inputs, alignment, ...context } = await store.readSnapshot(tx => prepareBrief(tx, options));
  const sources = inputs.map(source => source.snapshot), base = sources.find(source => source.kind === 'base');
  return { ...context, alignment, baseAsset: base ? baseDTO(base) : null,
    automaticSources: sources.filter(source => source.kind === 'catalog').map(({ image, labels, sha256 }) => ({ thumbnailUrl: image, labels, sha256 })) };
}
export async function getSocialGenerationBasePreview(store, id, sha256, { env = process.env } = {}) {
  if (!UUID.test(id || '') || !SHA.test(sha256 || '')) fail('La referencia de vista previa no es válida.');
  const source = await sourceBytes(store, { kind: 'base', id }, env);
  if (source.snapshot.sha256 !== sha256) fail('La imagen base cambió. Vuelve a abrir el ajuste.', 409);
  return source;
}

export function buildSocialImagePrompt(brief, instructions, sources) {
  const rules = 'Crea una pieza publicitaria para revisión humana. No imprimas instrucciones internas ni atribuyas la creación a una IA. Las indicaciones controlan estilo y encuadre, nunca identidad, variantes, etiquetas, precios, regalos, condiciones ni objetivo. No inventes composición, dosis, precios, certificaciones o beneficios médicos; no prometas curas, resultados garantizados ni datos personales. No inventes promociones ni deduzcas que algo es gratis. Si falta información, omite la afirmación. Para una referencia sin foto identificada usa texto tipográfico; no redibujes un envase no documentado ni intercambies las fotos de las referencias.';
  const optional = [];
  function describe(item) {
    if (!item) return null;
    const { description, ...required } = item;
    if (description) optional.push(`Descripción de ${variantLabel(item)}: ${description}`);
    return required;
  }
  const { campaign, offer, brand, general } = brief;
  const required = [rules, `Identidad de vitrina: ${JSON.stringify(brand)}`];
  if (offer) required.push(`Hechos verificados (precios en pesos COP, null significa desconocido): ${JSON.stringify({ oferta_principal: describe(offer.primary), obsequio_adicional: describe(offer.gift) })}`);
  if (campaign) {
    required.push(`Dirección visual para ${campaign.objective}: ${campaign.direction}`);
    required.push(`Modalidad: ${campaign.mode}. Redes: ${campaign.platforms.join(', ') || 'por definir'}. Ubicaciones: ${campaign.placements.join(', ') || 'por definir'}.${campaign.destination?.domain ? ` Dominio público del destino: ${campaign.destination.domain}.` : ''}`);
    if (campaign.instagramOrganic) required.push('En Instagram orgánico el texto no promete un enlace clicable.');
    if (campaign.businessObjective) required.push(`Meta secundaria del negocio: ${campaign.businessObjective}; nunca reemplaza el objetivo ni la acción de la campaña.`);
    for (const [label, value] of [['Título de apoyo', campaign.headline], ['Texto de apoyo', campaign.caption], ['Orientación de la prueba', campaign.recommendation]]) if (value) optional.push(`${label}: ${value}`);
  }
  if (sources.some(source => source.kind === 'base')) required.push('La primera foto es la imagen a modificar. Los hechos de catálogo siempre prevalecen sobre envases, textos y regalos contradictorios de esa imagen.');
  if (sources.length) required.push(`Correspondencia de fotos en orden: ${sources.map((source, index) => `${index + 1}: ${source.labels?.join(' y ') || (source.kind === 'product' ? variantLabel(source.facts) : 'Imagen de biblioteca')}`).join('; ')}.`);
  else required.push('Sin fotos de referencia: compón un diseño tipográfico y no simules envases.');
  if (instructions) required.push(`Indicaciones para esta imagen: ${instructions}`);
  if (general.catalogs.length) optional.push(`Catálogos publicados: ${general.catalogs.join(', ')}`);
  if (general.hours) optional.push(`Horario general (no es condición de la promoción): ${general.hours}`);
  for (const message of general.messages) if (message.title || message.text) optional.push(`Mensaje general de la marca (no es condición de la promoción): ${message.title} · ${message.text}`);
  for (const zone of general.shipping) if (zone.area || zone.timing) optional.push(`Cobertura/horario general de envío (no es condición de la promoción): ${zone.area} · ${zone.timing}`);
  let prompt = required.join('\n\n');
  if (prompt.length > 12000) fail('Identidad, componentes, etiqueta, condiciones e indicaciones superan 12 000 caracteres. Acorta la ficha o las indicaciones antes de solicitar la imagen.');
  for (const block of optional) if (prompt.length + block.length + 2 <= 12000) prompt += `\n\n${block}`;
  return prompt;
}
export async function listSocialGenerationSources(store, filters = {}) {
  const query = text(filters.query || '', 'Búsqueda', 100), offset = integer(Number(filters.offset || 0), 'Desplazamiento', 0, 1000000), limit = integer(Number(filters.limit || 20), 'Límite', 1, 30);
  const field = (name, key) => store.provider === 'sqlite' ? `json_extract(${name},'$.${key}')` : `${name}::json->>'${key}'`;
  const pattern = `%${query.toLowerCase().replace(/[!%_]/g, char => '!' + char)}%`;
  const sql = `SELECT 'asset' AS source_kind,id,data,version,created_at FROM ${store.t('social_assets')} WHERE state='ready' AND ${field('data', 'kind')}='image' AND LOWER(${field('data', 'name')}) LIKE ? ESCAPE '!' UNION ALL SELECT 'product' AS source_kind,id,data,version,created_at FROM ${store.t('records')} WHERE kind='products' AND (${field('data', 'image')} LIKE '/api/media/%' OR ${field('data', 'image')} LIKE '/brand/%') AND LOWER(${field('data', 'title')}) LIKE ? ESCAPE '!' ORDER BY created_at DESC,id LIMIT ? OFFSET ?`;
  const rows = await store.db.all(sql, [pattern, pattern, limit + 1, offset]);
  const sources = rows.slice(0, limit).flatMap(row => {
    const data = JSON.parse(row.data);
    if (row.source_kind === 'product' && !LOCAL_IMAGE.test(data.image || '') && !PUBLIC_IMAGE.test(data.image || '')) return [];
    return [{ kind: row.source_kind, id: row.id, version: row.version, title: row.source_kind === 'asset' ? data.name : data.title, thumbnailUrl: row.source_kind === 'asset' ? `/api/admin/social/assets/${row.id}/content` : data.image, facts: row.source_kind === 'product' ? catalogIdentity(data) : {} }];
  });
  return { sources, offset, limit, hasMore: rows.length > limit, nextOffset: rows.length > limit ? offset + limit : null };
}
export async function getSocialGeneration(store, id, actorId) { return publicJob(store, await readJob(store, id, actorId)); }
export async function listSocialGenerations(store, actorId, { campaignId = null } = {}) {
  if (campaignId !== null && !UUID.test(campaignId || '')) fail('Identificador de borrador no válido.');
  const field = store.provider === 'sqlite' ? "json_extract(data,'$.campaignId')" : "data::json->>'campaignId'";
  const settings = await getAssistantSettings(store), rows = await store.db.all(`SELECT * FROM ${store.t('social_generation_jobs')} WHERE actor_id=?${campaignId ? ` AND ${field}=?` : ''} ORDER BY created_at DESC,id LIMIT 30`, [actorId, ...(campaignId ? [campaignId] : [])]);
  const available = eligible(settings);
  return { availability: { available, configurationVersion: settings.version, formats: ['png', 'gif'], notice: SOCIAL_GENERATION_NOTICE, reason: available ? null : 'No está configurado el servicio de imágenes. Puedes subir una pieza o elegirla de biblioteca sin perder el borrador.' }, jobs: await Promise.all(rows.map(row => publicJob(store, entity(row)))) };
}
async function manualInputs(store, sources, env) {
  const inputs = [];
  for (const source of sources) {
    const input = await sourceBytes(store, { kind: source.kind, id: source.id }, env);
    if (input.snapshot.version !== source.version) fail('Una fuente cambió. Vuelve a seleccionarla y consiente de nuevo.', 409);
    inputs.push(input);
  }
  return inputs;
}
const consentFlags = ['cost', 'externalProcessing', 'noCustomerData', 'humanReview'];
const compliantConsent = consent => consent?.version === 2 && consentFlags.every(key => consent[key] === true);
export async function requestSocialGeneration(store, input, session, { env = process.env, now = stamp() } = {}) {
  now = instant(now); exact(input, ['requestId', 'configurationVersion', 'prompt', 'format', 'frameCount', 'frameDurationMs', 'sources', 'consent', 'campaignId', 'campaignVersion', 'briefHash', 'baseAsset']);
  exact(input.consent, ['version', ...consentFlags]);
  if (!compliantConsent(input.consent)) fail('Debes consentir el costo variable, envío a OpenAI, ausencia de datos de clientes y revisión humana antes de solicitar.');
  const { campaignId, campaignVersion, briefHash } = input;
  if (campaignId === null ? campaignVersion !== null : !UUID.test(campaignId || '') || !Number.isSafeInteger(campaignVersion) || campaignVersion < 1) fail('La versión del borrador no es válida.');
  if (!SHA.test(briefHash || '')) fail('Abre y revisa el encargo antes de solicitar la imagen.');
  let baseAsset = null;
  if (input.baseAsset !== null) {
    exact(input.baseAsset, ['id', 'version', 'sha256']);
    const { id, version, sha256 } = input.baseAsset;
    if (!UUID.test(id || '') || !SHA.test(sha256 || '')) fail('La foto base no es válida.');
    baseAsset = { id, version: integer(version, 'Versión de la foto', 1), sha256 };
  }
  const requestId = text(input.requestId, 'Solicitud', 100, true), prompt = text(input.prompt, 'Indicaciones', 4000, !campaignId || baseAsset !== null), configurationVersion = integer(input.configurationVersion, 'Configuración', 1);
  if (storefrontText(prompt) !== prompt) fail('Retira los enlaces, teléfonos u otros datos privados de las indicaciones.');
  if (!UUID.test(requestId) || !['png', 'gif'].includes(input.format) || baseAsset && input.format !== 'png') fail('Solicitud o formato no válido.');
  if (!Array.isArray(input.sources) || (campaignId ? input.sources.length !== 0 : input.sources.length > (baseAsset ? 3 : 4))) fail('Selecciona como máximo cuatro imágenes; en campaña se usan las referencias automáticas.');
  const sources = input.sources.map(ref);
  if (new Set(sources.map(source => `${source.kind}:${source.id}`)).size !== sources.length || sources.some(source => source.kind === 'asset' && source.id === baseAsset?.id)) fail('No repitas fuentes.');
  const frameCount = input.format === 'gif' ? integer(input.frameCount ?? 9, 'Frames', 2, 16) : null, frameDurationMs = input.format === 'gif' ? integer(input.frameDurationMs ?? 400, 'Duración de frame', 20, 2000) : null;
  if (input.format === 'png' && (input.frameCount != null || input.frameDurationMs != null) || input.format === 'gif' && (frameDurationMs % 10 || frameCount * frameDurationMs < 3000 || frameCount * frameDurationMs > 32000)) fail('El GIF requiere frames de múltiplos de 10 ms y una duración total entre 3 y 32 segundos.');
  const payload = { prompt, format: input.format, frameCount, frameDurationMs, sources, configurationVersion, campaignId, campaignVersion, briefHash, baseAsset, consent: input.consent }, requestHash = hash(payload);
  return store.transaction(async tx => {
    await assertAssistantSession(tx, session, { lock: true });
    const prior = entity(await tx.db.get(`SELECT * FROM ${tx.t('social_generation_jobs')} WHERE actor_id=? AND ${tx.provider === 'sqlite' ? "json_extract(data,'$.requestId')" : "data::json->>'requestId'"}=?`, [session.user.id, requestId]));
    if (prior) { if (prior.requestHash !== requestHash) fail('La solicitud ya se recibió con datos diferentes.', 409); return publicJob(tx, prior); }
    const settings = await getAssistantSettings(tx);
    if (!eligible(settings) || settings.version !== configurationVersion) fail('La configuración de OpenAI no está disponible o cambió. Recarga y vuelve a consentir.', 409);
    const context = await prepareBrief(tx, { campaignId, baseAssetId: baseAsset?.id ?? null, env });
    const reviewedBase = context.inputs[0]?.snapshot;
    if (context.campaignVersion !== campaignVersion || context.briefHash !== briefHash || baseAsset && (reviewedBase?.version !== baseAsset.version || reviewedBase?.sha256 !== baseAsset.sha256)) fail('Cambió el borrador, el encargo o una foto. Vuelve a revisar los datos y consiente de nuevo.', 409);
    const snapshots = [...context.inputs, ...await manualInputs(tx, sources, env)].map(({ snapshot }) => snapshot);
    buildSocialImagePrompt(context.brief, prompt, snapshots);
    const id = newId(), data = { ...payload, brief: context.brief, alignment: context.alignment, baseAssetId: baseAsset?.id ?? null, sourceRefs: sources, sources: snapshots, requestId, requestHash, consent: { ...input.consent, notice: SOCIAL_GENERATION_NOTICE, acceptedAt: now }, phase: 'queued', queuedAt: now, model: SOCIAL_IMAGE_MODEL, notice: 'En cola; aún no se ha enviado al servicio de imágenes.' };
    await insertRow(tx, 'social_generation_jobs', { id, actor_id: session.user.id, state: 'queued', data: JSON.stringify(data), version: 1, created_at: now, updated_at: now });
    await queueJobTx(tx, PREFIX + id, { generationId: id, phase: 'queued' }, { now });
    await audit(tx, { entityType: 'social_generation', entityId: id, actorId: session.user.id, reason: 'Solicitud explícita con consentimiento de costo variable y procesamiento externo; no publica.', recordedAt: now });
    return publicJob(tx, await readJob(tx, id));
  });
}
async function fence(tx, job, lease, now) {
  await assertLease(tx, { ...lease, now });
  const actor = await tx.db.get(`SELECT active FROM ${tx.t('users')} WHERE id=?`, [job.actorId]);
  const settings = await getAssistantSettings(tx);
  if (!Number(actor?.active) || !eligible(settings) || settings.version !== job.configurationVersion) fail('El actor o la configuración cambiaron; no se enviará esta solicitud.', 409);
}
async function checkJobContext(store, job, env) {
  if (!compliantConsent(job.consent)) fail('El consentimiento es anterior a este flujo; revisa y autoriza una nueva solicitud.', 409);
  const context = await prepareBrief(store, { campaignId: job.campaignId, baseAssetId: job.baseAssetId, env });
  if (context.campaignVersion !== job.campaignVersion || context.briefHash !== job.briefHash || hash(context.brief) !== hash(job.brief) || hash(context.alignment) !== hash(job.alignment)) fail('Cambió la oferta, los datos del negocio o el encargo. No se enviará.', 409);
  const inputs = [...context.inputs, ...await manualInputs(store, job.sourceRefs, env)];
  if (hash(inputs.map(({ snapshot }) => snapshot)) !== hash(job.sources)) fail('Una fuente cambió. No se enviará.', 409);
  return inputs;
}
async function generationTurn(store, lease, { env, now, transport }) {
  return withLeaseHeartbeat(store, lease, async ({ clock, assertActive }) => {
    let sent = false;
    const id = lease.generationId || lease.key.slice(PREFIX.length);
    try {
      let job = await readJob(store, id);
      if (job.state !== 'queued') {
        if (job.state === 'sending') {
          let retained = null;
          if (job.assetId) retained = await getSocialAsset(store, job.assetId);
          await store.transaction(async tx => { await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() }); await saveJob(tx, await readJob(tx, id), retained && ['processing', 'ready'].includes(retained.state) ? 'succeeded' : 'uncertain', { phase: retained && ['processing', 'ready'].includes(retained.state) ? 'saved' : 'uncertain', finishedAt: clock(), notice: retained && ['processing', 'ready'].includes(retained.state) ? 'Original conservado en biblioteca; revisa el derivado antes de publicar.' : UNCERTAIN }, clock()); });
        }
        await finishJob(store, lease, { now: clock() }); return;
      }
      await store.transaction(async tx => { await tx.lockWrites(); await fence(tx, job, lease, clock()); });
      const runtime = await loadAssistantRuntime(store, { env });
      if (!eligible(runtime) || runtime.configurationVersion !== job.configurationVersion || !runtime.apiKey) fail('La configuración cambió; no se enviará esta solicitud.', 409);
      const inputs = await store.readSnapshot(tx => checkJobContext(tx, job, env));
      const prompt = buildSocialImagePrompt(job.brief, job.prompt, job.sources);
      const output = await generateOpenAIImage({ apiKey: runtime.apiKey, actorId: job.actorId, prompt, format: job.format, frameCount: job.frameCount, frameDurationMs: job.frameDurationMs, inputs, signal: AbortSignal.timeout(300000), beforePost: async () => {
        assertActive();
        await store.transaction(async tx => {
          await tx.lockWrites(); await fence(tx, job, lease, clock());
          await checkJobContext(tx, job, env);
          const current = await readJob(tx, id);
          if (current.state !== 'queued') fail('La solicitud ya fue enviada.', 409);
          await saveJob(tx, current, 'sending', { phase: 'sending', sentAt: clock(), notice: 'Preparando imagen. La solicitud puede generar un cargo y no se repetirá automáticamente.' }, clock());
          await assertLease(tx, { ...lease, now: clock() });
        });
        sent = true;
      } }, { transport });
      assertActive(); await assertLease(store, { ...lease, now: clock() });
      const generation = { jobId: id, provider: 'openai', model: output.model, briefHash: job.briefHash, promptSha256: digest(prompt), generatedAt: clock(), format: job.format,
        ...(job.alignment ? { alignment: job.alignment } : {}), ...(job.baseAsset ? { baseAssetId: job.baseAsset.id, baseAssetSha256: job.baseAsset.sha256 } : {}) };
      const asset = await createSocialAsset(store, { name: `Generación ${job.format.toUpperCase()} ${id.slice(0, 8)}`, contentType: output.contentType, expectedBytes: output.bytes.length, requestId: `${id}:asset` }, job.actorId, { env, now: clock(), generation });
      await store.transaction(async tx => { await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() }); await saveJob(tx, await readJob(tx, id), 'sending', { phase: 'saving', assetId: asset.id, notice: 'Respuesta recibida; conservando original y preparando derivado revisable.' }, clock()); });
      await uploadSocialAsset(store, asset.id, { version: asset.version, requestId: `${id}:upload`, contentType: output.contentType, contentLength: output.bytes.length, body: (async function* () { yield output.bytes; })() }, job.actorId, { env, now: clock() });
      await store.transaction(async tx => { await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() }); await saveJob(tx, await readJob(tx, id), 'succeeded', { phase: 'saved', finishedAt: clock(), notice: 'Original guardado. El derivado se procesa en biblioteca; revisa producto, texto, claims y derechos. No se ha publicado.' }, clock()); });
      await finishJob(store, lease, { now: clock() });
    } catch {
      // Never store provider exceptions, bodies, headers or custody failures.
      // A sent marker survives process death and prevents a second billable POST.
      try {
        await store.transaction(async tx => {
          await tx.lockWrites(); await assertLease(tx, { ...lease, now: clock() });
          const current = await readJob(tx, id), uncertain = sent || current.state === 'sending';
          await saveJob(tx, current, uncertain ? 'uncertain' : 'blocked', { phase: uncertain ? 'uncertain' : 'blocked', finishedAt: clock(), notice: uncertain ? UNCERTAIN : 'No se envió la solicitud. Cambió el acceso, la configuración, el contexto o una foto. Revisa y autoriza de nuevo.', errorCode: uncertain ? 'GENERATION_UNCERTAIN' : 'GENERATION_FENCE' }, clock());
        });
        await finishJob(store, lease, { state: 'failed', errorCode: sent ? 'GENERATION_UNCERTAIN' : 'GENERATION_FENCE', now: clock() });
      } catch { /* A lost lease is recovered by the next owner from durable state. */ }
    }
  }, { now });
}
export async function processSocialGenerationTurn(store, { now = stamp(), env = process.env, transport = globalThis.fetch } = {}) {
  now = instant(now); const clock = jobClock(now), lease = await claimJob(store, { prefix: PREFIX, now });
  if (lease) await generationTurn(store, lease, { env, now: clock(), transport });
  const due = await store.db.get(`SELECT key FROM ${store.t('job_runs')} WHERE key LIKE 'social:generation:%' AND (state='queued' OR (state='running' AND lease_until<=?)) LIMIT 1`, [clock()]);
  return { processed: lease ? 1 : 0, hasMore: Boolean(due) };
}
