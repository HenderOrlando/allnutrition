import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { startAssistantTurn } from '@/lib/assistant/engine.mjs';
import { validateTurnInput, validateAssistantTurnStatus } from '@/lib/assistant/contracts.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const input = validateTurnInput(await jsonBody(request, { maxBytes: 64 * 1024 }));
    const result = await startAssistantTurn(await db(), session, input);
    return json(validateAssistantTurnStatus(result), result.state === 'running' ? 202 : 200);
  } catch (error) { return assistantHTTPError(error); }
}
