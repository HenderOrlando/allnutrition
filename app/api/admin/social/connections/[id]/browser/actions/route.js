import { authorize, db, errorResponse, json, jsonBody } from '@/lib/server.mjs';
import { socialBrowserAction } from '@/lib/business/social-browser.mjs';

export const runtime = 'nodejs';
export async function POST(request, { params }) {
  try {
    const session = await authorize(request, { write: true }), { id } = await params;
    const input = await jsonBody(request, { maxBytes: 4096 });
    const result = await socialBrowserAction(await db(), id, input?.action, input, session);
    if (Buffer.isBuffer(result)) return new Response(result, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    return json(result);
  } catch (error) { return errorResponse(error); }
}
