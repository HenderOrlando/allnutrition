import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { deleteAssistantThread, getAssistantThread } from '@/lib/assistant/conversations.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail, integer, text } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const session = await authorizeAssistant(request);
    const { threadId } = await params;
    text(threadId, 'Conversación', 100, true);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'before') || query.getAll('before').length > 1) fail('Consulta no válida.', 422);
    const before = query.get('before');
    if (before !== null && (!before || before.length > 200)) fail('Cursor no válido.', 422);
    return json(await getAssistantThread(await db(), session, threadId, { before }));
  } catch (error) { return assistantHTTPError(error); }
}

export async function DELETE(request, { params }) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const { threadId } = await params;
    text(threadId, 'Conversación', 100, true);
    const input = await jsonBody(request, { maxBytes: 4096 });
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'version')) fail('Solicitud no válida.', 422);
    const version = integer(input.version, 'Versión', 1);
    return json(await deleteAssistantThread(await db(), session, threadId, version));
  } catch (error) { return assistantHTTPError(error); }
}
