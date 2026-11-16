import { fail, integer, text } from '../validation-core.mjs';
import { getSocialConnection } from './social.mjs';
import { runCommand, updateVersioned, audit, hash, stamp } from './commands.mjs';
import { loadSocialRuntime, requireIntegration } from '../social/config.mjs';
import { decryptCredentials } from '../social/credentials.mjs';
import { createSocialConnector } from '../social/connectors.mjs';
import { createMetaClient } from '../social/meta.mjs';
import { SOCIAL_BUSINESS_OBJECTIVES, newSocialMeasurementConfig, socialMeasurementDTO } from '../social/measurement-model.mjs';

const SOURCES = ['none', 'meta_pixel', 'dataset', 'external'];
const id = (value, label) => {
  const result = text(value, label, 40);
  if (result && !/^\d+$/.test(result)) fail(`${label}: usa únicamente dígitos.`);
  return result || null;
};
async function actor(tx, actorId) {
  if (!await tx.db.get(`SELECT id FROM ${tx.t('users')} WHERE id=? AND active=1`, [actorId])) fail('El administrador ya no está autorizado.', 403);
}
function dataOf(connection) {
  const { id, provider, integrationMethod, state, version, createdAt, updatedAt, ...data } = connection;
  return data;
}
function normalize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración de medición no válida.');
  if (!SOCIAL_BUSINESS_OBJECTIVES.includes(input.objective)) fail('Selecciona un objetivo del negocio válido.');
  if (!SOURCES.includes(input.source)) fail('Selecciona una fuente de medición válida.');
  if (!Array.isArray(input.events) || input.events.length > 20) fail('Configura hasta 20 eventos de medición.');
  const events = input.events.map(event => {
    const name = text(event?.name, 'Evento', 80, true);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(name) || !SOCIAL_BUSINESS_OBJECTIVES.includes(event.objective)) fail('El evento o su objetivo no es válido.');
    return { name, objective: event.objective };
  });
  if (new Set(events.map(event => event.name)).size !== events.length) fail('No repitas nombres de eventos.');
  const pixelId = id(input.pixelId, 'Píxel'), datasetId = id(input.datasetId, 'Dataset');
  const externalDescription = text(input.externalDescription, 'Fuente externa', 1000);
  if (input.source === 'meta_pixel' && !pixelId || input.source === 'dataset' && !datasetId) fail('Indica el identificador de la fuente elegida.');
  if (input.source === 'external' && !externalDescription) fail('Describe la fuente externa y cómo se identifican sus resultados.');
  return { version: 1, objective: input.objective, source: input.source, pixelId: input.source === 'meta_pixel' ? pixelId : null, datasetId: input.source === 'dataset' ? datasetId : null, events, externalDescription: input.source === 'external' ? externalDescription : '' };
}
const sourceSignature = config => hash({ source: config.source, pixelId: config.pixelId, datasetId: config.datasetId, events: config.events, externalDescription: config.externalDescription });
export async function getSocialMeasurement(store, connectionId) {
  const connection = await getSocialConnection(store, connectionId);
  return {
    connectionId, connectionVersion: connection.version, config: socialMeasurementDTO(connection),
    requirements: {
      reach: 'Alcance reportado por Meta; no requiere píxel y no se suma entre publicaciones o períodos.',
      engagement: 'Interacciones reportadas por Meta; no equivalen a personas únicas ni ventas.',
      traffic: 'Clics de enlace no son visitas. PageView/ViewContent y una fuente comprobada permiten distinguir eventos del sitio.',
      whatsapp: 'Conversaciones iniciadas reportadas por Meta; clics a WhatsApp no equivalen a consultas o ventas.',
      sales: 'Purchase, fuente asociada a la cuenta y evento/atribución reportados. Un píxel accesible o activo no demuestra compras ni causalidad.'
    },
    notice: 'Guardar configura el análisis local. No instala rastreadores, no cambia campañas y no envía eventos ni datos de clientes. La instalación y el consentimiento en sitios externos se gestionan por separado.'
  };
}
export async function saveSocialMeasurement(store, connectionId, input, actorId, options = {}) {
  const config = normalize(input.config);
  const version = integer(input.version, 'Versión de conexión', 1);
  const authorizedStore = { transaction: fn => store.transaction(async tx => { await tx.lockWrites(); await actor(tx, actorId); return fn(tx); }) };
  return runCommand(authorizedStore, { scope: `social:measurement:${connectionId}:save`, requestId: input.requestId, payload: { version, config }, actorId, affectsIndicators: false }, async tx => {
    const connection = await getSocialConnection(tx, connectionId);
    if (connection.version !== version) fail('La conexión cambió. Recarga la configuración de medición.', 409);
    const previous = socialMeasurementDTO(connection);
    const verification = sourceSignature(previous) === sourceSignature(config) ? previous.verification : newSocialMeasurementConfig().verification;
    const next = { ...config, verification, updatedAt: options.now || stamp() };
    await updateVersioned(tx, 'social_connections', connectionId, version, { data: JSON.stringify({ ...dataOf(connection), measurementConfig: next }) });
    await audit(tx, { entityType: 'social_measurement_config', entityId: connectionId, actorId, next, reason: 'Configuración local de objetivo y fuentes; no autoriza seguimiento ni envíos' });
    return getSocialMeasurement(tx, connectionId);
  });
}
export async function verifySocialMeasurement(store, connectionId, input, actorId, options = {}) {
  await actor(store, actorId);
  if (typeof input.requestId !== 'string' || !/^[\w:-]{8,100}$/.test(input.requestId)) fail('Identificador de operación no válido.');
  const version = integer(input.version, 'Versión de conexión', 1);
  const command = { scope: `social:measurement:${connectionId}:verify`, requestId: input.requestId, payload: { version }, actorId, affectsIndicators: false };
  const authorizedStore = { transaction: fn => store.transaction(async tx => { await tx.lockWrites(); await actor(tx, actorId); return fn(tx); }) };
  if (await store.db.get(`SELECT request_id FROM ${store.t('business_requests')} WHERE scope=? AND request_id=?`, [command.scope, input.requestId])) return runCommand(authorizedStore, command, () => fail('La operación ya terminó.', 409));
  const connection = await getSocialConnection(store, connectionId);
  if (connection.version !== version) fail('La conexión cambió. Recarga la configuración de medición.', 409);
  const config = socialMeasurementDTO(connection);
  let verification = { status: 'unavailable', checkedAt: options.now || stamp(), notice: 'La fuente externa no puede comprobarse con Meta. Registra y revisa su evidencia por separado; no acredita atribución.' };
  let sources = [], runtime, credentialRow;
  if (['meta_pixel', 'dataset'].includes(config.source)) {
    if (connection.integrationMethod !== 'api' || connection.state !== 'connected' || connection.revalidationRequired || connection.disconnectPending || !/^act_\d+$/.test(connection.identities?.adAccountId || '')) fail('Selecciona y revalida una cuenta publicitaria API vigente.', 409);
    runtime = requireIntegration('api', await loadSocialRuntime(store, options), connection.authenticationMethod || 'oauth');
    credentialRow = await store.db.get(`SELECT * FROM ${store.t('social_credentials')} WHERE connection_id=?`, [connectionId]);
    const credentials = decryptCredentials(connection, credentialRow, runtime);
    if (!credentials) fail('La conexión necesita autenticarse de nuevo.', 409);
    const connector = await createSocialConnector({ connection: { ...connection, data: connection }, credentials, runtime, transport: { fetchImpl: options.fetchImpl } });
    await connector.validateConnection({ purpose: 'insights', channel: 'meta_ads', signal: options.signal });
    const client = createMetaClient({ accessToken: credentials.accessToken, appSecret: runtime.appSecret, graphVersion: runtime.graphVersion, fetchImpl: options.fetchImpl });
    try {
      const rows = await client.pages(`${connection.identities.adAccountId}/adspixels`, { fields: 'id,name,last_fired_time,is_unavailable', limit: 100 }, { signal: options.signal });
      sources = rows.filter(row => typeof row.id === 'string' && /^\d+$/.test(row.id)).map(row => ({ id: row.id, name: typeof row.name === 'string' ? row.name.slice(0, 200) : '', lastFiredAt: typeof row.last_fired_time === 'string' && Number.isFinite(Date.parse(row.last_fired_time)) ? new Date(row.last_fired_time).toISOString() : null, unavailable: row.is_unavailable === true }));
      const selectedId = config.source === 'meta_pixel' ? config.pixelId : config.datasetId;
      const source = sources.find(row => row.id === selectedId);
      verification = { status: source && !source.unavailable ? 'verified' : 'unavailable', checkedAt: options.now || stamp(), accountId: connection.identities.adAccountId, sourceId: selectedId, lastFiredAt: source?.lastFiredAt || null, notice: source && !source.unavailable ? 'Meta confirmó acceso y asociación de esta fuente a la cuenta. Esto no comprueba instalación, recepción del evento configurado, compras ni atribución; revisa Events Manager y los resultados reportados.' : 'Meta no acreditó esta fuente entre los píxeles/datasets disponibles de la cuenta. Revisa permisos, asociación y Events Manager; no se presupone medición.' };
      verification.sessionEpoch = connection.sessionEpoch || 0;
      verification.configurationFingerprint = runtime.fingerprint;
    } catch (error) {
      if (error.kind !== 'permission') throw error;
      verification = { status: 'unavailable', checkedAt: options.now || stamp(), notice: 'Meta no autoriza consultar las fuentes de esta cuenta. No se acredita medición ni recepción de eventos.' };
    }
  } else if (config.source === 'none') verification.notice = 'Sin fuente adicional. Solo se usan métricas reportadas por Meta que los permisos permitan; no se acreditan visitas ni compras del sitio.';
  return runCommand(authorizedStore, command, async tx => {
    const current = await getSocialConnection(tx, connectionId);
    if (current.version !== version) fail('La conexión cambió durante la comprobación de medición.', 409);
    if (runtime) {
      const latestRuntime = await loadSocialRuntime(tx, options);
      const latestCredential = await tx.db.get(`SELECT version FROM ${tx.t('social_credentials')} WHERE connection_id=?`, [connectionId]);
      if (latestRuntime.configurationVersion !== runtime.configurationVersion || latestRuntime.fingerprint !== runtime.fingerprint || latestCredential?.version !== credentialRow.version) fail('La configuración o las credenciales cambiaron durante la comprobación.', 409);
    }
    await updateVersioned(tx, 'social_connections', connectionId, version, { data: JSON.stringify({ ...dataOf(current), measurementConfig: { ...config, verification } }) });
    await audit(tx, { entityType: 'social_measurement_check', entityId: connectionId, actorId, next: verification, reason: 'Comprobación de lectura; no envía eventos' });
    return { ...await getSocialMeasurement(tx, connectionId), sources };
  });
}
