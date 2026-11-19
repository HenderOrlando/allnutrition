import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { socialConnectionAction, socialMetaError } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true }), { id } = await params;
  const input = await jsonBody(request, { maxBytes: 8192 });
  const result = await socialConnectionAction(await db(), id, input.action, input, session.user.id);
  return json(result, result.disconnectPending ? 202 : 200);
} catch (error) {
  const problem = socialMetaError(error);
  return problem ? json(problem, error.status) : errorResponse(error);
} }
