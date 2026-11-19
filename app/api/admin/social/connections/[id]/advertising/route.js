import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialAccountAdvertising } from '@/lib/business/social-account-advertising.mjs';
import { socialMetaError } from '@/lib/business/social-connections.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  const session = await authorize(request), { id } = await params;
  const query = Object.fromEntries(new URL(request.url).searchParams);
  return json(await getSocialAccountAdvertising(await db(), id, query, session.user.id, { signal: request.signal }));
} catch (error) {
  const problem = socialMetaError(error);
  if (error.kind === 'rate_limit') return json({ ...(problem || { error: error.message }), limits: error.limits || { status: 'unknown', usage: [], retryAfter: error.retryAfter ?? null } }, 429);
  return problem ? json(problem, error.status) : errorResponse(error);
} }
