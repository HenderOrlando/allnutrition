import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { socialAssetAction, socialAssetClientDTO } from '@/lib/business/social-media.mjs';
export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true }), { id } = await params;
  const input = await jsonBody(request, { maxBytes: 4096 });
  return json(socialAssetClientDTO(await socialAssetAction(await db(), id, input.action, input, session.user.id)));
} catch (error) { return errorResponse(error); } }
