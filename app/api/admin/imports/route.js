import { authorize,db,json,jsonBody,errorResponse } from '@/lib/server.mjs';
import { createImportBatch,listImportBatches } from '@/lib/business/imports.mjs';
export const runtime='nodejs';
export async function GET(request){try{
  await authorize(request);const filters=Object.fromEntries(new URL(request.url).searchParams);filters.page=Number(filters.page||1);
  return json(await listImportBatches(await db(),filters));
}catch(error){return errorResponse(error);}}
export async function POST(request){try{
  const user=await authorize(request,{write:true});return json(await createImportBatch(await db(),await jsonBody(request),user.user.id),201);
}catch(error){return errorResponse(error);}}
