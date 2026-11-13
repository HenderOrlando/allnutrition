import { authorizeAssistant, db, json } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { pageAssistantTurnRead } from '@/lib/assistant/engine.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    const session = await authorizeAssistant(request);
    const { turnId, readId } = await params;
    text(turnId, 'Turno', 100, true); text(readId, 'Lectura', 120, true);
    return json(await pageAssistantTurnRead(await db(), session, turnId, readId, { cursor:new URL(request.url).searchParams.get('cursor') }));
  } catch (error) { return assistantHTTPError(error); }
}
