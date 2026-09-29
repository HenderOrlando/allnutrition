import { NextResponse } from 'next/server';
import { db,jsonBody,errorResponse,checkOrigin } from '@/lib/server.mjs';
import { login,SESSION_COOKIE,assertOrigin } from '@/lib/auth.mjs';
export const runtime='nodejs';
export async function POST(request){try{
 checkOrigin(request);
 const data=await jsonBody(request),s=await login(await db(),data?.email,data?.password);
 const result=NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});
 result.cookies.set(SESSION_COOKIE,s.token,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production'||process.env.COOKIE_SECURE==='true',path:'/',expires:new Date(s.expires)});return result;
}catch(e){return errorResponse(e);}}
