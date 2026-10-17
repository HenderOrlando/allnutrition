import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { pageShipments, createShipment } from '@/lib/business/shipments.mjs';
export const runtime='nodejs';
export async function GET(request) { try {
  await authorize(request);const query=Object.fromEntries(new URL(request.url).searchParams);query.page=Number(query.page||1);
  return json(await pageShipments(await db(),query));
} catch(error){return errorResponse(error);} }
export async function POST(request) { try {
  const user=await authorize(request,{write:true});return json(await createShipment(await db(),await jsonBody(request),user.user.id),201);
} catch(error){return errorResponse(error);} }
