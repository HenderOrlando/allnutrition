import { db } from '@/lib/server.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
 try { const store=await db(); await store.db.get('SELECT 1 AS ok');return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}}); }
 catch {return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});}
}
