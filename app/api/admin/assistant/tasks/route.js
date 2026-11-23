import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { listAdvisorTasks, reserveAdvisorTask } from '@/lib/assistant/advisor-tasks.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    const query = new URL(request.url).searchParams;
    const kind = query.get('kind');
    const page = query.get('page');
    if (query.size !== Number(kind !== null) + Number(page !== null)
      || kind !== null && !['reminder', 'task'].includes(kind)
      || page !== null && !/^[1-9]\d{0,5}$/.test(page)) fail('Consulta de tareas no válida.', 422);
    return json(await listAdvisorTasks(await db(), session, { page: page === null ? 1 : Number(page), kind: kind ?? undefined }));
  } catch (error) { return assistantHTTPError(error); }
}

export async function POST(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const input = await jsonBody(request, { maxBytes: 20 * 1024 });
    return json(await reserveAdvisorTask(await db(), session, input));
  } catch (error) { return assistantHTTPError(error); }
}
