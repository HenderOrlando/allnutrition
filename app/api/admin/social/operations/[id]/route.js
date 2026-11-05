import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialOperation } from '@/lib/business/social.mjs';

export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request);
  return json(await getSocialOperation(await db(), (await params).id));
} catch (error) { return errorResponse(error); } }
