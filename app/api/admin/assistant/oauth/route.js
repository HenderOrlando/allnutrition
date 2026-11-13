import { authorizeAssistant, db, errorResponse, json, jsonBody } from '../../../../../lib/server.mjs';
import { assertAssistantSession, disconnectAssistantOAuth } from '../../../../../lib/assistant/settings.mjs';
import { googleOAuthConfig } from '../../../../../lib/assistant/google-oauth.mjs';
import { assistantOAuthErrorResponse } from '../../../../../lib/assistant/oauth.mjs';

export const runtime = 'nodejs';
export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    await assertAssistantSession(await db(), session);
    return json({ configured: googleOAuthConfig().configured });
  } catch (error) { return assistantOAuthErrorResponse(error) || errorResponse(error); }
}
export async function DELETE(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    return json(await disconnectAssistantOAuth(await db(), await jsonBody(request, { maxBytes: 1024 }), session));
  } catch (error) { return assistantOAuthErrorResponse(error) || errorResponse(error); }
}
