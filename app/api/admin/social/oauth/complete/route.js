import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { completeSocialOAuth } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  const session = await authorize(request);
  return json({ csrf: session.csrf });
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  return json(await completeSocialOAuth(await db(), await jsonBody(request, { maxBytes: 8192 }), session));
} catch (error) { return errorResponse(error); } }
