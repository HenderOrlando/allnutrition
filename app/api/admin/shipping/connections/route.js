import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { listShippingConnections, createShippingConnection } from '@/lib/business/shipping-bridge.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  return json(await listShippingConnections(await db()));
} catch (error) { return errorResponse(error); } }
export async function POST(request) { try {
  const session = await authorize(request, { write: true });
  return json(await createShippingConnection(await db(), await jsonBody(request), session.user.id), 201);
} catch (error) { return errorResponse(error); } }
