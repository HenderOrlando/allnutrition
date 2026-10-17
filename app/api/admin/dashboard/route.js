import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { buildDashboard } from '@/lib/business/dashboard.mjs';
export const runtime='nodejs';
export async function GET(request) {
  try {
    await authorize(request);
    const params=new URL(request.url).searchParams;
    return json(await buildDashboard(await db(),{period:params.get('period')||undefined,anchor:params.get('anchor')||undefined,
      issue:params.get('issue')||undefined,status:params.get('status')||undefined,page:params.get('page')||undefined}));
  } catch(error) { return errorResponse(error); }
}
