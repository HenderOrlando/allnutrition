import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getResource, saveResource } from '@/lib/business/settings.mjs';
import { fail } from '@/lib/validation-core.mjs';
import { saveAccount } from '@/lib/business/finance.mjs';
export const runtime='nodejs';
export async function GET(request,{params}) { try {
  await authorize(request);const {resource,id}=await params;const record=await getResource(await db(),resource,id);
  if(!record)fail('Registro no encontrado.',404);return json(record);
} catch(error){return errorResponse(error);} }
export async function PUT(request,{params}) { try {
  const user=await authorize(request,{write:true}),{resource,id}=await params;
  const input=await jsonBody(request),store=await db();
  return json(await (resource==='accounts'?saveAccount(store,input,user.user.id,id):saveResource(store,resource,input,user.user.id,id)));
} catch(error){return errorResponse(error);} }
