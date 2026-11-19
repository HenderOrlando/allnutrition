import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { completeSocialOAuth, socialMetaError } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  const session = await authorize(request);
  return json({ csrf: session.csrf });
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  const { redirectTo } = await completeSocialOAuth(await db(), await jsonBody(request, { maxBytes: 8192 }), session);
  return json({ redirectTo });
} catch (error) {
  const problem = socialMetaError(error);
  return problem ? json(problem, error.status) : errorResponse(error);
} }
