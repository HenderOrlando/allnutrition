import { authorize, authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { getHekaWebhookSettings, saveHekaWebhookSettings } from '@/lib/business/heka-api.mjs';

export const runtime='nodejs';

export async function GET(request) {
  try {
    await authorize(request);
    return json(await getHekaWebhookSettings(await db()));
  } catch(error) {return errorResponse(error);}
}

async function write(request,clear) {
  try {
    const session=await authorizeSession(request,{write:true});
    return json(await saveHekaWebhookSettings(await db(),await jsonBody(request,{maxBytes:1024}),session,{clear}));
  } catch(error) {return errorResponse(error);}
}

export async function PUT(request) {return write(request,false);}
export async function DELETE(request) {return write(request,true);}
