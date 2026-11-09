import { db, json, errorResponse } from '@/lib/server.mjs';
import { readBridgeRequest } from '@/lib/shipping/server.mjs';
import { failShippingQuery } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const { input, auth } = await readBridgeRequest(request);
  const { id } = await params;
  return json(await failShippingQuery(await db(), id, input, auth));
} catch (error) { return errorResponse(error); } }
