import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getSocialConnections, createBrowserSocialConnection, createTokenSocialConnection, socialMetaError } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  return json(await getSocialConnections(await db()));
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  const input = await jsonBody(request, { maxBytes: 8192 });
  const create = input?.authenticationMethod === 'token' ? createTokenSocialConnection : createBrowserSocialConnection;
  return json(await create(await db(), input, session.user.id, { signal: request.signal }), 201);
} catch (error) {
  const problem = socialMetaError(error);
  return problem ? json(problem, error.status) : errorResponse(error);
} }
