import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { readAdvisorPreferences, writeAdvisorPreferences } from '@/lib/assistant/advisor-preferences.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

function checkQuery(request) {
  if (new URL(request.url).searchParams.size) fail('Consulta de preferencias no válida.', 422);
}

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    checkQuery(request);
    return json(await readAdvisorPreferences(await db(), session));
  } catch (error) { return assistantHTTPError(error); }
}

export async function PUT(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    checkQuery(request);
    const input = await jsonBody(request, { maxBytes: 2048 });
    return json(await writeAdvisorPreferences(await db(), session, input));
  } catch (error) {
    if (error?.code === 'ASSISTANT_CONFLICT' && error.current) {
      return json({ error: error.message, code: error.code, current: error.current }, 409);
    }
    return assistantHTTPError(error);
  }
}
