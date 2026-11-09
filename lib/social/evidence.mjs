import { hash } from '../business/commands.mjs';
import { hasDomain } from './config.mjs';

export function socialMeasurementQueryKey(data) {
  const { integrationMethod, adapterVersion, apiVersion, query, periodStart, periodEnd, timeZone, scope, attributionSetting, actionReportTime, dimension } = data;
  return hash({ integrationMethod, adapterVersion, apiVersion: apiVersion ?? null, query, periodStart, periodEnd, timeZone, scope, attributionSetting: attributionSetting ?? null, actionReportTime: actionReportTime ?? null, dimension: dimension ?? null,
    ...(data.definitionVersion ? { definitionVersion: data.definitionVersion, entity: data.entity || null } : {}) });
}

// A displayed permalink is evidence, not a browser navigation. Validate it
// against public Meta hosts without granting the browser another destination.
export function socialPermalink(value) {
  let url;
  try { url = new URL(value); } catch {}
  let publicQuery = !url?.search;
  if (url?.search && hasDomain(url.hostname, 'facebook.com')) {
    const photo = /^\/photo(?:\.php)?\/?$/.test(url.pathname);
    const story = url.pathname === '/story.php';
    const albumPhoto = /^\/[^/]+\/photos\/[^/]+\/[^/]+\/?$/.test(url.pathname);
    const allowed = photo ? ['fbid', 'set', 'type'] : story ? ['story_fbid', 'id'] : albumPhoto ? ['type'] : [];
    const required = photo ? ['fbid'] : story ? ['story_fbid', 'id'] : [];
    const patterns = { fbid: /^(?:\d{1,30}|pfbid[A-Za-z0-9]{1,200})$/, story_fbid: /^(?:\d{1,30}|pfbid[A-Za-z0-9]{1,200})$/, id: /^\d{1,30}$/, set: /^a\.\d{1,30}$/, type: /^[13]$/ };
    publicQuery = (photo || story || albumPhoto) && required.every(key => url.searchParams.has(key)) &&
      [...url.searchParams].every(([key, entry]) => allowed.includes(key) && url.searchParams.getAll(key).length === 1 && patterns[key].test(entry));
  }
  if (typeof value !== 'string' || value.length > 2048 || !url || url.protocol !== 'https:' || url.port || url.username || url.password || !publicQuery || url.hash || !['facebook.com', 'instagram.com'].some(domain => hasDomain(url.hostname, domain))) {
    throw Object.assign(new Error('El enlace publicado no pertenece a Meta.'), { errorCode: 'SPEC_MISMATCH', status: 409 });
  }
  return url.href;
}

export const SOCIAL_ASSET_INTERNAL_FIELDS = Object.freeze(['uploadFence', 'uploadRequestId', 'processingFence']);
export function clearSocialMetricWork(data) {
  delete data.metricsRequestedAt;
  delete data.stateReadRequestedAt;
  if (data.metricSync && typeof data.metricSync === 'object' && !Array.isArray(data.metricSync)) {
    for (const key of ['cycle', 'nextAt', 'retryAt', 'unsupportedMetrics', 'blocked']) delete data.metricSync[key];
  }
  return data;
}

// Only application-owned diagnostic codes may cross the commercial boundary;
// an arbitrary OAuth/provider `code` is still private.
export const SOCIAL_MEDIA_DIAGNOSTIC_CODES = Object.freeze([
  'UPLOAD_INTERRUPTED', 'UPLOAD_EXPIRED', 'INVALID_IMAGE', 'CONTENT_TYPE_MISMATCH',
  'ANIMATED_IMAGE', 'IMAGE_PIXELS', 'IMAGE_GEOMETRY', 'INVALID_DERIVATIVE',
  'PROCESSING_ABORTED', 'PROCESSOR_UNAVAILABLE', 'PROCESSING_FAILED', 'INVALID_VIDEO',
  'VIDEO_GEOMETRY', 'VIDEO_DURATION', 'IMMUTABLE_ASSET', 'DERIVATIVE_SIZE',
  'QUOTA_EXCEEDED', 'RESTORED_ORIGINAL_ONLY', 'RESTORE_VERIFICATION_REQUIRED'
]);

export const SOCIAL_ERROR_MESSAGES = Object.freeze({
  AUTH_FAILED: 'El canal privado del navegador no pudo autenticarse.',
  LEASE_LOST: 'Otro proceso tomó el trabajo. Es necesario comprobar el último estado remoto.',
  SESSION_EXPIRED: 'La sesión de Meta venció o fue revocada. Reconecta la misma cuenta.',
  CHALLENGE_REQUIRED: 'Meta exige intervención humana para completar un desafío.',
  LAYOUT_CHANGED: 'La interfaz no coincide con los controles verificados del adaptador.',
  ACCOUNT_MISMATCH: 'La identidad observada no coincide con la conexión aprobada.',
  SPEC_MISMATCH: 'La configuración remota no coincide con la aprobación. No se activó una corrección automática.',
  CONFIGURATION_CHANGED: 'La integración cambió. Vuelve a verificar la cuenta y la preparación antes de publicar.',
  OPERATION_UNCERTAIN: 'No se pudo confirmar el efecto remoto. Reconcilia antes de volver a enviar.',
  BROWSER_BUSY: 'La conexión está siendo utilizada por otro control o trabajo.',
  TIMEOUT: 'Se agotó el tiempo de la etapa. Comprueba el último estado confirmado.',
  PERMISSION_REQUIRED: 'Falta un permiso o capacidad de Meta para esta acción.',
  RATE_LIMITED: 'Meta limitó temporalmente las solicitudes. Se respetará la espera registrada.',
  PROVIDER_ERROR: 'Meta no pudo completar la solicitud. Consulta el último estado confirmado.',
  PUBLISHING_DISABLED: 'La publicación está deshabilitada en Configuración.',
  RESTORE_HOLD: 'La campaña restaurada requiere reconciliación y aceptación explícita.',
  SCHEDULE_MISSED: 'La hora aprobada pasó hace más de quince minutos. Duplica y reprograma antes de publicar.',
  PROVIDER_REJECTED: 'Meta rechazó o no aprobó esta operación. Revisa la razón y corrige mediante un borrador nuevo.',
  MISSING_FILE: 'La pieza privada falta o no coincide con su SHA-256.'
});
export function socialErrorCode(error) {
  const code = error?.errorCode || error?.code;
  return Object.hasOwn(SOCIAL_ERROR_MESSAGES, code) ? code : error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'TIMEOUT' : 'PROVIDER_ERROR';
}
export function socialErrorDetails(error) {
  const code = socialErrorCode(error);
  return { code, message: SOCIAL_ERROR_MESSAGES[code] };
}
