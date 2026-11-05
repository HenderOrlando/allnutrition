import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSocialCampaignInput, buildSocialSpec, verifySocialApiTargeting } from '../lib/business/social-spec.mjs';
import { hash } from '../lib/business/commands.mjs';
import { metaBudgetUnits } from '../lib/social/meta.mjs';

const NOW = '2026-11-02T12:00:00.000Z';
const connection = {
  id: '00000000-0000-4000-8000-000000000001', integrationMethod: 'api', state: 'connected',
  identities: { userId: '101', businessId: '202', pageId: '303', instagramId: '404', adAccountId: 'act_505' },
  currency: 'COP', timeZone: 'America/Bogota',
  capabilities: { facebookPublish: true, instagramPublish: true, adsPublish: true, whatsappAds: true },
  resources: { pages: [{ id: '303', whatsappNumber: '+573000000000' }], adAccounts: [{ id: 'act_505', currency: 'COP', timeZone: 'America/Bogota', accountStatus: 1 }] }
};
const asset = { id: '00000000-0000-4000-8000-000000000002', state: 'ready', kind: 'image', sha256: 'a'.repeat(64), derivativeSha256: 'a'.repeat(64) };
const city = { key: 'api:location:11001', source: 'api', providerId: '11001', label: 'Bogotá', context: { type: 'city', countryCode: 'CO', region: 'Bogotá D.C.', regionId: '1', radius: 17, distanceUnit: 'kilometer' } };
const region = { key: 'api:location:1', source: 'api', providerId: '1', label: 'Bogotá D.C.', context: { type: 'region', countryCode: 'CO', region: '', regionId: null } };
const interest = { key: 'api:interest:900', source: 'api', providerId: '900', label: 'Fitness', context: { type: 'interest', path: ['Intereses', 'Deporte'] } };
const config = (changes = {}, selected = connection) => normalizeSocialCampaignInput({
  name: 'Pieza aportada por usuario', connectionId: selected.id, assetId: asset.id, mode: 'paid', objective: 'traffic',
  platforms: ['facebook', 'instagram'], placements: ['facebook_feed', 'instagram_feed'],
  caption: 'Texto explícito', headline: 'Título explícito', destinationUrl: 'https://example.test/producto',
  budgetMinor: 5000000, targetCostMinor: 100000, startAt: '2026-11-03T12:00:00Z', endAt: '2026-11-10T12:00:00Z', aiDisclosure: false,
  ...changes
}, { connection: selected });
const build = (campaign = config(), selected = connection, piece = asset) => buildSocialSpec(campaign, { connection: selected, asset: piece, now: NOW });
const invalid = fn => assert.throws(fn, { status: 400 });

// The provider owns its own records; it does not generate a matching candidate from the request.
function targetingProvider() {
  const officialCity = { ...city, context: { type: 'city', countryCode: 'CO', region: 'Bogotá D.C.', regionId: '1' } };
  const connector = { async searchTargeting(query) { return structuredClone(query.kind === 'interest' ? [interest] : [officialCity, region]); } };
  return { connector };
}

test('el presupuesto total COP/USD es exacto y no se multiplica por dos redes', () => {
  const cop = build().spec;
  assert.equal(cop.budgetMinor, 5000000);
  assert.equal(metaBudgetUnits(cop.budgetMinor, cop.currency), 50000);
  assert.equal(cop.targeting.publisher_platforms.length, 2);
  const usdConnection = { ...connection, currency: 'USD' };
  const usd = build(config({ budgetMinor: 5000, targetCostMinor: null }, usdConnection), usdConnection).spec;
  assert.equal(metaBudgetUnits(usd.budgetMinor, usd.currency), 5000);
  invalid(() => build(config({ budgetMinor: 5000001 })));
  invalid(() => build(config({ budgetMinor: 0 })));
  invalid(() => config({ budgetMinor: Number.MAX_SAFE_INTEGER + 1 }));
  const unknown = { ...connection, currency: 'EUR' };
  invalid(() => build(config({}, unknown), unknown));
});

