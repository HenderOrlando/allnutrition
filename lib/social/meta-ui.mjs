import { hash } from '../business/commands.mjs';
import { parseMoneyMinor } from '../business/money.mjs';
import { socialPermalink } from './evidence.mjs';
import { parseBrowserMetricExport, normalizeBrowserMetricTable, browserMetricScope, BROWSER_METRIC_DEFINITION_VERSION, BrowserMetricExportError } from './browser-metrics.mjs';

export const META_UI_VERSION = 'meta-ui-v2';
// These semantic surfaces are deliberately fail-closed. Current Meta DOM/permissions
// still require acceptance with an authorized account; local fixtures do not certify them.
export class MetaUIError extends Error {
  constructor(errorCode) { super(errorCode); this.name = 'MetaUIError'; this.errorCode = errorCode; }
}
const fail = code => { throw new MetaUIError(code); };
const labels = {
  business: /^(Business portfolio|Portafolio comercial)$/i, page: /^(Page|Página)$/i, account: /^(Ad account|Cuenta publicitaria)$/i,
  objective: /^(Campaign objective|Objetivo de la campaña)$/i, caption: /^(Post text|Texto de la publicación)$/i,
  headline: /^(Headline|Título)$/i, destinationUrl: /^(Website URL|URL del sitio web)$/i, whatsappNumber: /^(WhatsApp number|Número de WhatsApp)$/i,
  whatsappGreeting: /^(WhatsApp welcome message|Mensaje de bienvenida de WhatsApp)$/i,
  countries: /^(Countries|Países)$/i, regions: /^(Regions|Regiones)$/i, cities: /^(Cities|Ciudades)$/i,
  ageMin: /^(Minimum age|Edad mínima)$/i, ageMax: /^(Maximum age|Edad máxima)$/i, genders: /^(Genders|Géneros)$/i,
  interests: /^(Interests|Intereses)$/i, budgetType: /^(Budget type|Tipo de presupuesto)$/i,
  budget: /^(Total budget|Presupuesto total)$/i, startAt: /^(Start date and time|Fecha y hora de inicio)$/i,
  endAt: /^(End date and time|Fecha y hora de finalización)$/i,
  expansion: /^(Advantage\+ audience|Público Advantage\+)$/i, automaticPlacements: /^(Advantage\+ placements|Ubicaciones Advantage\+)$/i,
  aiDisclosure: /^(AI disclosure|Divulgación de IA)$/i,
  enhancements: /^(Automatic creative enhancements|Mejoras creativas automáticas)$/i,
  automaticMusic: /^(Automatic music|Música automática)$/i,
  crop: /^(Media framing|Encuadre del contenido multimedia)$/i,
  cta: /^(Call to action|Llamada a la acción)$/i,
  geoExpansion: /^(Geographic expansion|Ampliación geográfica)$/i,
  contentFormat: /^(Content format|Formato de publicación)$/i,
  publishingSchedule: /^(Publishing schedule|Programación de publicación)$/i,
  shareToFeed: /^(Share Reel to feed|Compartir reel en el feed)$/i,
  media: /^(Add photos or videos|Agregar fotos o videos)$/i,
  campaignName: /^(Campaign name|Nombre de la campaña)$/i,
  periodStart: /^(Reporting starts|Inicio del informe)$/i, periodEnd: /^(Reporting ends|Fin del informe)$/i,
  breakdown: /^(Breakdown|Desglose)$/i
};
const objectives = {
  whatsapp: /^(WhatsApp conversations|Conversaciones de WhatsApp)$/i,
  traffic: /^(Website traffic|Tráfico al sitio web)$/i, reach: /^(Reach|Alcance)$/i,
  engagement: /^(Post engagement|Interacción con la publicación)$/i
};
const placements = {
  facebook_feed: /^(Facebook Feed|Feed de Facebook)$/i, instagram_feed: /^(Instagram Feed|Feed de Instagram)$/i,
  facebook_reels: /^(Facebook Reels|Reels de Facebook)$/i, instagram_reels: /^(Instagram Reels|Reels de Instagram)$/i
};
const identityLabels = {
  userId: ['User ID', 'ID de usuario'], businessId: ['Business ID', 'ID del negocio'], pageId: ['Page ID', 'ID de la página'],
  instagramId: ['Instagram account ID', 'ID de la cuenta de Instagram'], adAccountId: ['Ad account ID', 'ID de la cuenta publicitaria']
};
const normalize = text => String(text ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function lineValue(text, names, required = true) {
  const values = [...new Set(names.flatMap(name => [...text.matchAll(new RegExp(`^\\s*${escaped(name)}\\s*:\\s*(.*?)\\s*$`, 'gmi'))].map(match => normalize(match[1]))))];
  if (values.length !== 1) { if (!required && values.length === 0) return null; fail('LAYOUT_CHANGED'); }
  return values[0];
}
const numericId = text => /^(?:act_)?[0-9]{1,30}$/.test(text || '') ? text.replace(/^act_/, '') : fail('LAYOUT_CHANGED');
const split = text => normalize(text) ? text.split(/\s*;\s*/).map(normalize).filter(Boolean).sort() : [];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const refLabels = values => (values || []).map(value => normalize(typeof value === 'string' ? value : value.label)).sort();

export function createMetaUI({ page, origin = 'https://business.facebook.com', assertLease, markMutation, verifyMedia, allowDownload, isAllowedUrl, publishingEnabled = process.env.SOCIAL_PUBLISHING_ENABLED === 'true' }) {
  let locale = null;
  const uploadedMedia = new Map();
  async function mediaScope() {
    return lineValue(await text(), ['Draft ID', 'ID del borrador', 'Campaign ID', 'ID de la campaña', 'Content ID', 'ID del contenido'], false) || 'composer';
  }
  function restoreMediaEvidence(payload) {
    const evidence = payload.operation?.data?.mediaEvidence || payload.operation?.mediaEvidence || payload.delivery?.mediaEvidence || payload.delivery?.data?.mediaEvidence;
    const scope = remoteId(payload) || draftId(payload);
    if (!evidence || !scope || ![scope, draftId(payload)].includes(evidence.scope) || evidence.sha256 !== payload.spec?.assetHash || !/^\d{1,30}$/.test(evidence.remoteMediaId || '') || typeof evidence.name !== 'string') return;
    uploadedMedia.set(scope, { name: evidence.name, sha256: evidence.sha256, remoteMediaId: evidence.remoteMediaId });
  }
  function humanResolution(payload) {
    const resolution = payload.operation?.resolution || payload.operation?.data?.resolution;
    return resolution?.kind === 'link' && resolution.acceptContentVerification === true && (!resolution.specHash || resolution.specHash === hash(payload.spec));
  }
  async function unique(locator) {
    if (await locator.count() !== 1 || !await locator.isVisible()) fail('LAYOUT_CHANGED');
    return locator;
  }
  async function main() { return unique(page.getByRole('main')); }
  async function text() { const value = await (await main()).innerText(); if (value.length > 250000) fail('LAYOUT_CHANGED'); return value; }
  async function language() {
    const lang = (await page.locator('html').getAttribute('lang') || '').toLowerCase();
    if (!/^(es|en)(-|$)/.test(lang)) fail('LAYOUT_CHANGED');
    locale = lang.startsWith('es') ? 'es' : 'en'; return locale;
  }
  async function field(name) {
    const root = await main();
    return unique(['business', 'page', 'account', 'objective', 'budgetType', 'breakdown', 'crop', 'cta', 'contentFormat', 'publishingSchedule'].includes(name)
      ? root.getByRole('combobox', { name: labels[name], exact: true })
      : root.getByLabel(labels[name], { exact: true }));
  }
  async function read(name) { return normalize(await (await field(name)).inputValue()); }
  async function fill(name, value) { assertLease(); await (await field(name)).fill(String(value ?? '')); }
  async function button(name) { return unique((await main()).getByRole('button', { name, exact: true })); }
  async function click(name) { assertLease(); await (await button(name)).click(); }
  async function select(name, option) {
    const input = await field(name);
    const options = input.getByRole('option');
    const candidates = [];
    for (let i = 0; i < await options.count(); i++) if (option.test(normalize(await options.nth(i).innerText()))) candidates.push(await options.nth(i).getAttribute('value'));
    if (candidates.length !== 1) fail('LAYOUT_CHANGED');
    assertLease(); await input.selectOption(candidates[0]);
  }
  async function selected(name) {
    const input = await field(name), value = await input.inputValue();
    const options = input.getByRole('option');
    const matches = [];
    for (let i = 0; i < await options.count(); i++) if (await options.nth(i).getAttribute('value') === value) matches.push(normalize(await options.nth(i).innerText()));
    if (matches.length !== 1) fail('LAYOUT_CHANGED');
    return matches[0];
  }
  async function connection({ expectedIdentities = {}, allowLogin = false, selectAssets = false, purpose = 'normal' } = {}) {
    if (purpose === 'pause') expectedIdentities = Object.fromEntries(['userId', 'adAccountId'].filter(key => expectedIdentities[key]).map(key => [key, expectedIdentities[key]]));
    assertLease(); await language();
    const content = await text();
    const hasAuthenticatedIdentity = identityLabels.userId.some(name => new RegExp(`^\\s*${escaped(name)}\\s*:`, 'mi').test(content));
    const challenge = await (await main()).getByRole('heading', { name: /^(Security check|Two-factor authentication|Confirm it's you|Checkpoint|CAPTCHA|Verificación de seguridad|Autenticación en dos pasos|Confirma que eres tú)$/i }).count();
    if (challenge) {
      if (allowLogin) return { state: 'challenge_required', authenticated: false, inputAllowed: !hasAuthenticatedIdentity };
      fail('CHALLENGE_REQUIRED');
    }
    if (await (await main()).getByRole('textbox', { name: /^(Email or phone|Email address or phone number|Correo electrónico o teléfono|Correo electrónico o número de teléfono)$/i }).count() || await (await main()).getByLabel(/^(Password|Contraseña)$/i, { exact: true }).count()) {
      if (allowLogin) return { state: 'login_required', authenticated: false, inputAllowed: !hasAuthenticatedIdentity };
      fail('SESSION_EXPIRED');
    }
    const identities = {};
    for (const [key, names] of Object.entries(identityLabels)) {
      if (purpose === 'pause' && !['userId', 'adAccountId'].includes(key)) continue;
      const value = lineValue(content, names, key === 'userId' || purpose === 'pause' && key === 'adAccountId');
      if (value && value !== '—') identities[key] = numericId(value);
    }
    if (selectAssets) {
      for (const key of ['userId', 'businessId']) if (expectedIdentities[key] && String(expectedIdentities[key]) !== identities[key]) fail('ACCOUNT_MISMATCH');
      for (const [key, name] of [['pageId', 'page'], ['adAccountId', 'account']]) {
        const requested = String(expectedIdentities[key] || '').replace(/^act_/, '');
        if (!requested || identities[key] === requested) continue;
        if (!/^\d{1,30}$/.test(requested)) fail('ACCOUNT_MISMATCH');
        const input = await field(name), options = input.getByRole('option'), matches = [];
        for (let i = 0; i < await options.count(); i++) {
          const label = normalize(await options.nth(i).innerText());
          if (new RegExp(`\\((?:ID|Identificador):\\s*(?:act_)?${escaped(requested)}\\)$`, 'i').test(label)) matches.push(await options.nth(i).getAttribute('value'));
        }
        if (matches.length !== 1) fail('ACCOUNT_MISMATCH');
        assertLease(); await input.selectOption(matches[0]);
      }
      return connection({ expectedIdentities, allowLogin, purpose });
    }
    for (const [key, value] of Object.entries(expectedIdentities || {})) {
      if (value !== null && value !== undefined && value !== '' && (!Object.hasOwn(identityLabels, key) || identities[key] !== String(value).replace(/^act_/, ''))) fail('ACCOUNT_MISMATCH');
    }
    if (purpose === 'pause') {
      if (!expectedIdentities.userId || !expectedIdentities.adAccountId) fail('ACCOUNT_MISMATCH');
      return { state: 'connected', authenticated: true, inputAllowed: false, identities: { userId: identities.userId, adAccountId: identities.adAccountId }, adapterVersion: META_UI_VERSION };
    }
    async function resources(name, type) {
      const locator = (await main()).getByRole('combobox', { name: labels[name], exact: true });
      if (!await locator.count()) return [];
      const options = (await unique(locator)).getByRole('option');
      const result = [];
      for (let i = 0; i < await options.count(); i++) {
        const label = normalize(await options.nth(i).innerText());
        if (/^(Select|Seleccionar|—)/i.test(label)) continue;
        const match = label.match(/^(.*?)\s*\((?:ID|Identificador):\s*((?:act_)?\d+)\)$/i);
        if (!match) fail('LAYOUT_CHANGED');
        const id = numericId(match[2]);
        if (result.some(item => item.id === id)) fail('LAYOUT_CHANGED');
        result.push({ id, name: match[1], ...(type === 'page' ? { businessId: identities.businessId || null, instagramId: id === identities.pageId ? identities.instagramId || null : null } : type === 'account' ? { businessId: identities.businessId || null } : {}) });
      }
      return result;
    }
    const businesses = await resources('business', 'business'), pages = await resources('page', 'page'), adAccounts = await resources('account', 'account');
    const currency = lineValue(content, ['Currency', 'Moneda'], false), timeZone = lineValue(content, ['Time zone', 'Zona horaria'], false);
    if (currency && !/^[A-Z]{3}$/.test(currency)) fail('LAYOUT_CHANGED');
    if (timeZone) { try { new Intl.DateTimeFormat('en', { timeZone }); } catch { fail('LAYOUT_CHANGED'); } }
    const enabled = async name => {
      const control = (await main()).getByRole('button', { name, exact: true });
      return await control.count() === 1 && await control.isVisible() && await control.isEnabled();
    };
    // Capabilities come from effective visible controls, not account names or cookies.
    const facebookPublish = Boolean(identities.pageId && await enabled(/^(Create Facebook post|Crear publicación de Facebook)$/i));
    const instagramType = lineValue(content, ['Instagram account type', 'Tipo de cuenta de Instagram'], false);
    const instagramPublish = Boolean(identities.instagramId && /^(Business|Creator|Empresa|Creador)$/i.test(instagramType || '') && await enabled(/^(Create Instagram post|Crear publicación de Instagram)$/i));
    const accountState = lineValue(content, ['Ad account status', 'Estado de la cuenta publicitaria'], false);
    const accountEnabled = /^(Active|Activa|Activo)$/i.test(accountState || '');
    const adsPublish = Boolean(identities.adAccountId && identities.pageId && accountEnabled && currency && timeZone && await enabled(/^(Create campaign|Crear campaña)$/i));
    const whatsappNumber = lineValue(content, ['Linked WhatsApp number', 'Número de WhatsApp vinculado'], false);
    for (const resource of pages) if (resource.id === identities.pageId) Object.assign(resource, { whatsappNumber: whatsappNumber || null, instagramType: instagramType || null });
    for (const account of adAccounts) if (account.id === identities.adAccountId) Object.assign(account, { currency, timeZone, accountStatus: accountEnabled ? 1 : null });
    return { state: 'connected', authenticated: true, inputAllowed: false, identities, resources: { businesses, pages, adAccounts },
      capabilities: { facebookPublish, instagramPublish, adsPublish, insights: await enabled(/^(View insights|Ver estadísticas)$/i), whatsappAds: Boolean(adsPublish && /^\+\d{7,15}$/.test(whatsappNumber || '') && await enabled(objectives.whatsapp)) },
      currency, timeZone, locale, adapterVersion: META_UI_VERSION, validatedAt: new Date().toISOString() };
  }
  async function open() { assertLease(); await page.goto(new URL('/latest/home', origin).href, { waitUntil: 'domcontentloaded', timeout: 30000 }); }
  function authorize(operation, spec, { pause = false, draft = false, readOnly = false } = {}) {
    assertLease();
    if (!operation || typeof operation.id !== 'string' || !operation.id || operation.state !== 'sent' || typeof operation.step !== 'string') fail('SPEC_MISMATCH');
    if (!pause && !readOnly && !publishingEnabled) fail('PUBLISHING_DISABLED');
    const authorizedHash = operation.specHash || operation.data?.specHash;
    if (!pause && (!spec || authorizedHash !== hash(spec))) fail('SPEC_MISMATCH');
    if (draft && operation.acceptPrivateDraft !== true && operation.data?.acceptPrivateDraft !== true) fail('SPEC_MISMATCH');
  }
  function assertWhatsApp(connected, spec) {
    if (spec?.mode !== 'paid' || spec.objective !== 'whatsapp') return;
    const page = connected.resources.pages.find(item => item.id === spec.identities.pageId);
    if (!connected.capabilities.whatsappAds || page?.whatsappNumber !== spec.whatsappNumber || !normalize(spec.whatsappGreeting)) fail('PERMISSION_REQUIRED');
  }
  async function guardedClick(name, operation, spec, options) {
    const control = await button(name);
    authorize(operation, spec, options);
    const connected = await connection({ expectedIdentities: options?.expectedIdentities || spec?.identities, purpose: options?.pause ? 'pause' : 'normal' });
    if (!options?.pause && !['prepare', 'targeting'].includes(operation.step)) assertWhatsApp(connected, spec);
    if (!await control.isEnabled()) fail('PERMISSION_REQUIRED');
    markMutation();
    try { await control.click(); assertLease(); }
    catch { fail('OPERATION_UNCERTAIN'); }
  }
  async function safeLink(name, id, { readOnly = false, expectedIdentities = {} } = {}) {
    assertLease(); await page.goto(new URL('/latest/home', origin).href, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (readOnly) await connection({ expectedIdentities });
    const links = (await main()).getByRole('link', { name, exact: true });
    const matches = [];
    for (let i = 0; i < await links.count(); i++) {
      const link = links.nth(i), label = normalize(await link.innerText());
      // Explicit remote ID in visible label; caption/date and DOM IDs never establish identity.
      if (new RegExp(`(?:ID|Identificador):\\s*${escaped(id)}(?:\\D|$)`, 'i').test(label)) matches.push(link);
    }
    if (matches.length !== 1) fail('LAYOUT_CHANGED');
    const href = await matches[0].getAttribute('href'), url = new URL(href, page.url());
    if (!await isAllowedUrl(url.href)) fail('AUTH_FAILED');
    assertLease(); await matches[0].click();
  }
  function references(payload) { return payload.operation?.data?.resolution?.refs || payload.operation?.resolution?.refs || payload.operation?.data?.preparedRefs || payload.operation?.preparedRefs || payload.delivery?.data?.preparedRefs || payload.delivery?.preparedRefs || payload.delivery?.remoteRefs || {}; }
  function draftId(payload) { return payload.remoteDraftRef || payload.operation?.remoteDraftRef || payload.operation?.data?.remoteDraftRef || payload.delivery?.remoteDraftRef || payload.delivery?.data?.remoteDraftRef || references(payload).remoteDraftRef; }
  function remoteId(payload) { return payload.remoteId || payload.delivery?.remoteId || payload.delivery?.remote_id || payload.operation?.remoteId || payload.operation?.data?.remoteId || references(payload).remoteId || references(payload).campaignId; }
  async function openDraft(payload) {
    const id = draftId(payload);
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) fail('SPEC_MISMATCH');
    await safeLink(/^(?:Draft|Borrador) .*\((?:ID|Identificador):\s*\d+\)$/i, id);
    await connection({ expectedIdentities: payload.expectedIdentities || payload.spec?.identities });
    const actual = lineValue(await text(), ['Draft ID', 'ID del borrador']);
    if (actual !== id) fail('ACCOUNT_MISMATCH');
    return id;
  }
  async function format() {
    const value = lineValue(await text(), ['Number format', 'Formato numérico']);
    if (value === '1,234.56') return { decimalSeparator: '.', groupSeparator: ',' };
    if (value === '1.234,56') return { decimalSeparator: ',', groupSeparator: '.' };
    fail('LAYOUT_CHANGED');
  }
  async function money(value) { try { return parseMoneyMinor(value, await format()); } catch { fail('SPEC_MISMATCH'); } }
  const geoNames = {
    regions: /^(Selected regions|Regiones seleccionadas)$/i,
    cities: /^(Selected cities|Ciudades seleccionadas)$/i,
    interests: /^(Selected interests|Intereses seleccionados)$/i
  };
  // Every part of a reference is visible provider text, not DOM IDs or proposal data.
  async function reference(locator, businessId, withRadius = false) {
    const content = await locator.innerText();
    const label = lineValue(content, ['Name', 'Nombre']);
    const typeLabel = lineValue(content, ['Type', 'Tipo']);
    const type = ({ Country: 'country', País: 'country', Region: 'region', Región: 'region', City: 'city', Ciudad: 'city', Interest: 'interest', Interés: 'interest' })[typeLabel];
    if (!type) fail('LAYOUT_CHANGED');
    const countryCode = lineValue(content, ['Country code', 'Código de país'], type !== 'interest');
    const region = lineValue(content, ['Region', 'Región'], ['region', 'city'].includes(type));
    const scope = lineValue(content, ['Scope', 'Ámbito']);
    if (type !== 'interest' && !/^[A-Z]{2}$/.test(countryCode || '') || type === 'interest' && countryCode && countryCode !== '—') fail('LAYOUT_CHANGED');
    const context = { type, countryCode: type === 'interest' ? null : countryCode, region: ['region', 'city'].includes(type) ? region : null, scope };
    const key = hash({ label, context, businessId });
    if (withRadius && type === 'city') {
      const radius = await unique(locator.getByRole('spinbutton', { name: /^(Radius|Radio)$/i, exact: true }));
      const unit = await unique(locator.getByRole('combobox', { name: /^(Distance unit|Unidad de distancia)$/i, exact: true }));
      context.radius = Number(await radius.inputValue());
      const visibleUnit = await unit.locator('option:checked').innerText();
      context.distanceUnit = /^(Kilometers|Kilómetros)$/i.test(visibleUnit) ? 'kilometer' : /^(Miles|Millas)$/i.test(visibleUnit) ? 'mile' : fail('LAYOUT_CHANGED');
      const [min, max] = context.distanceUnit === 'kilometer' ? [17, 80] : [10, 50];
      if (!Number.isFinite(context.radius) || context.radius < min || context.radius > max) fail('SPEC_MISMATCH');
    }
    return { key, source: 'browser', providerId: null, label, context };
  }
  async function selectedReferences(key, businessId) {
    const group = await unique((await main()).getByRole('group', { name: geoNames[key], exact: true }));
    const items = group.getByRole('listitem'), result = [];
    for (let i = 0; i < await items.count(); i++) result.push(await reference(items.nth(i), businessId, true));
    if (new Set(result.map(item => item.key)).size !== result.length) fail('LAYOUT_CHANGED');
    return result.sort((a, b) => a.key.localeCompare(b.key));
  }
  async function searchReferences(query, businessId) {
    const input = await unique((await main()).getByRole('combobox', { name: query.kind === 'interest' ? /^(Search interests|Buscar intereses)$/i : /^(Search locations|Buscar ubicaciones)$/i, exact: true }));
    assertLease(); await input.fill(query.q);
    const options = (await unique((await main()).getByRole('listbox'))).getByRole('option'), result = [];
    for (let i = 0; i < await options.count(); i++) result.push({ locator: options.nth(i), value: await reference(options.nth(i), businessId) });
    if (new Set(result.map(item => item.value.key)).size !== result.length) fail('LAYOUT_CHANGED');
    return result;
  }
  async function fillReferences(key, values, businessId) {
    const group = await unique((await main()).getByRole('group', { name: geoNames[key], exact: true }));
    assertLease(); await (await unique(group.getByRole('button', { name: /^(Remove all|Quitar todo)$/i, exact: true }))).click();
    for (const wanted of values || []) {
      const matches = (await searchReferences({ kind: key === 'interests' ? 'interest' : 'location', q: wanted.label }, businessId)).filter(item => item.value.key === wanted.key);
      if (matches.length !== 1) fail('SPEC_MISMATCH');
      assertLease(); await matches[0].locator.click();
      if (key === 'cities') {
        const items = group.getByRole('listitem'), matches = [];
        for (let i = 0; i < await items.count(); i++) if ((await reference(items.nth(i), businessId)).key === wanted.key) matches.push(items.nth(i));
        if (matches.length !== 1 || !wanted.context?.radius || !wanted.context?.distanceUnit) fail('SPEC_MISMATCH');
        const item = matches[0], unit = await unique(item.getByRole('combobox', { name: /^(Distance unit|Unidad de distancia)$/i, exact: true }));
        const unitText = wanted.context.distanceUnit === 'kilometer' ? /^(Kilometers|Kilómetros)$/i : wanted.context.distanceUnit === 'mile' ? /^(Miles|Millas)$/i : fail('SPEC_MISMATCH');
        const choices = unit.getByRole('option'), selected = [];
        for (let i = 0; i < await choices.count(); i++) if (unitText.test(await choices.nth(i).innerText())) selected.push(await choices.nth(i).getAttribute('value'));
        if (selected.length !== 1) fail('LAYOUT_CHANGED');
        assertLease(); await unit.selectOption(selected[0]); await (await unique(item.getByRole('spinbutton', { name: /^(Radius|Radio)$/i, exact: true }))).fill(String(wanted.context.radius));
      }
    }
  }
  async function previewMedia(name, kind) {
    const root = await main();
    const locator = kind === 'video' ? name ? root.getByLabel(name, { exact: true }) : root.locator('video') : root.getByRole('img', name ? { name, exact: true } : { name: /.+/ });
    await locator.waitFor({ state: 'visible' });
    await unique(locator);
    const handle = await locator.elementHandle();
    try {
      const ready = await page.waitForFunction(({ element, kind }) => kind === 'video'
        ? element.tagName === 'VIDEO' && element.readyState >= 1 && element.videoWidth > 0 && Number.isFinite(element.duration) && element.duration > 0
        : element.tagName === 'IMG' && element.complete && element.naturalWidth > 0,
      { element: handle, kind }, { timeout: 15000 });
      await ready.dispose();
    } catch { fail('LAYOUT_CHANGED'); }
    finally { await handle?.dispose(); }
  }
  async function observedSpec(spec, { acceptContentVerification = false } = {}) {
    const observed = { identities: (await connection({ expectedIdentities: spec.identities })).identities };
    observed.caption = await read('caption'); observed.headline = await read('headline');
    observed.destinationUrl = await read('destinationUrl'); observed.whatsappNumber = await read('whatsappNumber');
    observed.whatsappGreeting = spec.mode === 'paid' && spec.objective === 'whatsapp' ? await read('whatsappGreeting') : '';
    observed.aiDisclosure = await (await field('aiDisclosure')).isChecked();
    observed.enhancements = await (await field('enhancements')).isChecked();
    observed.automaticMusic = await (await field('automaticMusic')).isChecked();
    observed.originalFraming = /^(Original|Original sin recorte)$/i.test(await selected('crop'));
    // Hash evidence is local upload evidence, never an invented Meta UI field.
    // Reopening a draft requires a durable native media ID bound to this upload;
    // a thumbnail alone cannot establish the SHA-256 of the approved original.
    const knownMedia = uploadedMedia.get(await mediaScope());
    if (!knownMedia && !acceptContentVerification) fail('LAYOUT_CHANGED');
    await previewMedia(knownMedia?.name || null, spec.assetType);
    const mediaId = numericId(lineValue(await text(), ['Media ID', 'ID del contenido multimedia']));
    if (knownMedia && knownMedia.remoteMediaId !== mediaId) fail('SPEC_MISMATCH');
    observed.assetHash = knownMedia?.sha256 || null;
    observed.mediaType = lineValue(await text(), ['Media format', 'Formato del contenido multimedia']);
    observed.assetType = /^(Image|Imagen)$/i.test(observed.mediaType) ? 'image' : /^(Video|Vídeo)$/i.test(observed.mediaType) ? 'video' : fail('LAYOUT_CHANGED');
    const expectedType = spec.assetType;
    if (!['image', 'video'].includes(expectedType)) fail('SPEC_MISMATCH');
    if (expectedType && !({ image: /^(Image|Imagen)$/i, video: /^(Video|Vídeo)$/i }[expectedType]?.test(observed.mediaType))) fail('SPEC_MISMATCH');
    if (spec.mode === 'paid') {
      const label = await selected('objective');
      observed.objective = Object.keys(objectives).find(key => objectives[key].test(label));
      observed.cta = await selected('cta');
      observed.geoExpansion = await (await field('geoExpansion')).isChecked();
      if (!observed.objective) fail('LAYOUT_CHANGED');
      if (!/^(Lifetime budget|Presupuesto total)$/.test(await selected('budgetType'))) fail('SPEC_MISMATCH');
      observed.budgetType = 'lifetime'; observed.budgetMinor = await money(await read('budget'));
      const info = await text();
      observed.currency = lineValue(info, ['Currency', 'Moneda']); observed.timeZone = lineValue(info, ['Time zone', 'Zona horaria']);
      observed.budgetLevel = lineValue(info, ['Budget allocation', 'Asignación del presupuesto']);
      if (!/^(Ad set|Conjunto de anuncios)$/.test(observed.budgetLevel)) fail('SPEC_MISMATCH');
      const utc = value => { const time = Date.parse(value); if (!Number.isFinite(time) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)) fail('LAYOUT_CHANGED'); return new Date(time).toISOString(); };
      observed.startAt = utc(await read('startAt')); observed.endAt = utc(await read('endAt'));
      observed.audience = {};
      for (const key of ['countries', 'genders']) observed.audience[key] = split(await read(key));
      for (const key of ['regions', 'cities', 'interests']) observed.audience[key] = await selectedReferences(key, observed.identities.businessId);
      for (const key of ['ageMin', 'ageMax']) { const value = await read(key); if (!/^\d+$/.test(value)) fail('LAYOUT_CHANGED'); observed.audience[key] = Number(value); }
      observed.placements = [];
      for (const [key, label] of Object.entries(placements)) if (await (await unique((await main()).getByRole('checkbox', { name: label, exact: true }))).isChecked()) observed.placements.push(key);
      observed.placements.sort();
      observed.expansion = await (await field('expansion')).isChecked();
      observed.automaticPlacements = await (await field('automaticPlacements')).isChecked();
      observed.taxesAndFees = lineValue(info, ['Taxes and fees', 'Impuestos y cargos']);
      observed.campaignCount = Number(lineValue(info, ['Campaign count', 'Cantidad de campañas']));
      observed.adSetCount = Number(lineValue(info, ['Ad set count', 'Cantidad de conjuntos']));
      observed.adCount = Number(lineValue(info, ['Ad count', 'Cantidad de anuncios']));
    } else {
      const contentFormat = await selected('contentFormat');
      observed.contentFormat = /^(Reel)$/i.test(contentFormat) ? 'reel' : /^(Feed post|Publicación de feed)$/i.test(contentFormat) ? 'feed' : fail('LAYOUT_CHANGED');
      observed.nativeScheduling = !/^(Publish now|Publicar ahora)$/i.test(await selected('publishingSchedule'));
      observed.platforms = [];
      for (const [key, name] of [['facebook', /^(Facebook destination|Destino Facebook)$/i], ['instagram', /^(Instagram destination|Destino Instagram)$/i]]) if (await (await unique((await main()).getByRole('checkbox', { name, exact: true }))).isChecked()) observed.platforms.push(key);
      if (spec.assetType === 'video' && observed.platforms.includes('instagram')) observed.shareToFeed = await (await field('shareToFeed')).isChecked();
    }
    return observed;
  }
  function compare(spec, observed, expectedPlatforms = spec.platforms, { acceptContentVerification = false } = {}) {
    for (const key of ['caption', 'headline', 'destinationUrl', 'whatsappNumber']) if (normalize(spec[key]) !== observed[key]) fail('SPEC_MISMATCH');
    if ((!acceptContentVerification && spec.assetHash !== observed.assetHash) || Boolean(spec.aiDisclosure) !== observed.aiDisclosure || observed.enhancements || observed.automaticMusic || !observed.originalFraming) fail('SPEC_MISMATCH');
    if (spec.mode === 'paid' && spec.objective === 'whatsapp' && (!normalize(spec.whatsappGreeting) || normalize(spec.whatsappGreeting) !== observed.whatsappGreeting)) fail('SPEC_MISMATCH');
    if (spec.mode === 'paid') {
      const cta = spec.objective === 'whatsapp' ? /^(Send WhatsApp message|Enviar mensaje de WhatsApp)$/i : spec.objective === 'traffic' ? /^(Learn more|Más información)$/i : /^(No button|Sin botón)$/i;
      if (!cta.test(observed.cta) || observed.geoExpansion) fail('SPEC_MISMATCH');
      for (const key of ['objective', 'budgetMinor', 'currency', 'timeZone']) if (spec[key] !== observed[key]) fail('SPEC_MISMATCH');
      for (const key of ['startAt', 'endAt']) if (new Date(spec[key]).toISOString() !== observed[key]) fail('SPEC_MISMATCH');
      if (observed.expansion || observed.automaticPlacements || observed.campaignCount !== 1 || observed.adSetCount !== 1 || observed.adCount !== 1) fail('SPEC_MISMATCH');
      for (const key of ['ageMin', 'ageMax']) if (spec.audience?.[key] !== observed.audience[key]) fail('SPEC_MISMATCH');
      for (const key of ['countries', 'genders']) if (!equal(refLabels(spec.audience?.[key]), observed.audience[key])) fail('SPEC_MISMATCH');
      for (const key of ['regions', 'cities', 'interests']) {
        const expected = [...(spec.audience?.[key] || [])].sort((a, b) => a.key.localeCompare(b.key));
        if (hash(expected) !== hash(observed.audience[key])) fail('SPEC_MISMATCH');
      }
      if (!equal([...(spec.placements || [])].sort(), observed.placements)) fail('SPEC_MISMATCH');
    } else {
      if (!equal([...(expectedPlatforms || [])].sort(), observed.platforms.sort()) || observed.contentFormat !== (spec.assetType === 'video' ? 'reel' : 'feed') || observed.nativeScheduling) fail('SPEC_MISMATCH');
      if (spec.assetType === 'video' && expectedPlatforms.includes('instagram') && observed.shareToFeed !== true) fail('SPEC_MISMATCH');
    }
  }
  async function fillSpec(spec, media, targetPlatforms = spec.platforms) {
    assertLease();
    if (media) {
      if (media.sha256 !== spec.assetHash || media.assetId !== spec.assetId) fail('SPEC_MISMATCH');
      const upload = await verifyMedia(media);
      try {
        assertLease(); markMutation();
        await (await field('media')).setInputFiles(upload.path);
        await previewMedia(upload.name, spec.assetType);
        const remoteMediaId = lineValue(await text(), ['Media ID', 'ID del contenido multimedia'], false);
        uploadedMedia.set(await mediaScope(), { name: upload.name, sha256: media.sha256, remoteMediaId: remoteMediaId ? numericId(remoteMediaId) : null });
      } finally { await upload.cleanup(); }
    }
    // These fields may autosave too; the durable sent intention fences all edits.
    assertLease(); markMutation();
    for (const key of ['caption', 'headline', 'destinationUrl', 'whatsappNumber']) await fill(key, spec[key]);
    await (await field('aiDisclosure')).setChecked(Boolean(spec.aiDisclosure));
    await (await field('enhancements')).setChecked(false);
    await (await field('automaticMusic')).setChecked(false);
    await select('crop', /^(Original|Original sin recorte)$/i);
    if (spec.mode === 'paid' && spec.objective === 'whatsapp') await fill('whatsappGreeting', spec.whatsappGreeting);
    if (spec.mode === 'paid') {
      if (!objectives[spec.objective]) fail('SPEC_MISMATCH');
      await select('objective', objectives[spec.objective]);
      await select('cta', spec.objective === 'whatsapp' ? /^(Send WhatsApp message|Enviar mensaje de WhatsApp)$/i : spec.objective === 'traffic' ? /^(Learn more|Más información)$/i : /^(No button|Sin botón)$/i);
      await (await field('geoExpansion')).setChecked(false);
      await select('budgetType', /^(Lifetime budget|Presupuesto total)$/i);
      if (!Number.isSafeInteger(spec.budgetMinor) || spec.budgetMinor <= 0) fail('SPEC_MISMATCH');
      const amount = `${Math.trunc(spec.budgetMinor / 100)}${(await format()).decimalSeparator}${String(spec.budgetMinor % 100).padStart(2, '0')}`;
      await fill('budget', amount);
      for (const key of ['startAt', 'endAt']) await fill(key, spec[key]);
      for (const key of ['countries', 'genders']) await fill(key, refLabels(spec.audience?.[key]).join('; '));
      for (const key of ['regions', 'cities', 'interests']) await fillReferences(key, spec.audience?.[key], spec.identities.businessId);
      for (const key of ['ageMin', 'ageMax']) await fill(key, spec.audience?.[key]);
      await (await field('expansion')).setChecked(false); await (await field('automaticPlacements')).setChecked(false);
      for (const [key, label] of Object.entries(placements)) await (await unique((await main()).getByRole('checkbox', { name: label, exact: true }))).setChecked(spec.placements.includes(key));
    } else {
      await select('contentFormat', spec.assetType === 'video' ? /^(Reel)$/i : /^(Feed post|Publicación de feed)$/i);
      await select('publishingSchedule', /^(Publish now|Publicar ahora)$/i);
      for (const [key, name] of [['facebook', /^(Facebook destination|Destino Facebook)$/i], ['instagram', /^(Instagram destination|Destino Instagram)$/i]]) await (await unique((await main()).getByRole('checkbox', { name, exact: true }))).setChecked(targetPlatforms.includes(key));
      if (spec.assetType === 'video' && targetPlatforms.includes('instagram')) await (await field('shareToFeed')).setChecked(true);
    }
  }
  async function inspectAudience(payload) {
    await connection({ expectedIdentities: payload.expectedIdentities });
    await openDraft(payload);
    const observed = await observedSpec(payload.spec); compare(payload.spec, observed);
    return { status: 'confirmed', data: { observedSpec: observed, audienceEstimate: audienceEstimate(await text()) } };
  }
  async function nativeRefs({ draft = false } = {}) {
    const info = await text(), refs = {};
    if (draft) refs.remoteDraftRef = numericId(lineValue(info, ['Draft ID', 'ID del borrador']));
    for (const [key, names] of Object.entries({ campaignId: ['Campaign ID', 'ID de la campaña'], adSetId: ['Ad set ID', 'ID del conjunto'], adId: ['Ad ID', 'ID del anuncio'], creativeId: ['Creative ID', 'ID del creativo'] })) {
      const value = lineValue(info, names, false);
      if (value) refs[key] = numericId(value);
    }
    if (refs.campaignId) refs.remoteId = refs.campaignId;
    return refs;
  }
  async function assertDraft() {
    const info = await text();
    if (!/^(Draft|Borrador)$/.test(lineValue(info, ['Delivery status', 'Estado de entrega'])) || !/^(No)$/i.test(lineValue(info, ['Ever activated', 'Activado anteriormente']))) fail('SPEC_MISMATCH');
    for (const names of [['Campaign count', 'Cantidad de campañas'], ['Ad set count', 'Cantidad de conjuntos'], ['Ad count', 'Cantidad de anuncios']]) if (lineValue(info, names) !== '1') fail('SPEC_MISMATCH');
  }
  function audienceEstimate(info) {
    const raw = lineValue(info, ['Potential audience', 'Audiencia potencial'], false), match = raw?.match(/^(\d+)\s*[–-]\s*(\d+)$/);
    const label = info.match(/^\s*(Potential audience|Audiencia potencial)\s*:/mi)?.[1] || null;
    const horizon = lineValue(info, ['Audience estimate horizon', 'Horizonte de estimación de audiencia'], false);
    return { status: match ? 'reported' : 'unavailable', lower: match ? Number(match[1]) : null, upper: match ? Number(match[2]) : null, source: 'meta_ui', definition: 'potential_audience', label, horizon, displayValue: raw, adapterVersion: META_UI_VERSION };
  }
  async function draftResult(payload, { validate = false, manual = false } = {}) {
    restoreMediaEvidence(payload);
    const id = await openDraft(payload);
    await assertDraft();
    const step = payload.operation?.step || payload.delivery?.operationStep;
    if (step === 'prepare-paid') {
      const deliveryId = payload.operation?.deliveryId || payload.operation?.delivery_id || payload.delivery?.id || payload.operation?.data?.deliveryId;
      if (!deliveryId || await read('campaignName') !== `All Nutrition ${deliveryId}`) fail('SPEC_MISMATCH');
    }
    const observed = validate ? await observedSpec(payload.spec, { acceptContentVerification: manual }) : null;
    if (observed) compare(payload.spec, observed, payload.spec.platforms, { acceptContentVerification: manual });
    const refs = await nativeRefs({ draft: true }), media = uploadedMedia.get(id);
    if (step === 'prepare-paid' && !manual && references(payload).remoteDraftRef && hash(refs) !== hash(references(payload))) fail('SPEC_MISMATCH');
    return { status: 'confirmed', data: { state: 'ready', remoteDraftRef: id, remoteRefs: refs, preparedRefs: refs, observedSpec: observed, adapterVersion: META_UI_VERSION,
      ...(validate ? { audienceEstimate: audienceEstimate(await text()) } : {}),
      evidence: { remoteRead: true, state: 'draft', everActivated: false, adapterVersion: META_UI_VERSION, ...(validate ? { specHash: hash(payload.spec), budget: await budgetSnapshot() } : {}), ...(media ? { mediaEvidence: { ...media, scope: id } } : {}), ...(manual ? { contentVerifiedByAdministrator: true } : {}), externalDOMVerified: false } } };
  }
  async function preflight(payload) {
    await open();
    const { operation, spec, query } = payload;
    const connected = await connection({ expectedIdentities: payload.expectedIdentities || spec?.identities });
    const kind = operation?.kind || operation?.data?.kind || operation?.step;
    authorize(operation, spec, { draft: true, readOnly: kind === 'targeting' });
    restoreMediaEvidence(payload);
    if (spec?.mode !== 'paid') fail('SPEC_MISMATCH');
    if (!connected.capabilities.adsPublish || spec.objective === 'whatsapp' && !connected.capabilities.whatsappAds) fail('PERMISSION_REQUIRED');
    if (kind === 'prepare') {
      if (draftId(payload)) return draftResult(payload);
      await guardedClick(/^(Create campaign|Crear campaña)$/i, operation, spec, { draft: true });
      const id = numericId(lineValue(await text(), ['Draft ID', 'ID del borrador']));
      await assertDraft();
      assertLease(); markMutation();
      await fill('campaignName', `All Nutrition ${operation.id}`);
      await guardedClick(/^(Save draft|Guardar borrador)$/i, operation, spec, { draft: true });
      return draftResult({ ...payload, remoteDraftRef: id });
    }
    const id = await openDraft(payload);
    await assertDraft();
    if (kind === 'targeting') {
      if (!query || !['location', 'interest'].includes(query.kind) || typeof query.q !== 'string' || !query.q.trim() || query.q.length > 200) fail('SPEC_MISMATCH');
      const candidates = (await searchReferences(query, connected.identities.businessId)).map(item => item.value);
      return { status: 'confirmed', data: { remoteDraftRef: id, remoteRefs: { remoteDraftRef: id }, candidates, adapterVersion: META_UI_VERSION, evidence: { remoteRead: true, state: 'draft', everActivated: false } } };
    }
    if (kind !== 'validate' || !payload.media) fail('SPEC_MISMATCH');
    assertWhatsApp(connected, spec);
    await fillSpec(spec, payload.media);
    const observed = await observedSpec(spec); compare(spec, observed);
    await guardedClick(/^(Save draft|Guardar borrador)$/i, operation, spec, { draft: true });
    return draftResult(payload, { validate: true });
  }
  function organicChannel(payload) {
    const channel = payload.operation?.channel || payload.operation?.data?.channel || payload.delivery?.channel || (payload.spec?.platforms?.length === 1 ? payload.spec.platforms[0] : null);
    if (!['facebook', 'instagram'].includes(channel) || !payload.spec?.platforms?.includes(channel)) fail('SPEC_MISMATCH');
    return channel;
  }
  const pausePurpose = payload => payload.purpose === 'pause' || /^pause:[\w:-]+$/.test(payload.operation?.step || '');
  async function budgetSnapshot() {
    const info = await text(), remaining = lineValue(info, ['Remaining budget', 'Presupuesto restante'], false);
    if (!/^(Lifetime budget|Presupuesto total)$/.test(await selected('budgetType'))) fail('SPEC_MISMATCH');
    const snapshot = { budgetMinor: await money(await read('budget')), remainingMinor: !remaining || remaining === '—' ? null : await money(remaining), currency: lineValue(info, ['Currency', 'Moneda']), startAt: await read('startAt'), endAt: await read('endAt') };
    for (const key of ['startAt', 'endAt']) {
      if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot[key]) || !Number.isFinite(Date.parse(snapshot[key]))) fail('LAYOUT_CHANGED');
      snapshot[key] = new Date(snapshot[key]).toISOString();
    }
    if (!Number.isSafeInteger(snapshot.budgetMinor) || snapshot.budgetMinor <= 0 || snapshot.remainingMinor !== null && (snapshot.remainingMinor < 0 || snapshot.remainingMinor > snapshot.budgetMinor)) fail('SPEC_MISMATCH');
    return snapshot;
  }
  async function deliveryState(payload, { reopen = true, manual = false } = {}) {
    const id = remoteId(payload);
    restoreMediaEvidence(payload);
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id)) fail('SPEC_MISMATCH');
    if (reopen) await safeLink(/^(?:Campaign|Content|Campaña|Contenido) .*\((?:ID|Identificador):\s*\d+\)$/i, id);
    await connection({ expectedIdentities: payload.expectedIdentities || payload.spec?.identities, purpose: pausePurpose(payload) ? 'pause' : 'normal' });
    const info = await text(), actual = lineValue(info, ['Campaign ID', 'Content ID', 'ID de la campaña', 'ID del contenido']);
    if (actual !== id) fail('ACCOUNT_MISMATCH');
    const paid = Boolean(lineValue(info, ['Campaign ID', 'ID de la campaña'], false));
    const raw = lineValue(info, ['Delivery status', 'Estado de entrega']);
    const statuses = { Active: 'active', Activo: 'active', Paused: 'paused', Pausado: 'paused', Published: 'published', Publicado: 'published', Scheduled: 'scheduled', Programado: 'scheduled', 'In review': 'in_review', 'En revisión': 'in_review', Rejected: 'failed', Rechazado: 'failed', Completed: 'completed', Finalizado: 'completed' };
    const state = statuses[raw]; if (!state) fail('LAYOUT_CHANGED');
    const pausing = pausePurpose(payload);
    const everActivated = paid ? /^(Yes|Sí)$/i.test(lineValue(info, ['Ever activated', 'Activado anteriormente'], !pausing)) : false;
    if (paid && !everActivated && !pausing) fail('SPEC_MISMATCH');
    if (state === 'completed' && (!/^(Yes|Sí)$/i.test(lineValue(info, ['Delivery ended', 'Entrega finalizada'])) || !/^No$/i.test(lineValue(info, ['Delivery running', 'Entrega en curso'])))) fail('SPEC_MISMATCH');
    if (pausing) {
      if (!paid) fail('ACCOUNT_MISMATCH');
      return { status: 'confirmed', data: { state, remoteRefs: { remoteId: id, campaignId: id },
        evidence: { remoteRead: true, adapterVersion: META_UI_VERSION, state, ...(everActivated ? { everActivated: true } : {}) } } };
    }
    if (payload.spec && (payload.spec.mode === 'paid') !== paid) fail('SPEC_MISMATCH');
    const observed = payload.spec && (state !== 'failed' || manual) ? await observedSpec(payload.spec, { acceptContentVerification: manual }) : null;
    if (observed) compare(payload.spec, observed, paid ? payload.spec.platforms : [organicChannel(payload)], { acceptContentVerification: manual });
    if (!paid && payload.spec) {
      const channel = lineValue(info, ['Published channel', 'Red publicada']).toLowerCase();
      if (channel !== organicChannel(payload)) fail('ACCOUNT_MISMATCH');
    }
    const rawPermalink = lineValue(info, ['Permalink', 'Enlace permanente'], false);
    let permalink = null;
    if (rawPermalink) {
      try { permalink = socialPermalink(rawPermalink); } catch { fail('SPEC_MISMATCH'); }
      if (payload.spec?.mode === 'organic') {
        const url = new URL(permalink), channel = organicChannel(payload);
        const facebookIds = [...url.pathname.split('/').filter(Boolean), url.searchParams.get('fbid'), url.searchParams.get('story_fbid')];
        if (channel === 'instagram'
          ? !/(^|\.)instagram\.com$/.test(url.hostname) || !/^\/(?:p|reel)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
          : !/(^|\.)facebook\.com$/.test(url.hostname) || !facebookIds.includes(id)) fail('SPEC_MISMATCH');
      }
    }
    if (!paid && state === 'published' && !permalink) fail('LAYOUT_CHANGED');
    const media = uploadedMedia.get(id), refs = paid ? await nativeRefs() : {};
    const budget = paid ? await budgetSnapshot() : null;
    return { status: 'confirmed', data: { state, remoteRefs: { ...refs, remoteId: id, ...(permalink ? { permalink } : {}) }, observedSpec: observed,
      evidence: { remoteRead: true, adapterVersion: META_UI_VERSION, state, everActivated, ...(budget ? { budget } : {}), ...(media ? { mediaEvidence: { ...media, scope: id } } : {}), ...(manual ? { contentVerifiedByAdministrator: true } : {}), ...(state === 'failed' ? { reason: normalize(lineValue(info, ['Rejection reason', 'Motivo del rechazo'])).replace(/https?:\/\/\S+/gi, '[enlace omitido]').replace(/(?:access_token|password|cookie|otp)\s*[=:]\s*\S+/gi, '[dato privado omitido]').slice(0, 500) } : {}) } } };
  }
  async function recoverDraft(payload) {
    if (draftId(payload)) return payload;
    const technicalId = payload.operation?.deliveryId || payload.operation?.delivery_id || payload.delivery?.id || payload.operation?.id;
    if (!technicalId) fail('SPEC_MISMATCH');
    await open();
    await connection({ expectedIdentities: payload.expectedIdentities || payload.spec?.identities });
    const links = (await main()).getByRole('link', { name: new RegExp(`^(?:Draft|Borrador) All Nutrition ${escaped(technicalId)} \\((?:ID|Identificador):\\s*\\d+\\)$`, 'i') });
    if (await links.count() !== 1) fail('OPERATION_UNCERTAIN');
    const match = normalize(await links.innerText()).match(/\((?:ID|Identificador):\s*(\d+)\)$/i);
    if (!match) fail('LAYOUT_CHANGED');
    return { ...payload, remoteDraftRef: match[1] };
  }
  async function knownPaidObject(payload) {
    if (remoteId(payload)) return { payload };
    await open();
    await connection({ expectedIdentities: payload.expectedIdentities || payload.spec?.identities, purpose: pausePurpose(payload) ? 'pause' : 'normal' });
    const technicalId = payload.operation?.deliveryId || payload.operation?.delivery_id || payload.delivery?.id || payload.operation?.data?.deliveryId;
    const ref = draftId(payload), links = (await main()).getByRole('link');
    const published = [], drafts = [];
    for (let i = 0; i < await links.count(); i++) {
      const label = normalize(await links.nth(i).innerText());
      const match = label.match(/^(Draft|Borrador|Campaign|Campaña) (.*?) \((?:ID|Identificador):\s*(\d{1,30})\)$/i);
      if (!match || !(ref && match[3] === ref || technicalId && match[2] === `All Nutrition ${technicalId}`)) continue;
      (/^(Draft|Borrador)$/i.test(match[1]) ? drafts : published).push(match[3]);
    }
    if (published.length > 1 || drafts.length > 1) fail('OPERATION_UNCERTAIN');
    if (published.length === 1) return { payload: { ...payload, remoteId: published[0] } };
    if (drafts.length === 1) {
      await safeLink(/^(?:Draft|Borrador) .*\((?:ID|Identificador):\s*\d+\)$/i, drafts[0]);
      await connection({ expectedIdentities: payload.expectedIdentities || payload.spec?.identities, purpose: pausePurpose(payload) ? 'pause' : 'normal' });
      await assertDraft();
      return { pending: { status: 'pending', data: { remoteRefs: { remoteDraftRef: drafts[0] }, evidence: { remoteRead: true, adapterVersion: META_UI_VERSION, state: 'draft', everActivated: false } } } };
    }
    fail('OPERATION_UNCERTAIN');
  }
  async function inspectDelivery(payload) {
    if (!remoteId(payload) && (pausePurpose(payload) || /^activate:[\w:-]+$/.test(payload.operation?.step || '') && !['prepared', 'retry_wait'].includes(payload.operation?.state))) {
      const resolved = await knownPaidObject(payload);
      if (resolved.pending) return resolved.pending;
      payload = resolved.payload;
    }
    if (remoteId(payload)) return deliveryState(payload, { manual: humanResolution(payload) });
    if (!payload.operation && payload.delivery?.state === 'ready' && payload.spec?.mode === 'paid') payload = { ...payload, delivery: { ...payload.delivery, operationStep: 'prepare-paid' } };
    const step = payload.delivery?.operationStep || payload.operation?.step;
    if (!['prepare', 'targeting', 'validate', 'prepare-paid', 'activate'].includes(step?.split(':')[0]) || payload.spec?.mode !== 'paid') fail('SPEC_MISMATCH');
    let recovered;
    try { recovered = await recoverDraft(payload); }
    catch (cause) {
      if (cause.errorCode !== 'OPERATION_UNCERTAIN') throw cause;
      return { status: 'uncertain', data: { evidence: { remoteRead: true, adapterVersion: META_UI_VERSION } } };
    }
    if (step === 'targeting' && (payload.operation?.data?.query || payload.operation?.query)) {
      const query = payload.operation.query || payload.operation.data.query;
      await openDraft(recovered); await assertDraft();
      const candidates = (await searchReferences(query, payload.spec.identities.businessId)).map(item => item.value);
      const result = await draftResult(recovered);
      return { ...result, data: { ...result.data, candidates } };
    }
    return draftResult(recovered, { validate: !['prepare', 'targeting'].includes(step), manual: humanResolution(payload) });
  }
  async function verifyRemoteLink(payload) {
    if (!payload.spec || payload.operation?.specHash && payload.operation.specHash !== hash(payload.spec)) fail('SPEC_MISMATCH');
    if (!payload.remoteId && payload.permalink) {
      let permalink;
      try { permalink = socialPermalink(payload.permalink); } catch { fail('SPEC_MISMATCH'); }
      await open();
      await connection({ expectedIdentities: payload.expectedIdentities || payload.spec.identities });
      const articles = (await main()).getByRole('article'), matches = [];
      for (let i = 0; i < await articles.count(); i++) {
        const links = articles.nth(i).getByRole('link');
        for (let j = 0; j < await links.count(); j++) if (await links.nth(j).getAttribute('href') === permalink) {
          const match = (await articles.nth(i).innerText()).match(/\((?:ID|Identificador):\s*(\d{1,30})\)/i);
          if (match) matches.push(match[1]);
        }
      }
      if (matches.length !== 1) fail('LAYOUT_CHANGED');
      payload = { ...payload, remoteId: matches[0] };
    }
    if (!/^\d{1,30}$/.test(payload.remoteId || '')) fail('SPEC_MISMATCH');
    if (!payload.delivery && ['prepare', 'targeting', 'validate'].includes(payload.operation?.step)) {
      const linked = { ...payload, remoteDraftRef: payload.remoteId };
      await openDraft(linked); await assertDraft();
      if (payload.operation.step === 'prepare') {
        const name = await read('campaignName');
        if (name !== `All Nutrition ${payload.operation.id}` && !(payload.acceptContentVerification === true && name === '')) fail('SPEC_MISMATCH');
      }
      return draftResult(linked, { validate: payload.operation.step === 'validate', manual: payload.acceptContentVerification === true });
    }
    if (payload.acceptContentVerification !== true) fail('SPEC_MISMATCH');
    if (payload.spec.mode === 'paid' && payload.operation?.step === 'prepare-paid') {
      return draftResult({ ...payload, remoteDraftRef: payload.remoteId }, { validate: true, manual: true });
    }
    const result = await deliveryState(payload, { manual: true });
    if (payload.permalink && result.data.remoteRefs.permalink !== socialPermalink(payload.permalink)) fail('SPEC_MISMATCH');
    return result;
  }
  async function execute(payload) {
    await open();
    const { operation, spec } = payload, rawStep = operation?.step || '';
    const step = rawStep.split(':')[0];
    if (!['publish', 'prepare-paid'].includes(rawStep) && !/^(activate|pause|resume):[\w:-]+$/.test(rawStep)) fail('SPEC_MISMATCH');
    const minimal = step === 'pause';
    const connected = await connection({ expectedIdentities: payload.expectedIdentities || spec?.identities, purpose: minimal ? 'pause' : 'normal' });
    if (minimal) {
      authorize(operation, null, { pause: true });
      const resolved = await knownPaidObject({ ...payload, spec: null, purpose: 'pause' });
      if (resolved.pending) return resolved.pending;
      const minimalPayload = resolved.payload;
      const before = await deliveryState(minimalPayload);
      if (before.data.state === 'paused') return before;
      if (!['active', 'in_review', 'scheduled'].includes(before.data.state)) fail('SPEC_MISMATCH');
      await guardedClick(/^(Pause campaign|Pausar campaña)$/i, operation, null, { pause: true, expectedIdentities: payload.expectedIdentities });
      try { const after = await deliveryState(minimalPayload); if (after.data.state !== 'paused') fail('OPERATION_UNCERTAIN'); return after; } catch { fail('OPERATION_UNCERTAIN'); }
    }
    if (spec?.mode === 'paid' && (!connected.capabilities.adsPublish || spec.objective === 'whatsapp' && !connected.capabilities.whatsappAds)) fail('PERMISSION_REQUIRED');
    if (spec?.mode === 'organic' && !connected.capabilities[organicChannel(payload) === 'facebook' ? 'facebookPublish' : 'instagramPublish']) fail('PERMISSION_REQUIRED');
    assertWhatsApp(connected, spec);
    authorize(operation, spec);
    restoreMediaEvidence(payload);
    if (step === 'prepare-paid') {
      if (!draftId(payload) || !references(payload).remoteDraftRef || !uploadedMedia.has(draftId(payload))) fail('SPEC_MISMATCH');
      const id = await openDraft(payload);
      await assertDraft();
      if (hash(await nativeRefs({ draft: true })) !== hash(references(payload))) fail('SPEC_MISMATCH');
      compare(spec, await observedSpec(spec));
      const deliveryId = operation.deliveryId || operation.delivery_id || payload.delivery?.id || operation.data?.deliveryId;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deliveryId || '')) fail('SPEC_MISMATCH');
      authorize(operation, spec); markMutation();
      await fill('campaignName', `All Nutrition ${deliveryId}`);
      await guardedClick(/^(Save draft|Guardar borrador)$/i, operation, spec);
      const result = await draftResult({ ...payload, remoteDraftRef: id }, { validate: true });
      if (await read('campaignName') !== `All Nutrition ${deliveryId}`) fail('OPERATION_UNCERTAIN');
      return result;
    }
    if (step === 'activate' || step === 'resume') {
      if (operation.investmentAccepted !== true && operation.data?.investmentAccepted !== true) fail('SPEC_MISMATCH');
      if (step === 'resume') {
        const before = await deliveryState(payload), budget = before.data.evidence.budget, confirmation = operation.budgetConfirmation || operation.data?.budgetConfirmation;
        if (before.data.state !== 'paused' || !confirmation || budget.remainingMinor === null || confirmation.remainingMinor !== budget.remainingMinor || confirmation.originalBudgetMinor !== budget.budgetMinor || confirmation.currency !== budget.currency || confirmation.startAt !== budget.startAt || confirmation.endAt !== budget.endAt) fail('SPEC_MISMATCH');
      } else {
        const id = await openDraft(payload);
        await assertDraft();
        const actualRefs = await nativeRefs({ draft: true }), approved = references(payload);
        if (approved.remoteDraftRef !== id || hash(actualRefs) !== hash(approved)) fail('SPEC_MISMATCH');
        const deliveryId = operation.deliveryId || operation.delivery_id || payload.delivery?.id || operation.data?.deliveryId;
        if (!deliveryId || await read('campaignName') !== `All Nutrition ${deliveryId}`) fail('SPEC_MISMATCH');
        const budget = await budgetSnapshot(), confirmation = operation.budgetConfirmation || operation.data?.budgetConfirmation;
        if (!confirmation || budget.remainingMinor === null || confirmation.remainingMinor !== budget.remainingMinor || confirmation.originalBudgetMinor !== budget.budgetMinor || confirmation.currency !== budget.currency || confirmation.startAt !== budget.startAt || confirmation.endAt !== budget.endAt) fail('SPEC_MISMATCH');
      }
      compare(spec, await observedSpec(spec));
      if (Date.parse(spec.endAt) <= Date.now()) fail('SPEC_MISMATCH');
      await guardedClick(step === 'resume' ? /^(Resume campaign|Reanudar campaña)$/i : /^(Publish campaign|Publicar campaña)$/i, operation, spec);
      try {
        const id = numericId(lineValue(await text(), ['Campaign ID', 'ID de la campaña']));
        const media = uploadedMedia.get(draftId(payload));
        if (media) uploadedMedia.set(id, media);
        const result = await deliveryState({ ...payload, remoteId: id });
        if (!['active', 'scheduled', 'in_review', 'failed'].includes(result.data.state)) fail('OPERATION_UNCERTAIN');
        return result;
      } catch { fail('OPERATION_UNCERTAIN'); }
    }
    if (step !== 'publish' || spec.mode !== 'organic' || !payload.media) fail('SPEC_MISMATCH');
    const target = organicChannel(payload);
    await guardedClick(target === 'facebook' ? /^(Create Facebook post|Crear publicación de Facebook)$/i : /^(Create Instagram post|Crear publicación de Instagram)$/i, operation, spec);
    await fillSpec(spec, payload.media, [target]);
    compare(spec, await observedSpec(spec), [target]);
    const uploaded = uploadedMedia.get(await mediaScope());
    await guardedClick(/^(Publish post|Publicar publicación)$/i, operation, spec);
    try {
      const id = numericId(lineValue(await text(), ['Content ID', 'ID del contenido']));
      if (uploaded) uploadedMedia.set(id, uploaded);
      const result = await deliveryState({ ...payload, remoteId: id });
      if (result.data.state !== 'published' || !result.data.remoteRefs.permalink) fail('OPERATION_UNCERTAIN');
      return result;
    } catch { fail('OPERATION_UNCERTAIN'); }
  }
  async function readMeasurements(payload) {
    const query = payload.query, spec = payload.spec, id = remoteId(payload);
    if (!query || !/^\d{4}-\d{2}-\d{2}$/.test(query.periodStart || '') || !/^\d{4}-\d{2}-\d{2}$/.test(query.periodEnd || '') || query.periodStart > query.periodEnd
      || !Number.isFinite(Date.parse(query.windowStart)) || !Number.isFinite(Date.parse(query.windowEnd)) || !['range', 'lifetime'].includes(query.periodType)
      || !['aggregate', 'daily', 'placement', 'age_gender', 'country'].includes(query.dimension) || !['paid', 'organic'].includes(query.scope)
      || typeof id !== 'string' || !/^\d{1,30}$/.test(id)) fail('SPEC_MISMATCH');
    const paid = query.scope === 'paid';
    if (spec && (spec.mode === 'paid') !== paid || payload.delivery?.channel && (payload.delivery.channel === 'meta_ads') !== paid) fail('SPEC_MISMATCH');
    if (spec?.integrationMethod && spec.integrationMethod !== 'browser') fail('SPEC_MISMATCH');
    await safeLink(/^(?:Campaign|Content|Campaña|Contenido) .*\((?:ID|Identificador):\s*\d+\)$/i, id, { readOnly: true, expectedIdentities: payload.expectedIdentities || spec?.identities || {} });
    await connection({ expectedIdentities: payload.expectedIdentities || spec?.identities });
    const original = await text();
    if (lineValue(original, paid ? ['Campaign ID', 'ID de la campaña'] : ['Content ID', 'ID del contenido']) !== id) fail('ACCOUNT_MISMATCH');
    const expectedAdId = payload.delivery?.remoteRefs?.adId || payload.delivery?.preparedRefs?.adId;
    if (paid && expectedAdId && lineValue(original, ['Ad ID', 'ID del anuncio']) !== String(expectedAdId)) fail('ACCOUNT_MISMATCH');
    if (!paid && payload.delivery?.channel && lineValue(original, ['Published channel', 'Red publicada']).toLowerCase() !== payload.delivery.channel) fail('ACCOUNT_MISMATCH');
    // Insights are read-only. Neither media availability nor caption/configuration
    // equality is a prerequisite for observing an already published object.
    const configurationDifferences = [];
    if (spec && paid) {
      const objective = (await main()).getByRole('combobox', { name: labels.objective, exact: true });
      if (await objective.count() === 1 && objectives[spec.objective] && !objectives[spec.objective].test(await selected('objective'))) configurationDifferences.push('objective_changed');
      const budget = (await main()).getByLabel(labels.budget, { exact: true });
      if (await budget.count() === 1) {
        try { if (await money(await read('budget')) !== spec.budgetMinor) configurationDifferences.push('total_budget_changed'); }
        catch { configurationDifferences.push('total_budget_unverifiable'); }
      }
    }
    await click(/^(View insights|Ver estadísticas)$/i);
    const options = {
      aggregate: /^(None|Ninguno)$/i, daily: /^(Day|Día)$/i,
      placement: /^(Platform and placement|Plataforma y ubicación)$/i,
      age_gender: /^(Age and gender|Edad y género)$/i, country: /^(Country|País)$/i
    };
    const dimension = query.dimension;
    const breakdown = (await main()).getByRole('combobox', { name: labels.breakdown, exact: true });
    let supported = false;
    if (await breakdown.count() === 1) {
      const choices = await breakdown.getByRole('option').allInnerTexts();
      supported = choices.filter(label => options[dimension].test(normalize(label))).length === 1;
    }
    if (supported) {
      await fill('periodStart', query.periodStart); await fill('periodEnd', query.periodEnd);
      await select('breakdown', options[dimension]);
      await click(/^(Apply date range|Aplicar intervalo de fechas)$/i);
    }
    await language();
    const info = await text(), scope = browserMetricScope(lineValue(info, ['Metric scope', 'Ámbito de las métricas']));
    if (!scope || scope !== query.scope && scope !== 'mixed') fail('SPEC_MISMATCH');
    const currencyLabel = lineValue(info, ['Currency', 'Moneda'], false), currency = currencyLabel && currencyLabel !== '—' ? currencyLabel : null;
    const timeZone = lineValue(info, ['Time zone', 'Zona horaria']);
    const timeZoneMismatch = timeZone !== query.timeZone;
    if (timeZoneMismatch && (paid || query.timeZoneSource !== 'observation_utc') || currency && !/^[A-Z]{3}$/.test(currency) || paid && spec?.currency && currency !== spec.currency) fail('SPEC_MISMATCH');
    try { new Intl.DateTimeFormat('en', { timeZone }); } catch { fail('LAYOUT_CHANGED'); }
    if (lineValue(info, paid ? ['Campaign ID', 'ID de la campaña'] : ['Content ID', 'ID del contenido']) !== id) fail('ACCOUNT_MISMATCH');
    const attribution = lineValue(info, ['Attribution setting', 'Configuración de atribución'], false);
    const attributionSetting = attribution && !/^(—|Unknown|Desconocida)$/i.test(attribution) ? attribution : null;
    const formatLabel = lineValue(info, ['Number format', 'Formato numérico'], false);
    const reportTime = lineValue(info, ['Action report time', 'Tiempo del informe de acciones'], false);
    const actionReportTime = /^(impression|Impresión)$/i.test(reportTime || '') ? 'impression' : null;
    const numberFormat = ({ '1,234.56': { decimalSeparator: '.', groupSeparator: ',' }, '1.234,56': { decimalSeparator: ',', groupSeparator: '.' },
      '1 234,56': { decimalSeparator: ',', groupSeparator: ' ' }, '1 234.56': { decimalSeparator: '.', groupSeparator: ' ' },
      '1234.56': { decimalSeparator: '.', groupSeparator: '' }, '1234,56': { decimalSeparator: ',', groupSeparator: '' } })[formatLabel] || null;
    const source = new URL(page.url()); source.search = ''; source.hash = '';
    const assetType = spec?.assetType || payload.delivery?.assetType;
    const base = { integrationMethod: 'browser', adapterVersion: META_UI_VERSION, apiVersion: null, definitionVersion: BROWSER_METRIC_DEFINITION_VERSION,
      query, periodStart: query.windowStart, periodEnd: query.windowEnd, timeZone, currency, scope, attributionSetting, actionReportTime, dimension,
      entity: { type: paid ? 'campaign' : assetType === 'video' ? 'video' : payload.delivery?.channel === 'instagram' ? 'media' : 'post', id },
      values: {}, rows: [], evidence: { sourcePage: source.href, locale, numberFormat, externalDOMVerified: false,
        timeZoneSource: 'visible_ui', ...(timeZoneMismatch ? { timeZoneMismatch: { requested: query.timeZone, reported: timeZone } } : {}),
        configurationDifferences, deliveryStatus: /^(Active|Activo|Paused|Pausado|Published|Publicado|Scheduled|Programado|In review|En revisión|Rejected|Rechazado|Completed|Finalizado)$/i.test(lineValue(original, ['Delivery status', 'Estado de entrega'], false) || '') ? lineValue(original, ['Delivery status', 'Estado de entrega'], false) : null } };
    if (!supported) return { status: 'confirmed', data: { snapshots: [{ ...base, coverage: { complete: false, rowCount: 0, status: 'unsupported', reason: 'unsupported_breakdown' } }], unsupportedMetrics: [`dimension:${dimension}`] } };
    const periodStart = lineValue(info, ['Reporting starts', 'Inicio del informe']), periodEnd = lineValue(info, ['Reporting ends', 'Fin del informe']);
    if (periodStart !== query.periodStart || periodEnd !== query.periodEnd || !options[dimension].test(lineValue(info, ['Breakdown', 'Desglose']))) fail('SPEC_MISMATCH');
    const visiblePeriodType = lineValue(info, ['Reporting period type', 'Tipo de período del informe'], false);
    if (visiblePeriodType && !({ Range: 'range', Intervalo: 'range', Lifetime: 'lifetime', 'Todo el período': 'lifetime' })[visiblePeriodType]) fail('LAYOUT_CHANGED');
    if (visiblePeriodType && ({ Range: 'range', Intervalo: 'range', Lifetime: 'lifetime', 'Todo el período': 'lifetime' })[visiblePeriodType] !== query.periodType) fail('SPEC_MISMATCH');
    let parsed, complete = false;
    const exportButton = (await main()).getByRole('button', { name: /^(Export performance|Exportar rendimiento)$/i, exact: true });
    if (await exportButton.count() === 1 && await exportButton.isEnabled()) {
      allowDownload(true);
      let download;
      try {
        assertLease();
        [download] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), exportButton.click()]);
        const stream = await download.createReadStream(), chunks = []; let length = 0;
        if (!stream) fail('LAYOUT_CHANGED');
        for await (const chunk of stream) {
          assertLease(); length += chunk.length;
          if (length > 10 * 1024 * 1024) { await download.cancel(); fail('LAYOUT_CHANGED'); }
          chunks.push(chunk);
        }
        parsed = await parseBrowserMetricExport(Buffer.concat(chunks, length), { filename: download.suggestedFilename(), locale, expectedScope: scope, numberFormat, expectedRemoteId: id, query });
        const total = lineValue(info, ['Export row count', 'Cantidad de filas exportadas'], false);
        complete = /^\d+$/.test(total || '') && Number(total) === parsed.rows.length;
      } finally { try { await download?.delete(); } finally { allowDownload(false); } }
    } else {
      const table = await unique((await main()).getByRole('table', { name: /^(Performance|Rendimiento)$/i, exact: true }).or((await main()).getByRole('grid', { name: /^(Performance|Rendimiento)$/i, exact: true })));
      const headers = await table.getByRole('columnheader').allInnerTexts(), rows = [], seen = new Set(), pages = new Set();
      if (headers.length > 200) fail('LAYOUT_CHANGED');
      const total = lineValue(info, ['Total rows', 'Total de filas'], false), declaredTotal = /^\d+$/.test(total || '') ? Number(total) : null;
      if (declaredTotal > 100000) fail('LAYOUT_CHANGED');
      for (let turn = 0; turn < 100000; turn++) {
        assertLease();
        const current = await text();
        if (lineValue(current, paid ? ['Campaign ID', 'ID de la campaña'] : ['Content ID', 'ID del contenido']) !== id) fail('ACCOUNT_MISMATCH');
        if (lineValue(current, ['Reporting starts', 'Inicio del informe']) !== periodStart || lineValue(current, ['Reporting ends', 'Fin del informe']) !== periodEnd
          || lineValue(current, ['Time zone', 'Zona horaria']) !== timeZone || browserMetricScope(lineValue(current, ['Metric scope', 'Ámbito de las métricas'])) !== scope
          || !equal((await table.getByRole('columnheader').allInnerTexts()).map(normalize), headers.map(normalize))) fail('SPEC_MISMATCH');
        const bodyRows = table.getByRole('row').filter({ has: page.getByRole('cell').or(page.getByRole('gridcell')) });
        const visibleRows = [];
        for (let i = 0; i < await bodyRows.count(); i++) {
          const row = (await bodyRows.nth(i).getByRole('cell').or(bodyRows.nth(i).getByRole('gridcell')).allInnerTexts()).map(normalize);
          visibleRows.push(row);
          const key = hash(row);
          if (!seen.has(key)) { seen.add(key); rows.push(row); }
          if (rows.length > 100000) fail('LAYOUT_CHANGED');
        }
        const signature = hash(visibleRows);
        if (pages.has(signature)) break;
        pages.add(signature);
        if (declaredTotal !== null && rows.length === declaredTotal) { complete = true; break; }
        const next = (await main()).getByRole('button', { name: /^(Next page|Página siguiente)$/i, exact: true });
        if (await next.count() === 1 && await next.isEnabled()) { assertLease(); await next.click(); continue; }
        // Scroll the visible grid itself; virtualized rows are revisited until
        // either the declared total is proven or no new viewport can be read.
        const moved = await table.evaluate(element => {
          let container = element;
          while (container && container.scrollHeight <= container.clientHeight) container = container.parentElement;
          if (!container || container === document.body || container === document.documentElement) return false;
          const before = container.scrollTop;
          container.scrollTop = Math.min(container.scrollHeight, before + Math.max(1, container.clientHeight - 20));
          return container.scrollTop !== before;
        });
        if (!moved) break;
        await page.waitForTimeout(100);
      }
      parsed = normalizeBrowserMetricTable({ columns: headers, rows, locale, expectedScope: scope, numberFormat, expectedRemoteId: id, query });
    }
    const required = paid ? ['spendMinor', 'impressions', 'reach', 'frequency', 'linkClicks', ...(spec?.objective === 'whatsapp' ? ['conversations'] : spec?.objective === 'engagement' ? ['interactions'] : [])]
      : ['reach', 'views', 'likes', 'comments', 'shares', 'saves', 'interactions', ...(assetType === 'video' ? ['plays', 'averageWatchTime', 'totalWatchTime', 'skipRate'] : [])];
    const unavailable = (key, reason) => ({ value: null, unit: key === 'spendMinor' ? 'minor_currency' : key === 'frequency' ? 'ratio' : key === 'skipRate' ? 'percent' : /WatchTime$/.test(key) ? 'seconds' : 'count', sourceMetric: null, status: 'unavailable', precision: 'unknown', displayValue: null, reason });
    const noConversationKpi = !paid || spec?.objective !== 'whatsapp';
    const unsupportedConversation = { ...unavailable('conversations', paid ? 'objective_has_no_conversation_kpi' : 'organic_attribution_unavailable'), status: 'unsupported' };
    for (const row of parsed.rows) {
      // Generic Results is intentionally not a conversation definition.
      if (noConversationKpi) row.values.conversations = unsupportedConversation;
      for (const key of required) if (!Object.hasOwn(row.values, key)) row.values[key] = unavailable(key, 'column_not_available');
    }
    const columnDefinitions = [], headerLocators = (await main()).getByRole('columnheader');
    for (let index = 0; index < await headerLocators.count(); index++) {
      const header = headerLocators.nth(index), label = normalize(await header.innerText());
      if (!parsed.columns.includes(label)) continue;
      const definition = normalize(await header.getAttribute('title') || await header.getAttribute('aria-description'));
      if (definition && definition.length <= 500 && !/https?:|@|[<>]|(?:password|cookie|access_token)\s*[=:]/i.test(definition)) columnDefinitions.push({ label, tooltip: definition });
    }
    const reason = !complete ? 'incomplete_rows' : !parsed.rows.length ? 'no_reported_rows' : timeZoneMismatch ? 'observation_time_zone_mismatch' : !visiblePeriodType && query.periodType === 'lifetime' ? 'period_type_unverified' : paid && !attributionSetting ? 'unknown_attribution' : paid && !currency ? 'unknown_currency' : null;
    const emptyValues = Object.fromEntries(required.map(key => [key, unavailable(key, 'no_reported_rows')]));
    if (noConversationKpi) emptyValues.conversations = unsupportedConversation;
    const snapshot = { ...base, scope: parsed.scope || scope, values: dimension === 'aggregate' ? parsed.rows[0]?.values || emptyValues : {},
      rows: dimension === 'aggregate' ? [] : parsed.rows.map(({ dimensions, periodStart, periodEnd, values }) => ({ dimensions, periodStart, periodEnd, values })),
      coverage: { complete: complete && !reason, rowCount: parsed.rows.length, reason },
      evidence: { ...base.evidence, columnLabels: parsed.columns, columnDefinitions, extractHash: parsed.extractHash, reportedPeriod: { periodStart, periodEnd, timeZone }, periodType: visiblePeriodType ? query.periodType : null } };
    return { status: 'confirmed', data: { snapshots: [snapshot], unsupportedMetrics: [] } };
  }
  async function measure(payload) {
    try { return await readMeasurements(payload); }
    catch (cause) {
      // The HTTP boundary exposes only MetaUIError codes, never parser details.
      if (cause instanceof BrowserMetricExportError) fail(cause.errorCode);
      throw cause;
    }
  }
  return { open, connection, preflight, execute, inspectDelivery, verifyRemoteLink, inspectAudience, measure };
}

