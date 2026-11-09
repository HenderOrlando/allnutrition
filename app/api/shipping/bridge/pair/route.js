import { db, json, errorResponse } from '@/lib/server.mjs';
import { readBridgeRequest } from '@/lib/shipping/server.mjs';
import { pairShippingBridge } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function POST(request) { try {
  const { input } = await readBridgeRequest(request, { paired: false });
  return json(await pairShippingBridge(await db(), input));
} catch (error) { return errorResponse(error); } }
