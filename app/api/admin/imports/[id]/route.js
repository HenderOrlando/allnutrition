import { authorize,db,json,jsonBody,errorResponse } from '@/lib/server.mjs';
import { getImportBatch,updateImportBatch } from '@/lib/business/imports.mjs';
export const runtime='nodejs';
export async function GET(request,{params}){try{
  await authorize(request);const {id}=await params,filters=Object.fromEntries(new URL(request.url).searchParams);filters.page=Number(filters.page||1);
  return json(await getImportBatch(await db(),id,filters));
}catch(error){return errorResponse(error);}}
export async function PUT(request,{params}){try{
  const user=await authorize(request,{write:true}),{id}=await params;
  const input=await jsonBody(request,{maxBytes:2*1024*1024});
  return json(await updateImportBatch(await db(),id,input,user.user.id));
}catch(error){return errorResponse(error);}}
