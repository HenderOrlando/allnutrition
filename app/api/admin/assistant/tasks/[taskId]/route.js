import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { deleteAdvisorTask, getAdvisorTask, updateAdvisorTask } from '@/lib/assistant/advisor-tasks.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

async function taskRequest(request, params, mutate) {
  try {
    const session = await authorizeAssistant(request, { write: Boolean(mutate) });
    const { taskId } = await params;
    if (new URL(request.url).searchParams.size) fail('Consulta de tarea no válida.', 422);
    const store = await db();
    if (!mutate) return json(await getAdvisorTask(store, session, taskId));
    const input = await jsonBody(request, { maxBytes: 20 * 1024 });
    return json(await mutate(store, session, taskId, input));
  } catch (error) { return assistantHTTPError(error); }
}

export function GET(request, { params }) { return taskRequest(request, params); }
export function PATCH(request, { params }) { return taskRequest(request, params, updateAdvisorTask); }
export function DELETE(request, { params }) { return taskRequest(request, params, deleteAdvisorTask); }
