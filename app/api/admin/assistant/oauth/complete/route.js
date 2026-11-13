import { authorizeAssistant, db, errorResponse, json, jsonBody } from '../../../../../../lib/server.mjs';
import { assertAssistantSession } from '../../../../../../lib/assistant/settings.mjs';
import { assistantOAuthErrorResponse, completeAssistantOAuth } from '../../../../../../lib/assistant/oauth.mjs';

export const runtime = 'nodejs';
export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    await assertAssistantSession(await db(), session);
    return json({ csrf: session.csrf });
  } catch (error) { return assistantOAuthErrorResponse(error) || errorResponse(error); }
}
export async function POST(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    return json(await completeAssistantOAuth(await db(), await jsonBody(request, { maxBytes: 16 * 1024 }), session, { signal: request.signal }));
  } catch (error) { return assistantOAuthErrorResponse(error) || errorResponse(error); }
}
