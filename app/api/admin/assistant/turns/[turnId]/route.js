import { authorizeAssistant, db, json } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { getAssistantTurnStatus } from '@/lib/assistant/engine.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const session = await authorizeAssistant(request);
    const { turnId } = await params;
    text(turnId, 'Turno', 100, true);
    return json(await getAssistantTurnStatus(await db(), session, turnId));
  } catch (error) { return assistantHTTPError(error); }
}
