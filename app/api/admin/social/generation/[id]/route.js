import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialGeneration } from '@/lib/business/social-generation.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  const session = await authorize(request), { id } = await params;
  return json(await getSocialGeneration(await db(), id, session.user.id));
} catch (error) { return errorResponse(error); } }
