import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { authorize,db,errorResponse } from '@/lib/server.mjs';
import { SESSION_COOKIE,logout } from '@/lib/auth.mjs';
import { SHIPPING_PUSH_COOKIE } from '@/lib/business/shipping-push-devices.mjs';
export const runtime='nodejs';
export async function POST(request){try{
 await authorize(request,{write:true});
 const cookieStore=await cookies(),device=cookieStore.get(SHIPPING_PUSH_COOKIE)?.value;
 await logout(await db(),cookieStore.get(SESSION_COOKIE)?.value,device);
 const result=NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});
 result.cookies.set(SESSION_COOKIE,'',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'||process.env.COOKIE_SECURE==='true',path:'/',maxAge:0});
 if(device)result.cookies.set(SHIPPING_PUSH_COOKIE,'',{httpOnly:true,sameSite:'strict',secure:true,path:'/',maxAge:0});
 return result;
}catch(e){return errorResponse(e);}}
