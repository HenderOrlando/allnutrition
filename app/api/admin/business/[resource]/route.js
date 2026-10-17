import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getBusinessSettings, saveBusinessSettings, listResources, saveResource } from '@/lib/business/settings.mjs';
import { saveAccount } from '@/lib/business/finance.mjs';
import { schedulerHealth } from '@/lib/business/job-leases.mjs';
export const runtime='nodejs';
export async function GET(request,{params}) { try {
  await authorize(request); const {resource}=await params,store=await db();
  if(resource==='settings')return json(await store.readSnapshot(async tx=>({...await getBusinessSettings(tx),automation:schedulerHealth(await tx.db.get(`SELECT state,updated_at,error_code FROM ${tx.t('job_runs')} WHERE key='scheduler:heartbeat'`))})));
  const query=Object.fromEntries(new URL(request.url).searchParams);
  return json({records:await listResources(store,resource,query)});
} catch(error){return errorResponse(error);} }
export async function POST(request,{params}) { try {
  const user=await authorize(request,{write:true}),{resource}=await params,input=await jsonBody(request);
  return json(await (resource==='accounts'?saveAccount(await db(),input,user.user.id):saveResource(await db(),resource,input,user.user.id)),201);
} catch(error){return errorResponse(error);} }
export async function PUT(request,{params}) { try {
  const user=await authorize(request,{write:true}),{resource}=await params;
  if(resource!=='settings')return json({error:'Registro no encontrado.'},404);
  return json(await saveBusinessSettings(await db(),await jsonBody(request),user.user.id));
} catch(error){return errorResponse(error);} }
