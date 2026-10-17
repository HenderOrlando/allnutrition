import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getAlert, updateAlert } from '@/lib/business/alerts.mjs';
export const runtime='nodejs';
export async function GET(request,{params}) {try{
  await authorize(request);const {id}=await params;
  return json(await getAlert(await db(),id));
}catch(error){return errorResponse(error);}}
export async function PUT(request,{params}) {try{
  const user=await authorize(request,{write:true}),{id}=await params;
  return json(await updateAlert(await db(),await jsonBody(request),user.user.id,id));
}catch(error){return errorResponse(error);}}
