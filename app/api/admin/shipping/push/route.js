import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { authorizeSession, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { changeShippingPushDevice, getShippingPushStatus } from '@/lib/business/shipping-push.mjs';
import { SHIPPING_PUSH_COOKIE } from '@/lib/business/shipping-push-devices.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorizeSession(request);
    const device = (await cookies()).get(SHIPPING_PUSH_COOKIE)?.value;
    return json(await getShippingPushStatus(await db(), session.user.id, device));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    const session = await authorizeSession(request, { write:true });
    const input = await jsonBody(request, { maxBytes:4096 });
    const device = (await cookies()).get(SHIPPING_PUSH_COOKIE)?.value;
    const result = await changeShippingPushDevice(await db(), input, session, device, { origin:request.headers.get('origin') });
    if (result.device === undefined) return json(result.data);
    const response = NextResponse.json(result.data, { headers:{ 'Cache-Control':'no-store' } });
    response.cookies.set(SHIPPING_PUSH_COOKIE, result.device ?? '', {
      httpOnly:true, secure:true, sameSite:'strict', path:'/', maxAge:result.device ? 60*60*24*400 : 0,
    });
    return response;
  } catch (error) { return errorResponse(error); }
}
