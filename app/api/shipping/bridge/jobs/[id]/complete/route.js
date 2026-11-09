import { db, json, errorResponse } from '@/lib/server.mjs';
import { readBridgeRequest } from '@/lib/shipping/server.mjs';
import { completeShippingQuery } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function POST(request, { params }) { try {
  const { input, auth } = await readBridgeRequest(request, { maxBytes: 10 * 1024 * 1024 });
  const { id } = await params;
  return json(await completeShippingQuery(await db(), id, input, auth));
} catch (error) { return errorResponse(error); } }
