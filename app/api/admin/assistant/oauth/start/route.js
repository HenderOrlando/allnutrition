import { authorizeAssistant, db, errorResponse, json, jsonBody } from '../../../../../../lib/server.mjs';
import { assistantOAuthErrorResponse, startAssistantOAuth } from '../../../../../../lib/assistant/oauth.mjs';

export const runtime = 'nodejs';
export async function POST(request) {
  try {
    const session = await authorizeAssistant(request, { write: true });
    return json(await startAssistantOAuth(await db(), await jsonBody(request, { maxBytes: 4096 }), session));
  } catch (error) { return assistantOAuthErrorResponse(error) || errorResponse(error); }
}
