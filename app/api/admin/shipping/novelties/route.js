import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { listShippingNovelties, markShippingNoveltyRead } from '@/lib/business/shipping-novelties.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const {user} = await authorizeSession(request);
    const params = new URL(request.url).searchParams;
    return json(await listShippingNovelties(await db(),user.id,{
      summary:params.get('summary')==='1',page:Number(params.get('page') ?? 1),state:params.get('state') ?? '',
      eventId:params.get('eventId')??undefined,
    }));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    const {user} = await authorizeSession(request,{write:true});
    const input = await jsonBody(request,{maxBytes:1024});
    return json(await markShippingNoveltyRead(await db(),user.id,input));
  } catch (error) { return errorResponse(error); }
}
