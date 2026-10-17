import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getShipment, saveShipment } from '@/lib/business/shipments.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime='nodejs';
export async function GET(request,{params}) { try {
  await authorize(request);const {id}=await params,record=await getShipment(await db(),id);
  if(!record)fail('Envío no encontrado.',404);return json(record);
} catch(error){return errorResponse(error);} }
export async function PUT(request,{params}) { try {
  const user=await authorize(request,{write:true}),{id}=await params;
  return json(await saveShipment(await db(),await jsonBody(request),user.user.id,id));
} catch(error){return errorResponse(error);} }