test('el borrador incompleto se guarda pero no implica declaración IA ni aprobación', () => {
  const draft = normalizeSocialCampaignInput({});
  assert.equal(draft.aiDisclosure, null);
  invalid(() => build(config({ aiDisclosure: null })));
  invalid(() => config({ aiDisclosure: 'false' }));
  assert.equal(build(config({ aiDisclosure: false })).spec.aiDisclosure, false);
  // Acceptance is not publication configuration and cannot influence its hash.
  const campaign = config();
  assert.equal(build({ ...campaign, rightsAccepted: true, investmentAccepted: true }).specHash, build(campaign).specHash);
  invalid(() => normalizeSocialCampaignInput({ rightsAccepted: true }));
});

test('la divulgación IA no se descarta cuando una vía no puede aplicar su etiqueta', () => {
  assert.throws(() => build(config({ aiDisclosure: true })), { status: 409 });
  const organic = { mode: 'organic', budgetMinor: 0, targetCostMinor: null, startAt: null, endAt: null, aiDisclosure: true };
  assert.throws(() => build(config(organic)), { status: 409 });
  const instagram = build(config({ ...organic, platforms: ['instagram'], placements: ['instagram_feed'] }));
  assert.equal(instagram.spec.aiDisclosure, true);
  const selected = { ...connection, integrationMethod: 'browser', identities: { ...connection.identities, adAccountId: '505' } };
  assert.equal(build(config({ aiDisclosure: true }, selected), selected).spec.aiDisclosure, true);
});

test('los objetivos conservan optimización y WhatsApp exige número autorizado y bienvenida escrita', () => {
  invalid(() => build(config({ objective: 'whatsapp', whatsappNumber: '+573000000000' })));
  invalid(() => build(config({ objective: 'whatsapp', whatsappNumber: '+573000000001', whatsappGreeting: 'Hola, ¿en qué podemos ayudar?' })));
  const spec = build(config({ objective: 'whatsapp', whatsappNumber: '+573000000000', whatsappGreeting: 'Hola, ¿en qué podemos ayudar?' })).spec;
  assert.equal(spec.whatsappGreeting, 'Hola, ¿en qué podemos ayudar?');
  invalid(() => build(config({ destinationUrl: '' })));
});

test('la vía, moneda y zona proceden de la cuenta y un cambio monetario borra los importes', () => {
  const prior = config({ audience: { countries: [], cities: [city], interests: [interest] } });
  invalid(() => config({ integrationMethod: 'browser' }));
  const ignored = config({ currency: 'USD', timeZone: 'Asia/Tokyo' });
  assert.equal(ignored.currency, 'COP');
  assert.equal(ignored.timeZone, 'America/Bogota');
  invalid(() => config({ currency: 123 }));
  const changedConnection = { ...connection, currency: 'USD' };
  const changed = normalizeSocialCampaignInput({ budgetMinor: 5000, targetCostMinor: 200 }, { previous: prior, connection: changedConnection });
  assert.equal(changed.budgetMinor, 0);
  assert.equal(changed.targetCostMinor, null);
  assert.deepEqual(changed.audience.cities, []);
  assert.deepEqual(changed.audience.interests, []);
  const savedAgain = normalizeSocialCampaignInput({ budgetMinor: 5000, audience: { countries: ['CO'] } }, { previous: changed, connection: changedConnection });
  assert.equal(savedAgain.budgetMinor, 5000);
  assert.equal(build(savedAgain, changedConnection).spec.currency, 'USD');
});

test('cambiar identidad o vía invalida contexto y referencias sin depender de versiones técnicas', () => {
  const prior = config({ audience: { countries: [], cities: [city], interests: [interest] } });
  const otherIdentity = { ...connection, identities: { ...connection.identities, pageId: '999' } };
  assert.throws(() => build(prior, otherIdentity), { status: 409 });
  const changed = normalizeSocialCampaignInput({}, { previous: prior, connection: otherIdentity });
  assert.deepEqual(changed.audience.cities, []);
  assert.notEqual(changed.connectionContext, prior.connectionContext);
  const browser = { ...connection, integrationMethod: 'browser', identities: { ...connection.identities, adAccountId: '505' } };
  const migrated = normalizeSocialCampaignInput({}, { previous: prior, connection: browser });
  assert.equal(migrated.integrationMethod, 'browser');
  assert.deepEqual(migrated.audience.interests, []);
  const technical = { ...connection, version: 500, validatedAt: '2026-11-02T12:01:00Z', identities: { ...connection.identities, userName: 'Otro nombre visible' } };
  assert.equal(build(prior, technical).specHash, build(prior).specHash);
});

