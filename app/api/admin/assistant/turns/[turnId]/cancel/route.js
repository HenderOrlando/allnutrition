import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { stopAssistantTurn } from '@/lib/assistant/engine.mjs';
import { validateAssistantTurnStatus } from '@/lib/assistant/contracts.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const { turnId } = await params;
    text(turnId, 'Turno', 100, true);
    const input = await jsonBody(request, { maxBytes: 4096 });
    const result = await stopAssistantTurn(await db(), session, turnId, input);
    return json(validateAssistantTurnStatus(result));
  } catch (error) { return assistantHTTPError(error); }
}
