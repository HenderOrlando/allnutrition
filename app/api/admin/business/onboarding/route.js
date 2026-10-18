import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { getOnboarding, runOnboardingAction } from '@/lib/business/onboarding.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorize(request);
    return json(await getOnboarding(await db(), session.user));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    const session = await authorize(request, { write: true });
    return json(await runOnboardingAction(await db(), await jsonBody(request), session.user));
  } catch (error) { return errorResponse(error); }
}
