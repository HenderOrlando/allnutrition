import { authorizeAssistant, db, json, jsonBody } from '@/lib/server.mjs';
import { fail, text } from '@/lib/validation-core.mjs';
import { assertAssistantSession } from '@/lib/assistant/settings.mjs';
import { cancelAssistantTurn } from '@/lib/assistant/repository.mjs';
import { validateTurnResult } from '@/lib/assistant/contracts.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function POST(request, { params }) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    const { turnId } = await params;
    text(turnId, 'Turno', 100, true);
    if (request.body) {
      const input = await jsonBody(request, { maxBytes: 4096 });
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) fail('Solicitud no válida.', 422);
    }
    const store = await db();
    const result = await store.transaction(async tx => {
      await assertAssistantSession(tx, session, { lock: true });
      const turn = await cancelAssistantTurn(tx, { userId: session.user.id, turnId, reason: 'user' });
      const result = turn.data.publicResult ? validateTurnResult(turn.data.publicResult) : null;
      await assertAssistantSession(tx, session);
      return { turnId: turn.id, state: turn.state, cancelled: turn.state === 'cancelled', result, receipt: result?.receipt ?? null };
    });
    return json(result);
  } catch (error) { return assistantHTTPError(error); }
}
