import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { authorize,db,errorResponse } from '@/lib/server.mjs';
import { SESSION_COOKIE,logout } from '@/lib/auth.mjs';
export const runtime='nodejs';
export async function POST(request){try{
 await authorize(request,{write:true});await logout(await db(),(await cookies()).get(SESSION_COOKIE)?.value);
 const result=NextResponse.json({ok:true});result.cookies.set(SESSION_COOKIE,'',{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'||process.env.COOKIE_SECURE==='true',path:'/',maxAge:0});return result;
}catch(e){return errorResponse(e);}}