test('la búsqueda oficial revalida exactamente IDs, etiquetas, contexto y fuente', async () => {
  const campaign = config({ audience: { countries: [], cities: [city], interests: [interest] } });
  const { spec } = build(campaign), provider = targetingProvider();
  await verifySocialApiTargeting(spec, provider);
  for (const forged of [
    { ...city, label: 'Medellín' },
    { ...city, providerId: '123', key: 'api:location:123' },
    { ...city, context: { ...city.context, countryCode: 'US' } }
  ]) {
    const proposal = build(config({ audience: { countries: [], cities: [forged] } })).spec;
    await assert.rejects(() => verifySocialApiTargeting(proposal, targetingProvider()), { status: 400 });
  }
  const tampered = structuredClone(spec); tampered.targeting.age_min = 17;
  await assert.rejects(() => verifySocialApiTargeting(tampered, targetingProvider()), { status: 400 });
  const unsafeContext = { ...city, context: { ...city.context, unknownExpansion: true } };
  invalid(() => config({ audience: { countries: [], cities: [unsafeContext] } }));
});

test('API targeting usa únicamente referencias y ubicaciones explícitas sin expansión automática', () => {
  const { spec } = build(config({ audience: { countries: [], cities: [city], interests: [interest], genders: [2, 1], ageMin: 21, ageMax: 50 } }));
  assert.deepEqual(spec.targeting.geo_locations, { location_types: ['home', 'recent'], cities: [{ key: '11001', radius: 17, distance_unit: 'kilometer' }] });
  assert.deepEqual(spec.targeting.flexible_spec, [{ interests: [{ id: '900', name: 'Fitness' }] }]);
  assert.deepEqual(spec.targeting.targeting_automation, { advantage_audience: 0, individual_setting: { geo: 0 } });
  assert.deepEqual(spec.targeting.facebook_positions, ['feed']);
  assert.deepEqual(spec.targeting.instagram_positions, ['stream']);
  assert.deepEqual(spec.targeting.genders, [1, 2]);
});

test('el radio de ciudad es configuración explícita, sin asumir el radio predeterminado de Meta', async () => {
  const { radius: _radius, distanceUnit: _unit, ...withoutRadius } = city.context;
  const draft = config({ audience: { countries: [], cities: [{ ...city, context: withoutRadius }] } });
  invalid(() => build(draft));
  invalid(() => config({ audience: { countries: [], cities: [{ ...city, context: { ...city.context, radius: 0 } }] } }));
  invalid(() => config({ audience: { countries: [], cities: [{ ...city, context: { ...city.context, distanceUnit: 'meter' } }] } }));
  const first = build(config({ audience: { countries: [], cities: [city] } }));
  const changed = build(config({ audience: { countries: [], cities: [{ ...city, context: { ...city.context, radius: 20 } }] } }));
  assert.notEqual(first.specHash, changed.specHash);
  await verifySocialApiTargeting(changed.spec, targetingProvider());
});

test('radios de ciudad respetan límites publicados por Meta, no los de ubicaciones personalizadas', () => {
  const accepted = [];
  for (const [distanceUnit, radius] of [['kilometer', 16], ['kilometer', 17], ['kilometer', 80], ['kilometer', 81], ['mile', 9], ['mile', 10], ['mile', 50], ['mile', 51]]) {
    try {
      build(config({ audience: { countries: [], cities: [{ ...city, context: { ...city.context, radius, distanceUnit } }] } }));
      accepted.push(`${distanceUnit}:${radius}`);
    } catch (error) { assert.equal(error.status, 400); }
  }
  assert.deepEqual(accepted, ['kilometer:17', 'kilometer:80', 'mile:10', 'mile:50']);
});

test('comercio alimentario general no equivale a una condición de salud sensible', async () => {
  const providerRows = [
    { key: 'api:interest:900010', source: 'api', providerId: '900010', label: 'Health food shop', context: { type: 'interest', path: ['Shopping', 'Food retailers'] } },
    { key: 'api:interest:900011', source: 'api', providerId: '900011', label: 'Diabetes', context: { type: 'interest', path: ['Health conditions'] } }
  ];
  const accepted = [];
  const connector = { async searchTargeting() { return structuredClone(providerRows); } };
  for (const candidate of providerRows) {
    try {
      const { spec } = build(config({ audience: { interests: [candidate] } }));
      await verifySocialApiTargeting(spec, { connector });
      accepted.push(candidate.providerId);
    } catch (error) { assert.equal(error.status, 400); }
  }
  assert.deepEqual(accepted, ['900010']);
});

