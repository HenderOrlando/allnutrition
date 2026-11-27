import { bodyBytes, db, errorResponse, json } from '@/lib/server.mjs';
import { authenticateHekaWebhook, enqueueHekaWebhook, HEKA_WEBHOOK_MAX_BYTES } from '@/lib/business/heka-webhook.mjs';
import { readHekaWebhookCredential } from '@/lib/business/heka-api.mjs';

export const runtime = 'nodejs';

export async function POST(request,{params}) {
  const {environment}=await params;
  if(environment!=='test'&&environment!=='production')return json({error:'Webhook Heka no habilitado.'},404);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return json({error:'Usa contenido JSON.'},415);
  try {
    const store=await db(), credential=await readHekaWebhookCredential(store,environment);
    if(!credential)return json({error:'Webhook Heka no habilitado.'},404);
    const event=authenticateHekaWebhook(request.headers,await bodyBytes(request,HEKA_WEBHOOK_MAX_BYTES),credential.secret);
    if(event.event!=='webhook.test')await enqueueHekaWebhook(store,credential,event);
    return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
  } catch(error) {return errorResponse(error);}
}
