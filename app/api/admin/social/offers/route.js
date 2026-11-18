import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialOffer, listSocialOffers } from '@/lib/business/social-offers.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const query = new URL(request.url).searchParams;
  const allowed = query.has('id') ? ['kind', 'id'] : ['query', 'kind', 'offset', 'limit'];
  if ([...query.keys()].some(key => !allowed.includes(key)) || allowed.some(key => query.getAll(key).length > 1) || query.has('id') && !query.has('kind')) fail('Filtro de ofertas no válido.');
  const store = await db();
  return json(await store.readSnapshot(async tx => query.has('id') ? { offer: await getSocialOffer(tx, query.get('kind'), query.get('id')) } : listSocialOffers(tx, Object.fromEntries(query))));
} catch (error) { return errorResponse(error); } }
