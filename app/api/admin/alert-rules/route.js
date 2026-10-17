import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { listAlertRules, saveAlertRule } from '@/lib/business/alerts.mjs';
export const runtime='nodejs';
export async function GET(request) {try{
  await authorize(request);return json(await listAlertRules(await db()));
}catch(error){return errorResponse(error);}}
export async function PUT(request) {try{
  const user=await authorize(request,{write:true}),input=await jsonBody(request);
  const id=text(input?.id,'Regla',100,true);
  return json(await saveAlertRule(await db(),input,user.user.id,id));
}catch(error){return errorResponse(error);}}
