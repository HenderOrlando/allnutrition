import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { financeQuery } from '@/lib/business/finance.mjs';
export const runtime='nodejs';
export async function GET(request,{params}) {try{
  await authorize(request);const {resource}=await params;
  return json(await financeQuery(await db(),resource,Object.fromEntries(new URL(request.url).searchParams)));
}catch(error){return errorResponse(error);}}
