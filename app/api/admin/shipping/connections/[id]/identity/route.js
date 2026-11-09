import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { confirmShippingIdentity } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const session = await authorize(request, { write: true }), { id } = await params;
  return json(await confirmShippingIdentity(await db(), id, await jsonBody(request), session.user.id));
} catch (error) { return errorResponse(error); } }
