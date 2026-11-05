import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { queueSocialBrowserPreflight } from '@/lib/business/social.mjs';

export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true });
  const input = await jsonBody(request, { maxBytes: 65536 });
  return json(await queueSocialBrowserPreflight(await db(), (await params).id, input, session.user.id), 202);
} catch (error) { return errorResponse(error); } }
