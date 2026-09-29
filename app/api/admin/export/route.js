import { authorize, db, errorResponse } from '@/lib/server.mjs';
export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request); const result = await (await db()).exportData();
  return new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="all-nutrition-export.json"', 'Cache-Control': 'no-store' } });
} catch (error) { return errorResponse(error); } }
