import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { listAdvisorInbox, updateAdvisorInbox } from '@/lib/assistant/inbox.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    const query = new URL(request.url).searchParams;
    const summary = query.get('summary');
    const page = query.get('page');
    if (query.size > 1 || query.size === 1 && !(summary === '1' || page !== null && /^[1-9]\d{0,5}$/.test(page))) {
      fail('Consulta de bandeja no válida.', 422);
    }
    return json(await listAdvisorInbox(await db(), session, { page: page === null ? 1 : Number(page), summary: summary === '1' }));
  } catch (error) { return assistantHTTPError(error); }
}

export async function PATCH(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    if (new URL(request.url).searchParams.size) fail('Consulta de bandeja no válida.', 422);
    const input = await jsonBody(request, { maxBytes: 2048 });
    return json(await updateAdvisorInbox(await db(), session, input));
  } catch (error) {
    if (error?.code === 'ASSISTANT_CONFLICT' && error.current) {
      return json({ error: error.message, code: error.code, current: error.current }, 409);
    }
    return assistantHTTPError(error);
  }
}
