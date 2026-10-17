import { authorize,db,attachment,errorResponse } from '@/lib/server.mjs';
import { exportImportErrors } from '@/lib/business/imports.mjs';
export const runtime='nodejs';
export async function GET(request,{params}){try{
  await authorize(request);const {id}=await params;return attachment(await exportImportErrors(await db(),id),'filas-rechazadas.xlsx');
}catch(error){return errorResponse(error);}}
