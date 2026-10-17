import { authorize,db,json,bodyBytes,errorResponse } from '@/lib/server.mjs';
import { getImportBatch,updateImportBatch } from '@/lib/business/imports.mjs';
import { AppError,fail } from '@/lib/validation-core.mjs';
export const runtime='nodejs';
export async function GET(request,{params}){try{
  await authorize(request);const {id}=await params,filters=Object.fromEntries(new URL(request.url).searchParams);filters.page=Number(filters.page||1);
  return json(await getImportBatch(await db(),id,filters));
}catch(error){return errorResponse(error);}}
export async function PUT(request,{params}){try{
  const user=await authorize(request,{write:true}),{id}=await params;
  if(!(request.headers.get('content-type')||'').includes('application/json'))fail('Usa contenido JSON.',415);
  let input;try{input=JSON.parse((await bodyBytes(request,1048576)).toString('utf8'));}catch(error){if(error instanceof AppError)throw error;fail('JSON no válido.');}
  return json(await updateImportBatch(await db(),id,input,user.user.id));
}catch(error){return errorResponse(error);}}
