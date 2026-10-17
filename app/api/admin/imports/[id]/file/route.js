import { authorize,db,json,bodyBytes,errorResponse,attachment } from '@/lib/server.mjs';
import { uploadImportFile,downloadImportOriginal } from '@/lib/business/imports.mjs';
import { fail } from '@/lib/validation-core.mjs';
export const runtime='nodejs';
export async function PUT(request,{params}){try{
  const user=await authorize(request,{write:true}),{id}=await params;
  let filename;try{filename=decodeURIComponent(request.headers.get('x-filename')||'');}catch{fail('Nombre de archivo no válido.');}
  const bytes=await bodyBytes(request,10*1024*1024,'El archivo supera 10 MiB.');
  return json(await uploadImportFile(await db(),id,{filename,bytes,version:Number(request.headers.get('x-batch-version')),requestId:request.headers.get('x-request-id')},user.user.id),202);
}catch(error){return errorResponse(error);}}
export async function GET(request,{params}){try{
  await authorize(request);const {id}=await params,file=await downloadImportOriginal(await db(),id);
  return attachment(file.bytes,file.filename,file.contentType||'application/octet-stream');
}catch(error){return errorResponse(error);}}
