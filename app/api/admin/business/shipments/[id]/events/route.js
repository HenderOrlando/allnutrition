import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { recordShipmentEvent } from '@/lib/business/shipments.mjs';
export const runtime='nodejs';
export async function POST(request,{params}) { try {
  const user=await authorize(request,{write:true}),{id}=await params;
  return json(await recordShipmentEvent(await db(),id,await jsonBody(request),user.user.id),201);
} catch(error){return errorResponse(error);} }
