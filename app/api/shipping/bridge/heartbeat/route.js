import { db, json, errorResponse } from '@/lib/server.mjs';
import { readBridgeRequest } from '@/lib/shipping/server.mjs';
import { heartbeatShippingQuery } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function POST(request) { try {
  const { input, auth } = await readBridgeRequest(request);
  return json(await heartbeatShippingQuery(await db(), input, auth));
} catch (error) { return errorResponse(error); } }
