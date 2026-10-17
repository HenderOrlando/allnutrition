import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { pageAlerts, updateAlert } from '@/lib/business/alerts.mjs';
export const runtime='nodejs';
export async function GET(request) {try{
  await authorize(request);
  return json(await pageAlerts(await db(),Object.fromEntries(new URL(request.url).searchParams)));
}catch(error){return errorResponse(error);}}
export async function PUT(request) {try{
  const user=await authorize(request,{write:true}),input=await jsonBody(request);
  const id=text(input?.id,'Alerta',100,true);
  return json(await updateAlert(await db(),input,user.user.id,id));
}catch(error){return errorResponse(error);}}
