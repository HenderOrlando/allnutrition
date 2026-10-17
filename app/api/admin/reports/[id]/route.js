import { authorize, db, json, errorResponse } from '@/lib/server.mjs';
import { getReportSnapshot } from '@/lib/business/reports.mjs';
import { reportClientData } from '@/lib/business/report-export.mjs';
export const runtime = 'nodejs';

export async function GET(request,{params}) {
  try {
    await authorize(request);
    const {id} = await params, search = new URL(request.url).searchParams;
    return json(reportClientData(await getReportSnapshot(await db(),id),{page:search.get('page') || 1,metric:search.get('metric'),issue:search.get('issue')}));
  } catch (error) { return errorResponse(error); }
}
