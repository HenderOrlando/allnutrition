import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { startSocialOAuth } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  return json(await startSocialOAuth(await db(), await jsonBody(request, { maxBytes: 4096 }), session));
} catch (error) { return errorResponse(error); } }
