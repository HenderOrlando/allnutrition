import { authorize, db, errorResponse, json } from '@/lib/server.mjs';
import { getSavedMetaCampaigns } from '@/lib/business/social-meta-campaigns.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorize(request);
    return json(await getSavedMetaCampaigns(await db(), new URL(request.url).searchParams, session.user.id));
  } catch (error) { return errorResponse(error); }
}
