import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getSocialResults } from '@/lib/business/social-metrics.mjs';
import { getSocialAnalysis } from '@/lib/business/social-analysis.mjs';
import { getSocialBusinessResult } from '@/lib/business/social-links.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';
export async function GET(request) { try {
  await authorize(request);
  const params = new URL(request.url).searchParams;
  const keys = ['campaignId', 'deliveryId', 'integrationMethod', 'scope', 'dimension', 'asOf', 'page', 'from', 'to'];
  if ([...params.keys()].some(key => !keys.includes(key)) || keys.some(key => params.getAll(key).length > 1)) fail('Filtro de resultados no válido.');
  const store = await db(), metrics = await getSocialResults(store, Object.fromEntries(params));
  const campaignId = params.get('campaignId');
  if (!campaignId) return json({ ...metrics, analysis: null, business: null });
  const [analysis, business] = await Promise.all([
    getSocialAnalysis(store, campaignId, { asOf: metrics.asOf }),
    getSocialBusinessResult(store, campaignId, { asOf: metrics.asOf })
  ]);
  const commercialStale = analysis.commercialStale || analysis.businessRevision != null && analysis.businessRevision !== business.businessRevision;
  return json({ ...metrics, analysis: commercialStale ? { ...analysis, commercialStale: true, stale: true, status: 'stale' } : analysis, business });
} catch (error) { return errorResponse(error); } }