test('la audiencia bloquea menores, superposición, salud, clientes y parámetros arbitrarios', () => {
  for (const proposed of [
    { ageMin: 17 }, { ageMin: 40, ageMax: 30 }, { countries: ['ZZ'] }, { customAudiences: ['123'] },
    { countries: ['CO'], cities: [city] }, { countries: [], regions: [region], cities: [city] },
    { interests: [{ ...interest, label: 'Diabetes', context: { type: 'interest', path: ['Health'] } }] },
  ]) invalid(() => build(config({ audience: proposed })));
  invalid(() => normalizeSocialCampaignInput({ targeting: { age_min: 17 } }));
  invalid(() => normalizeSocialCampaignInput({ dailyBudget: 50000 }));
  invalid(() => config({ audience: { countries: [], cities: [{ ...city, source: 'browser' }] } }));
});

test('geografía nativa disjunta comparte aprobación canónica pero cambiar radio invalida el hash', () => {
  const selected = { ...connection, integrationMethod: 'browser' };
  const nativeRef = (label, type, region, radius) => {
    const context = { type, countryCode: 'CO', region, scope: 'Geografía del negocio 202' };
    return { source: 'browser', providerId: null, label, key: hash({ label, context, businessId: '202' }), context: { ...context, ...(radius ? { radius, distanceUnit: 'kilometer' } : {}) } };
  };
  const capital = nativeRef('Bogotá', 'city', 'Distrito Capital', 20), risaralda = nativeRef('Risaralda', 'region', 'Risaralda');
  const first = build(config({ audience: { countries: ['US', 'PE'], regions: [risaralda], cities: [capital] } }, selected), selected);
  const reordered = build(config({ audience: { countries: ['PE', 'US'], regions: [risaralda], cities: [capital] } }, selected), selected);
  assert.equal(first.specHash, reordered.specHash);
  const wider = { ...capital, context: { ...capital.context, radius: 25 } };
  assert.notEqual(first.specHash, build(config({ audience: { countries: ['US', 'PE'], regions: [risaralda], cities: [wider] } }, selected), selected).specHash);
  invalid(() => build(config({ audience: { countries: ['CO'], cities: [capital] } }, selected), selected));
  const overlapping = nativeRef('Distrito Capital', 'region', 'DISTRITO CAPITAL');
  invalid(() => build(config({ audience: { countries: [], regions: [overlapping], cities: [capital] } }, selected), selected));
});

test('la referencia nativa no puede falsificar negocio, jerarquía, contexto ni radio', () => {
  const selected = { ...connection, integrationMethod: 'browser' }, label = 'Bogotá';
  const context = { type: 'city', countryCode: 'CO', region: 'Distrito Capital', scope: 'Geografía del negocio 202' };
  const ref = { source: 'browser', providerId: null, label, key: hash({ label, context, businessId: '202' }), context: { ...context, radius: 20, distanceUnit: 'kilometer' } };
  for (const forged of [
    { ...ref, key: hash({ label, context, businessId: '999' }) },
    { ...ref, context: { ...ref.context, countryCode: 'US' } },
    { ...ref, context: { ...ref.context, region: '' } },
    { ...ref, context: { ...ref.context, scope: '' } },
    { ...ref, context: { ...ref.context, radius: 1 } },
    { ...ref, context: { ...context } },
    { ...ref, context: 'Colombia, geographic audience' },
    { ...ref, providerId: '12345' }
  ]) invalid(() => build(config({ audience: { countries: [], cities: [forged] } }, selected), selected));
});

test('horarios son UTC, ordenados, futuros y acotados a 90 días de lifetime', () => {
  const campaign = config({ startAt: '2026-11-03T07:00:00-05:00' });
  assert.equal(campaign.startAt, '2026-11-03T12:00:00.000Z');
  for (const dates of [
    { startAt: NOW }, { startAt: null }, { endAt: null }, { endAt: '2026-11-03T12:00:00Z' },
    { endAt: '2027-02-02T12:00:00Z' }, { publishAt: '2026-11-03T12:00:00Z' }
  ]) invalid(() => build(config(dates)));
  invalid(() => config({ startAt: '2026-11-03T12:00:00' }));
  invalid(() => config({ startAt: '2026-02-30T12:00:00Z' }));
  invalid(() => config({ observationDays: 30 }));
  assert.equal(build(config({ endAt: '2027-02-01T12:00:00Z' })).spec.endAt, '2027-02-01T12:00:00.000Z');
});

