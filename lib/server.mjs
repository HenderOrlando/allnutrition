import 'server-only';
import { cookies } from 'next/headers';
import { openStore } from './db/index.mjs';
import { allowedOrigins } from './db/config.mjs';
import { getSession, SESSION_COOKIE, assertCSRF, assertOrigin } from './auth.mjs';
import { AppError, fail } from './validation.mjs';
export async function db() {
  if (!globalThis.__allNutritionStoreV2) globalThis.__allNutritionStoreV2 = openStore().catch(error => { delete globalThis.__allNutritionStoreV2; throw error; });
  return globalThis.__allNutritionStoreV2;
}
export async function session() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  // Una visita pública no abre la BD solo para comprobar una cookie inexistente.
  return token ? getSession(await db(), token) : null;
}
export function checkOrigin(request) { assertOrigin(request.headers.get('origin'), allowedOrigins()); }
export async function authorize(request, { write = false } = {}) {
  const value = await session(); if (!value) fail('Inicia sesión para continuar.', 401);
  if (write) { checkOrigin(request); assertCSRF(request.headers.get('x-csrf-token'), value.csrf); }
  return value;
}
export async function bodyBytes(request, max = 131072) {
  const length = Number(request.headers.get('content-length') || 0); if (length > max) fail('Solicitud demasiado grande.', 413);
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader(); let total = 0; const chunks = [];
  while (true) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > max) { await reader.cancel(); fail('Solicitud demasiado grande.', 413); } chunks.push(Buffer.from(value)); }
  return Buffer.concat(chunks);
}
export async function jsonBody(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) fail('Usa contenido JSON.', 415);
  try { return JSON.parse((await bodyBytes(request)).toString('utf8')); } catch (error) { if (error instanceof AppError) throw error; fail('JSON no válido.'); }
}
export const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export function errorResponse(error) {
  if (error instanceof AppError || (error && Number.isInteger(error.status) && error.status >= 400 && error.status < 500)) return json({ error: error.message }, error.status);
  console.error('Error interno de All Nutrition:', error.code || error.name || 'unknown');
  const unavailable = ['ECONNREFUSED','ETIMEDOUT','ENOTFOUND','ECONNRESET','57P01','08006','53300'].includes(error.code);
  return json({ error: unavailable ? 'La base de datos no está disponible. No se cambió a otra base ni se confirmó el guardado. Reintenta cuando se restablezca el servicio.' : 'No se pudo completar la operación. Revisa la configuración y los registros del servidor.' }, unavailable ? 503 : 500);
}
