import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { advanceAssistantTurn } from '@/lib/assistant/engine.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  try {
    const session = await authorizeAssistant(request, { write:true });
    const { turnId } = await params;
    text(turnId, 'Turno', 100, true);
    const result = await advanceAssistantTurn(await db(), session, turnId, await jsonBody(request, { maxBytes:4096 }), { signal:request.signal });
    return json(result, result.state === 'running' ? 202 : 200);
  } catch (error) { return assistantHTTPError(error); }
}
