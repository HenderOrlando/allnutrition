import { jsonBody } from '../server.mjs';
import { fail } from '../validation-core.mjs';

// Electron main owns the bearer. Browser cookies and cross-origin renderer calls
// are deliberately not accepted as a substitute for device authentication.
export async function readBridgeRequest(request, { paired = true, maxBytes = 16384 } = {}) {
  if (request.headers.has('origin') || new URL(request.url).search) fail('La ruta requiere una solicitud directa del dispositivo.', 403);
  let auth = null;
  if (paired) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') || '');
    if (!match) fail('El dispositivo necesita una vinculación vigente.', 401);
    auth = { bearer: match[1] };
  }
  return { input: await jsonBody(request, { maxBytes }), auth };
}
