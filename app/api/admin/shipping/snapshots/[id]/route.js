import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getShippingSnapshot } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request);
  const { id } = await params;
  return json(await getShippingSnapshot(await db(), id));
} catch (error) { return errorResponse(error); } }
