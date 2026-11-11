import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { runAssistantTurn } from '@/lib/assistant/engine.mjs';
import { validateTurnInput, validateTurnResult } from '@/lib/assistant/contracts.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function POST(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const input = validateTurnInput(await jsonBody(request, { maxBytes: 64 * 1024 }));
    const result = await runAssistantTurn(await db(), session, input, { signal: request.signal });
    return json(validateTurnResult(result));
  } catch (error) { return assistantHTTPError(error); }
}
