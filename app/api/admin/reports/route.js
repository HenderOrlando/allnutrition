import { authorize, db, json, jsonBody, errorResponse } from '@/lib/server.mjs';
import { fail, integer } from '@/lib/validation-core.mjs';
import { listReportSnapshots, saveReportSnapshot } from '@/lib/business/reports.mjs';
import { liveReportClientData, reportRequestQuery } from '@/lib/business/report-export.mjs';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    await authorize(request);
    const params = new URL(request.url).searchParams, mode = params.get('mode') || 'live';
    const query = reportRequestQuery(params), page = integer(Number(params.get('page') || 1),'Página',1,100000);
    const store = await db();
    if (mode === 'saved') return json(await listReportSnapshots(store,{...query,page}));
    if (mode !== 'live') fail('Vista de informes no válida.');
    return json(await liveReportClientData(store,query,{page,metric:params.get('metric'),issue:params.get('issue')}));
  } catch (error) { return errorResponse(error); }
}

export async function POST(request) {
  try {
    const user = await authorize(request,{write:true});
    const input = await jsonBody(request);
    return json(await saveReportSnapshot(await db(),input,user.user.id),202);
  } catch (error) { return errorResponse(error); }
}
