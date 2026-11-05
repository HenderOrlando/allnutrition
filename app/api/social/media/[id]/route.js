import { db, errorResponse } from '@/lib/server.mjs';
import { getSocialAsset, openSocialAssetContent } from '@/lib/business/social-media.mjs';
import { verifySocialMediaUrl, socialMediaResponse } from '@/lib/social/media-http.mjs';
export const runtime = 'nodejs';
const notFound = () => new Response(null, { status: 404, headers: { 'Cache-Control': 'private,no-store', 'X-Content-Type-Options': 'nosniff' } });
async function derivative(request, { params }) { try {
  const { id } = await params, store = await db(), asset = await getSocialAsset(store, id);
  if (!verifySocialMediaUrl(asset, request.url)) return notFound();
  return await socialMediaResponse(await openSocialAssetContent(store, id, { variant: 'derivative' }), request);
} catch (error) {
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 || error.code === 'ENOENT') return notFound();
  return errorResponse(error);
} }
export const GET = derivative;
export const HEAD = derivative;
