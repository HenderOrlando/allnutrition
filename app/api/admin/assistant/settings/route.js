import { authorizeAssistant, db, errorResponse, json, jsonBody } from '../../../../../lib/server.mjs';
import { assertAssistantSession, getAssistantSettings, saveAssistantSettings } from '../../../../../lib/assistant/settings.mjs';
import { fail } from '../../../../../lib/validation-core.mjs';

export const runtime = 'nodejs';

const SETTINGS_INPUT_KEYS = new Set(['version', 'requestId', 'enabled', 'provider', 'baseUrl', 'model', 'allowPrivateNetwork', 'apiKey', 'clearApiKey', 'authMethod', 'projectId']);
function validateSettingsInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Configuración no válida.');
  for (const key of Object.keys(input)) if (!SETTINGS_INPUT_KEYS.has(key)) fail(`Campo no permitido en configuración: ${key}.`);
  if (typeof input.requestId !== 'string' || !input.requestId.trim() || input.requestId.length > 100) fail('Solicitud no válida.');
  return input;
}

function assistantErrorResponse(error) {
  if (typeof error?.code === 'string' && error.code.startsWith('ASSISTANT_')) return json({ error: error.message, code: error.code }, error.status || 503);
  if (typeof error?.code === 'string' && error.code.startsWith('INTEGRATION_KEY_')) return json({ error: 'La custodia privada de Ali no está disponible. Restaura su clave original.', code: 'ASSISTANT_CREDENTIAL_INVALID' }, 422);
  return errorResponse(error);
}

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request), store = await db();
    await assertAssistantSession(store, session);
    return json(await getAssistantSettings(store));
  } catch (error) { return assistantErrorResponse(error); }
}

export async function PUT(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const input = validateSettingsInput(await jsonBody(request, { maxBytes: 16 * 1024 }));
    return json(await saveAssistantSettings(await db(), input, session, { signal: request.signal }));
  } catch (error) { return assistantErrorResponse(error); }
}
