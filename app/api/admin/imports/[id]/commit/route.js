import { authorize,db,json,jsonBody,errorResponse } from '@/lib/server.mjs';
import { commitImport } from '@/lib/business/imports.mjs';
export const runtime='nodejs';
export async function POST(request,{params}){try{
  const user=await authorize(request,{write:true}),{id}=await params;
  return json(await commitImport(await db(),id,await jsonBody(request),user.user.id),202);
}catch(error){return errorResponse(error);}}
