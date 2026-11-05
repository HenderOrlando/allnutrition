import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getSocialConnections, createBrowserSocialConnection } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  return json(await getSocialConnections(await db()));
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  return json(await createBrowserSocialConnection(await db(), await jsonBody(request, { maxBytes: 4096 }), session.user.id), 201);
} catch (error) { return errorResponse(error); } }