test('matriz de red y pieza exige feed para imagen y Reel orgánico para video', () => {
  const organic = config({ mode: 'organic', budgetMinor: 0, targetCostMinor: null, startAt: null, endAt: null });
  assert.equal(build(organic).spec.mode, 'organic');
  invalid(() => build({ ...organic, placements: ['facebook_reels', 'instagram_reels'] }));
  const video = { ...asset, kind: 'video' };
  invalid(() => build(organic, connection, video));
  assert.equal(build({ ...organic, placements: ['facebook_reels', 'instagram_reels'] }, connection, video).spec.platforms.length, 2);
  assert.equal(build(config({ placements: ['facebook_feed', 'instagram_reels'] }), connection, video).spec.mode, 'paid');
  const paidReels = build(config({ placements: ['facebook_reels', 'instagram_reels'] }), connection, video).spec;
  assert.deepEqual(paidReels.targeting.facebook_positions, ['facebook_reels']);
  assert.deepEqual(paidReels.targeting.instagram_positions, ['reels']);
  invalid(() => build(config({ platforms: ['facebook'] })));
  invalid(() => build(config({ platforms: ['facebook', 'instagram'], placements: ['facebook_feed'] })));
  invalid(() => config({ placements: ['messenger'] }));
});

test('faltan identidad, capacidad o pieza: no se puede aprobar aunque el borrador exista', () => {
  for (const selected of [
    { ...connection, state: 'reconnect_required' },
    { ...connection, capabilities: { ...connection.capabilities, adsPublish: false } },
    { ...connection, identities: { ...connection.identities, instagramId: null } }
  ]) assert.throws(() => build(config({}, selected), selected));
  for (const piece of [{ ...asset, state: 'processing' }, { ...asset, state: 'missing_file' }, { ...asset, sha256: 'incorrecto' }, { ...asset, derivativeSha256: 'b'.repeat(64) }]) assert.throws(() => build(config(), connection, piece), { status: 409 });
  assert.throws(() => build({ ...config(), restore_hold: true }), { status: 409 });
});

test('hash incluye toda configuración y excluye metadatos técnicos, forecast y aceptación', () => {
  const campaign = config(), first = build(campaign);
  const noisy = { ...campaign, id: 'campaign-id', state: 'publishing', version: 99, updatedAt: NOW, remoteId: '999', forecastId: 'forecast-id', forecast: { range: [1, 2] }, acceptedWarnings: ['anything'], preflight: { remoteDraftRef: 'draft-id' }, connectionContext: campaign.connectionContext };
  assert.equal(build(noisy).specHash, first.specHash);
  assert.equal(first.specHash, hash(first.spec));
  assert.notEqual(build({ ...campaign, name: 'Otra publicación' }).specHash, first.specHash);
  assert.notEqual(build({ ...campaign, targetCostMinor: 200000 }).specHash, first.specHash);
  assert.notEqual(build({ ...campaign, caption: 'Otro texto' }).specHash, first.specHash);
  assert.notEqual(build({ ...campaign, whatsappGreeting: 'Bienvenida expresamente editada' }).specHash, first.specHash);
  assert.equal(build({ ...campaign, platforms: ['instagram', 'facebook'], placements: ['instagram_feed', 'facebook_feed'] }).specHash, first.specHash);
});

test('advertencias orgánicas preservan ausencias y no prometen audiencia ni costo por resultado', () => {
  const organic = config({ mode: 'organic', budgetMinor: 0, targetCostMinor: null, startAt: null, endAt: null, objective: 'whatsapp' });
  const { warnings } = build(organic);
  assert.ok(warnings.some(warning => warning.key === 'organicDistribution'));
  assert.ok(warnings.some(warning => warning.key === 'organicInstagramKpiUnavailable'));
  assert.ok(warnings.every(warning => Object.keys(warning).sort().join(',') === 'key,message' && typeof warning.message === 'string'));
  invalid(() => build({ ...organic, publishAt: NOW }));
  invalid(() => build({ ...organic, budgetMinor: 100 }));
});
