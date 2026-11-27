import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { getShippingPreparationContext, listShippingPreparations, saveShippingPreparation } from '@/lib/business/shipping-preparations.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    await authorizeSession(request);
    const params = new URL(request.url).searchParams;
    const store = await db();
    if (params.has('orderId') || params.has('shipmentId')) return json(await getShippingPreparationContext(store,{
      orderId:params.get('orderId'),shipmentId:params.get('shipmentId'),
    }));
    return json(await listShippingPreparations(store,{page:Number(params.get('page') ?? 1),orderId:params.get('linkedOrderId')}));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    const {user} = await authorizeSession(request,{write:true});
    const input = await jsonBody(request,{maxBytes:65536});
    return json(await saveShippingPreparation(await db(),input,user.id));
  } catch (error) { return errorResponse(error); }
}
