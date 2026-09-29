import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request, { params }) { try {
  await authorize(request); const { kind } = await params, store = await db();
  if (kind === 'orders') {
    const url = new URL(request.url), page = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
    return json(await store.pageOrders({ page, q: (url.searchParams.get('q') || '').slice(0, 100), status: url.searchParams.get('status') || '', paymentStatus: url.searchParams.get('paymentStatus') || '' }));
  }
  return json({ records: await store.list(kind) });
} catch (error) { return errorResponse(error); } }
export async function POST(request, { params }) { try {
  const user = await authorize(request, { write: true }), { kind } = await params, data = await jsonBody(request), store = await db();
  return json(await (kind === 'orders' ? store.saveOrder(data, user.user.id) : store.save(kind, data)), 201);
} catch (error) { return errorResponse(error); } }
