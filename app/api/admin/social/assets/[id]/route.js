import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialAsset, socialAssetClientDTO } from '@/lib/business/social-media.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request);
  return json(socialAssetClientDTO(await getSocialAsset(await db(), (await params).id)));
} catch (error) { return errorResponse(error); } }
