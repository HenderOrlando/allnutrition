import { fail, integer, text } from '../validation-core.mjs';
import { BUSINESS_TIME_ZONE, instant } from './dates.mjs';
import { canonicalJSON, hash } from './commands.mjs';
import { metaBudgetUnits } from '../social/meta.mjs';

const objective = (campaignObjective, optimizationGoal, destinationType = null) => Object.freeze({ campaignObjective, optimizationGoal, destinationType, billingEvent: 'IMPRESSIONS', bidStrategy: 'LOWEST_COST_WITHOUT_CAP', specialAdCategories: Object.freeze([]) });
export const SOCIAL_OBJECTIVE_CONFIG = Object.freeze({
  whatsapp: objective('OUTCOME_ENGAGEMENT', 'CONVERSATIONS', 'WHATSAPP'),
  traffic: objective('OUTCOME_TRAFFIC', 'LINK_CLICKS', 'WEBSITE'),
  reach: objective('OUTCOME_AWARENESS', 'REACH'),
  engagement: objective('OUTCOME_ENGAGEMENT', 'POST_ENGAGEMENT')
});
const FIELDS = ['name', 'connectionId', 'assetId', 'mode', 'objective', 'platforms', 'caption', 'headline', 'destinationUrl', 'whatsappNumber', 'whatsappGreeting', 'audience', 'placements', 'budgetMinor', 'currency', 'publishAt', 'startAt', 'endAt', 'observationDays', 'targetCostMinor', 'aiDisclosure', 'integrationMethod', 'timeZone'];
const PLATFORMS = ['facebook', 'instagram'];
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/placement-targeting
const API_PLACEMENTS = Object.freeze({ facebook_feed: 'feed', facebook_reels: 'facebook_reels', instagram_feed: 'stream', instagram_reels: 'reels' });
const PLACEMENTS = Object.keys(API_PLACEMENTS);
// ISO 3166-1 alpha-2; syntactically plausible but nonexistent country codes are not targeting.
const COUNTRIES = new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
const sensitive = /\b(diabet\w*|c[aá]ncer|obes\w*|depress\w*|depres\w*|anxiety|ansiedad|pregnan\w*|embaraz\w*|hiv|vih|aids|sida|asthma|asma|hypertension|hipertensi[oó]n|customer list|lista de clientes|custom audience|publico personalizado|público personalizado)\b/iu;
function object(value, label, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${label}: se esperaba un objeto.`);
  if (Object.keys(value).some(key => !keys.includes(key))) fail(`${label}: contiene campos no permitidos.`);
  return value;
}
function choice(value, choices, label) { if (!choices.includes(value)) fail(`${label}: valor no válido.`); return value; }
function set(value, choices, label, max = choices.length) {
  if (!Array.isArray(value) || value.length > max) fail(`${label}: lista no válida.`);
  return [...new Set(value.map(item => choice(item, choices, label)))].sort((a, b) => typeof a === 'number' ? a - b : a.localeCompare(b, 'en'));
}
const money = (value, label) => integer(value, label, 0, Number.MAX_SAFE_INTEGER);
function cityRadius(value, unit) {
  // City radii are not the smaller custom-location radii in Meta Basic Targeting.
  choice(unit, ['kilometer', 'mile'], 'Unidad del radio');
  return integer(value, 'Radio explícito de ciudad', unit === 'mile' ? 10 : 17, unit === 'mile' ? 50 : 80);
}
function referenceIdentity(context) {
  const { radius: _radius, distanceUnit: _unit, ...identity } = context;
  return identity;
}
const identifier = (value, label) => value == null || value === '' ? null : text(value, label, 100, true);
const normalizedText = (value, label, max) => text(value, label, max).normalize('NFC');
function identityContext(connection) {
  if (!connection) return { integrationMethod: null, identities: {}, currency: null, timeZone: null, connectionContext: null };
  const integrationMethod = choice(connection.integrationMethod, ['api', 'browser'], 'Vía de conexión');
  const identities = {};
  for (const key of ['userId', 'businessId', 'pageId', 'instagramId', 'adAccountId']) if (connection.identities?.[key] != null) identities[key] = text(connection.identities[key], 'Identidad de conexión', 100, true);
  const currency = connection.currency == null ? null : text(connection.currency, 'Moneda de cuenta', 3, true);
  const timeZone = connection.timeZone == null ? null : text(connection.timeZone, 'Zona de cuenta', 100, true);
  return { integrationMethod, identities, currency, timeZone, connectionContext: hash({ id: connection.id, integrationMethod, identities, currency, timeZone }) };
}
function reference(value, group) {
  object(value, 'Referencia de segmentación', ['key', 'source', 'providerId', 'label', 'context']);
  const source = choice(value.source, ['api', 'browser'], 'Fuente de segmentación');
  const key = text(value.key, 'Clave de segmentación', 200, true);
  let label = normalizedText(value.label, 'Etiqueta de segmentación', 200);
  if (!label) fail('La referencia requiere una etiqueta verificable.');
  let providerId, context;
  if (source === 'api') {
    providerId = text(value.providerId, 'ID Meta de segmentación', 100, true);
    if (!/^\d+$/.test(providerId)) fail('El ID Meta de segmentación no es válido.');
    const type = group === 'interests' ? 'interest' : group === 'regions' ? 'region' : 'city';
    const kind = type === 'interest' ? 'interest' : 'location';
    if (key !== `api:${kind}:${providerId}`) fail('La clave de segmentación no corresponde al ID Meta.');
    if (type === 'interest') {
      object(value.context, 'Contexto del interés', ['type', 'path']);
      if (value.context.type !== type || !Array.isArray(value.context.path) || value.context.path.length > 20) fail('Contexto de interés no válido.');
      context = { type, path: value.context.path.map(part => normalizedText(part, 'Ruta del interés', 200)) };
    } else {
      object(value.context, 'Contexto geográfico', ['type', 'countryCode', 'region', 'regionId', ...(type === 'city' ? ['radius', 'distanceUnit'] : [])]);
      if (value.context.type !== type || !COUNTRIES.has(value.context.countryCode)) fail('Contexto geográfico no válido.');
      const regionId = value.context.regionId == null ? null : text(value.context.regionId, 'ID región', 100, true);
      if (regionId !== null && !/^\d+$/.test(regionId)) fail('ID de región no válido.');
      context = { type, countryCode: value.context.countryCode, region: normalizedText(value.context.region, 'Región', 200), regionId };
      if (type === 'city' && (value.context.radius !== undefined || value.context.distanceUnit !== undefined)) {
        context.radius = cityRadius(value.context.radius, value.context.distanceUnit);
        context.distanceUnit = value.context.distanceUnit;
      }
    }
  } else {
    if (value.providerId != null) fail('La referencia nativa no inventa ni reutiliza un ID Meta.');
    providerId = null;
    label = label.normalize('NFKC').replace(/\s+/g, ' ');
    const type = group === 'interests' ? 'interest' : group === 'regions' ? 'region' : 'city';
    object(value.context, 'Contexto nativo', ['type', 'countryCode', 'region', 'scope', ...(type === 'city' ? ['radius', 'distanceUnit'] : [])]);
    const visible = value.context;
    if (visible.type !== type || !/^[a-f0-9]{64}$/.test(key)) fail('Referencia de navegador no verificable.');
    const scope = normalizedText(visible.scope, 'Ámbito visible', 200).normalize('NFKC').replace(/\s+/g, ' ');
    if (!scope) fail('Falta el ámbito nativo verificable.');
    if (type === 'interest') {
      if (visible.countryCode !== null || visible.region !== null) fail('La taxonomía del interés no es un ámbito geográfico.');
      context = { type, countryCode: null, region: null, scope };
    } else {
      if (!COUNTRIES.has(visible.countryCode)) fail('Falta el país verificable del ámbito nativo.');
      const region = normalizedText(visible.region, 'Región visible', 200).normalize('NFKC').replace(/\s+/g, ' ');
      if (!region) fail('Falta la jerarquía regional visible.');
      context = { type, countryCode: visible.countryCode, region, scope };
      if (type === 'city' && (visible.radius !== undefined || visible.distanceUnit !== undefined)) {
        context.radius = cityRadius(visible.radius, visible.distanceUnit);
        context.distanceUnit = visible.distanceUnit;
      }
    }
  }
  if (group === 'interests' && sensitive.test(`${label} ${canonicalJSON(context)}`)) fail('No se permite segmentación por condiciones de salud ni listas de clientes.');
  return { key, source, providerId, label, context };
}
function audience(value) {
  object(value, 'Audiencia', ['countries', 'regions', 'cities', 'ageMin', 'ageMax', 'genders', 'interests']);
  const countries = value.countries === undefined ? ['CO'] : set(value.countries, [...COUNTRIES], 'Países', 249);
  const result = { countries };
  for (const group of ['regions', 'cities', 'interests']) {
    const refs = value[group] ?? [];
    if (!Array.isArray(refs) || refs.length > 100) fail('Demasiadas referencias de segmentación.');
    result[group] = refs.map(ref => reference(ref, group)).sort((a, b) => a.key.localeCompare(b.key, 'en'));
    if (new Set(result[group].map(ref => ref.key)).size !== refs.length) fail('La segmentación contiene referencias duplicadas.');
  }
  result.ageMin = integer(value.ageMin ?? 18, 'Edad mínima', 18, 65);
  result.ageMax = integer(value.ageMax ?? 65, 'Edad máxima', 18, 65);
  if (result.ageMax < result.ageMin) fail('La edad máxima debe ser mayor o igual a la mínima.');
  result.genders = set(value.genders ?? [], [1, 2], 'Géneros');
  return result;
}
function url(value) {
  const input = text(value, 'URL de destino', 2048);
  if (!input) return '';
  let parsed; try { parsed = new URL(input); } catch { fail('URL de destino no válida.'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail('URL de destino no válida.');
  return parsed.href;
}

export function normalizeSocialCampaignInput(input, { previous = null, connection = null } = {}) {
  object(input, 'Campaña', FIELDS);
  for (const [field, max] of [['currency', 3], ['timeZone', 100]]) if (Object.hasOwn(input, field) && input[field] != null) text(input[field], field, max);
  const values = { ...Object.fromEntries(FIELDS.filter(key => previous?.[key] !== undefined).map(key => [key, previous[key]])), ...input };
  const context = identityContext(connection);
  const connectionId = identifier(values.connectionId, 'Conexión');
  if (connectionId && connection?.id !== connectionId) fail('La conexión seleccionada no corresponde al contexto.');
  if (!connectionId && connection) fail('El contexto requiere una conexión seleccionada.');
  if (Object.hasOwn(input, 'integrationMethod') && input.integrationMethod != null && input.integrationMethod !== context.integrationMethod) fail('La vía no coincide con la conexión.');
  const mode = choice(values.mode ?? 'organic', ['organic', 'paid'], 'Modalidad');
  const output = {
    name: normalizedText(values.name, 'Nombre', 200), connectionId, assetId: identifier(values.assetId, 'Pieza'), mode,
    objective: choice(values.objective ?? 'reach', Object.keys(SOCIAL_OBJECTIVE_CONFIG), 'Objetivo'),
    platforms: set(values.platforms ?? [], PLATFORMS, 'Redes'),
    caption: normalizedText(values.caption, 'Texto', 2200), headline: normalizedText(values.headline, 'Título', 40),
    destinationUrl: url(values.destinationUrl), whatsappNumber: text(values.whatsappNumber, 'WhatsApp', 16),
    whatsappGreeting: normalizedText(values.whatsappGreeting, 'Bienvenida de WhatsApp', 1024),
    audience: audience(values.audience ?? {}), placements: set(values.placements ?? [], PLACEMENTS, 'Ubicaciones'),
    budgetMinor: money(values.budgetMinor ?? 0, 'Presupuesto'), currency: context.currency,
    publishAt: instant(values.publishAt, 'Publicación', { nullable: true }), startAt: instant(values.startAt, 'Inicio', { nullable: true }), endAt: instant(values.endAt, 'Fin', { nullable: true }),
    observationDays: choice(values.observationDays ?? 7, [7, 14, 28], 'Horizonte de observación'),
    targetCostMinor: values.targetCostMinor == null ? null : money(values.targetCostMinor, 'Costo objetivo'),
    aiDisclosure: values.aiDisclosure ?? null,
    integrationMethod: context.integrationMethod, identities: context.identities,
    timeZone: mode === 'paid' ? context.timeZone : BUSINESS_TIME_ZONE, connectionContext: context.connectionContext
  };
  if (output.aiDisclosure !== null && typeof output.aiDisclosure !== 'boolean') fail('Declara explícitamente si la pieza contiene IA.');
  if (output.whatsappNumber && !/^\+[1-9]\d{6,14}$/.test(output.whatsappNumber)) fail('WhatsApp: usa un número internacional con prefijo +.');
  // The prior context, never a request-supplied context, controls scope migration.
  if (previous && (previous.connectionId !== connectionId || previous.connectionContext !== context.connectionContext)) {
    for (const group of ['regions', 'cities', 'interests']) output.audience[group] = [];
  }
  if (previous && previous.currency !== output.currency) { output.budgetMinor = 0; output.targetCostMinor = null; }
  return output;
}

function validateReferences(spec) {
  const { countries, regions, cities, interests } = spec.audience;
  for (const ref of [...regions, ...cities, ...interests]) {
    if (ref.source !== spec.integrationMethod) fail('La referencia pertenece a otra vía de integración.');
    if (ref.source === 'browser' && ref.key !== hash({ label: ref.label, context: referenceIdentity(ref.context), businessId: spec.identities.businessId })) fail('La referencia no pertenece al negocio observado.');
  }
  if (!countries.length && !regions.length && !cities.length) fail('Selecciona al menos un ámbito geográfico.');
  for (const city of cities) cityRadius(city.context.radius, city.context.distanceUnit);
  for (const ref of [...regions, ...cities]) if (countries.includes(ref.context.countryCode)) fail('No superpongas un país con sus regiones o ciudades.');
  if (spec.integrationMethod === 'api') {
    for (const city of cities) if (regions.some(region => region.providerId === city.context.regionId && region.context.countryCode === city.context.countryCode)) fail('No superpongas una región con sus ciudades.');
    if (regions.length && cities.some(city => !city.context.regionId)) fail('Falta la región verificable de la ciudad para descartar superposición.');
  } else {
    for (const city of cities) if (regions.some(region => region.context.countryCode === city.context.countryCode && region.context.region.toLocaleLowerCase('es') === city.context.region.toLocaleLowerCase('es'))) fail('No superpongas una región con sus ciudades.');
  }
}
function apiTargeting(spec) {
  const { countries, regions, cities, interests, ageMin, ageMax, genders } = spec.audience;
  const geo = { location_types: ['home', 'recent'] };
  if (countries.length) geo.countries = countries;
  if (regions.length) geo.regions = regions.map(ref => ({ key: ref.providerId }));
  if (cities.length) geo.cities = cities.map(ref => ({ key: ref.providerId, radius: ref.context.radius, distance_unit: ref.context.distanceUnit }));
  const targeting = { geo_locations: geo, age_min: ageMin, age_max: ageMax, publisher_platforms: spec.platforms, targeting_automation: { advantage_audience: 0 } };
  if (regions.length || cities.length) targeting.targeting_automation.individual_setting = { geo: 0 };
  if (genders.length) targeting.genders = genders;
  if (interests.length) targeting.flexible_spec = [{ interests: interests.map(ref => ({ id: ref.providerId, name: ref.label })) }];
  for (const network of spec.platforms) targeting[`${network}_positions`] = spec.placements.filter(placement => placement.startsWith(`${network}_`)).map(placement => API_PLACEMENTS[placement]).sort();
  return targeting;
}

function campaignSpecification(campaign, connection, asset) {
  if (!connection || campaign.connectionId !== connection.id || connection.state !== 'connected') fail('La conexión debe estar vigente.', 409);
  if (campaign.connectionContext !== identityContext(connection).connectionContext) fail('Cambió la identidad, moneda o zona de la conexión: guarda y revisa nuevamente el borrador.', 409);
  const input = Object.fromEntries(FIELDS.filter(key => campaign[key] !== undefined).map(key => [key, campaign[key]]));
  const { connectionContext: _context, ...configuration } = normalizeSocialCampaignInput(input, { connection });
  const boundAsset = asset?.id === configuration.assetId && asset.state === 'ready' ? asset : null;
  return { ...configuration, assetHash: boundAsset?.sha256 ?? null, assetType: boundAsset?.kind ?? null };
}
export function buildSocialDraftSpec(campaign, { connection, asset } = {}) {
  const spec = campaignSpecification(campaign, connection, asset);
  return { spec, specHash: hash(spec) };
}

export function buildSocialSpec(campaign, { connection, asset, now } = {}) {
  const clock = instant(now ?? new Date().toISOString(), 'Ahora');
  const spec = campaignSpecification(campaign, connection, asset);
  if (campaign.restore_hold || connection.restore_hold) fail('La campaña requiere reconciliación tras restaurar.', 409);
  if (connection.disconnectPending) fail('La conexión está completando su desconexión; no admite nuevas aprobaciones.', 409);
  if (!spec.name || !spec.assetId || !spec.platforms.length) fail('Completa nombre, pieza y redes antes de aprobar.');
  if (spec.aiDisclosure === null) fail('Declara explícitamente si la pieza contiene IA antes de aprobar.');
  if (!asset || asset.id !== spec.assetId || asset.state !== 'ready' || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? '') || asset.derivativeSha256 && asset.derivativeSha256 !== asset.sha256) fail('La pieza normalizada debe estar lista y conservar su hash.', 409);
  if (!['image', 'video'].includes(asset.kind)) fail('Tipo de pieza no compatible.');
  const identities = spec.identities;
  for (const key of ['userId', 'businessId', 'pageId', ...(spec.platforms.includes('instagram') ? ['instagramId'] : []), ...(spec.mode === 'paid' ? ['adAccountId'] : [])]) if (!identities[key]) fail('Falta una identidad verificada de la conexión.');
  if (spec.integrationMethod === 'api' && spec.aiDisclosure && (spec.mode === 'paid' || asset.kind === 'image' && spec.platforms.includes('facebook'))) {
    fail('Meta v26 no ofrece un campo verificado de divulgación de IA para fotos de Facebook o creativos de pauta en esta vía. Elige explícitamente una vía que pueda verificar la etiqueta; no se publicará sin ella.', 409);
  }
  const warnings = [];
  const warn = (key, message) => warnings.push({ key, message });
  if (spec.mode === 'paid') {
    if (connection.capabilities?.adsPublish !== true) fail('La conexión no tiene permiso para preparar pauta.');
    if (spec.objective === 'traffic' && !spec.destinationUrl) fail('El objetivo de tráfico requiere URL de destino.');
    if (spec.objective === 'whatsapp') {
      const page = connection.resources?.pages?.find(page => page.id === identities.pageId);
      if (connection.capabilities?.whatsappAds !== true || !page?.whatsappNumber || page.whatsappNumber !== spec.whatsappNumber) fail('WhatsApp debe coincidir con el número vinculado y autorizado de la página.');
      if (!spec.whatsappGreeting) fail('Escribe la bienvenida explícita para la pauta de WhatsApp.');
    }
    if (!spec.currency || !spec.timeZone) fail('Faltan moneda o zona horaria verificadas de la cuenta publicitaria.');
    try { new Intl.DateTimeFormat('en', { timeZone: spec.timeZone }); } catch { fail('Zona horaria de cuenta no válida.'); }
    if (spec.budgetMinor <= 0) fail('La pauta requiere un presupuesto total positivo.');
    metaBudgetUnits(spec.budgetMinor, spec.currency);
    if (spec.targetCostMinor !== null) metaBudgetUnits(spec.targetCostMinor, spec.currency);
    if (!spec.startAt || !spec.endAt || spec.publishAt) fail('La pauta requiere inicio y fin, sin agenda orgánica.');
    if (spec.startAt <= clock || spec.endAt <= spec.startAt || Date.parse(spec.endAt) - Date.parse(spec.startAt) > 90 * 86400000) fail('La pauta requiere inicio futuro, fin posterior y duración máxima de 90 días.');
    validateReferences(spec);
    if (spec.integrationMethod === 'api') {
      spec.targeting = apiTargeting(spec);
      warn('geoPresence', 'Las ubicaciones incluyen residentes y visitantes recientes; la ampliación por interés geográfico se solicita desactivada y debe verificarse antes de activar.');
    }
    warn('lifetimeBudget', 'Un único conjunto y anuncio comparten el presupuesto total, sin duplicarlo por red; impuestos y cargos pueden ser adicionales.');
    if (spec.objective === 'traffic') warn('linkClicksNotVisits', 'Tráfico mide clics de enlace, no visitas confirmadas ni ventas.');
  } else {
    for (const platform of spec.platforms) if (connection.capabilities?.[platform === 'facebook' ? 'facebookPublish' : 'instagramPublish'] !== true) fail(`La conexión no permite publicación orgánica en ${platform}.`);
    if (spec.budgetMinor !== 0 || spec.targetCostMinor !== null || spec.startAt || spec.endAt) fail('Orgánico no admite inversión, costo objetivo ni fechas de pauta.');
    if (spec.publishAt && spec.publishAt <= clock) fail('La publicación programada debe tener una fecha futura.');
    warn('organicDistribution', 'Orgánico no compra segmentación: la distribución depende de la página, sus públicos y la red.');
    if (spec.platforms.includes('instagram') && ['traffic', 'whatsapp'].includes(spec.objective)) warn('organicInstagramKpiUnavailable', 'Los enlaces del texto de Instagram no son CTA clicables; consultas, tráfico y costo por resultado no están disponibles para esta publicación.');
  }
  if (!spec.placements.length) fail('Selecciona ubicaciones explícitas.');
  for (const placement of spec.placements) {
    const platform = placement.startsWith('facebook_') ? 'facebook' : 'instagram';
    if (!spec.platforms.includes(platform)) fail('La ubicación no pertenece a las redes seleccionadas.');
    if (asset.kind === 'image' && !placement.endsWith('_feed') || asset.kind === 'video' && spec.mode === 'organic' && !placement.endsWith('_reels')) fail('La pieza no es compatible con la ubicación: imágenes en feed y videos orgánicos en Reels.');
  }
  for (const platform of spec.platforms) if (!spec.placements.some(placement => placement.startsWith(`${platform}_`))) fail('Cada red seleccionada requiere al menos una ubicación compatible.');
  return { spec, specHash: hash(spec), warnings };
}

export async function verifySocialApiTargeting(spec, { connector, signal } = {}) {
  if (spec.integrationMethod !== 'api' || spec.mode !== 'paid') return;
  validateReferences(spec);
  if (canonicalJSON(spec.targeting) !== canonicalJSON(apiTargeting(spec))) fail('La segmentación interna no coincide con la configuración aprobada.');
  const groups = ['regions', 'cities', 'interests'];
  if (groups.some(group => spec.audience[group].length) && typeof connector?.searchTargeting !== 'function') fail('El conector no permite comprobar la segmentación oficial.');
  for (const group of groups) for (const ref of spec.audience[group]) {
    const candidates = await connector.searchTargeting({ kind: group === 'interests' ? 'interest' : 'location', q: ref.label, signal });
    const matches = Array.isArray(candidates) ? candidates.filter(candidate => candidate.key === ref.key) : [];
    // Radius is explicit local delivery configuration, not part of the search identity.
    const expected = { ...ref, context: referenceIdentity(ref.context) };
    if (matches.length !== 1 || canonicalJSON(reference(matches[0], group)) !== canonicalJSON(expected)) fail('La referencia de segmentación ya no coincide exactamente con la búsqueda oficial.');
  }
}
