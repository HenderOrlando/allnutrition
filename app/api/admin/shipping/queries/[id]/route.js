import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getShippingQuery } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) { try {
  await authorize(request);
  const { id } = await params;
  return json(await getShippingQuery(await db(), id));
} catch (error) { return errorResponse(error); } }
