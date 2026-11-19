import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getMetaAccountAnalysis, metaAccountAnalysisAction } from '@/lib/business/social-account-analysis.mjs';
export const runtime = 'nodejs';
export async function GET(request, { params }) {
  try {
    const session = await authorize(request), { id } = await params;
    const search = new URL(request.url).searchParams, query = Object.fromEntries(search);
    const categories = search.getAll('content');
    if (categories.length > 1) query.content = categories;
    return json(await getMetaAccountAnalysis(await db(), id, query, session.user.id));
  } catch (error) { return errorResponse(error); }
}
export async function POST(request, { params }) {
  try {
    const session = await authorize(request, { write: true }), { id } = await params;
    const input = await jsonBody(request, { maxBytes: 2048 });
    return json(await metaAccountAnalysisAction(await db(), id, input, session.user.id), input.action === 'refresh' ? 202 : 200);
  } catch (error) { return errorResponse(error); }
}
