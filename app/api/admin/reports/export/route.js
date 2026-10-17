import { authorize, db, attachment, errorResponse } from '@/lib/server.mjs';
import { text } from '@/lib/validation-core.mjs';
import { buildBusinessReport, getReportSnapshot } from '@/lib/business/reports.mjs';
import { exportBusinessReport, reportRequestQuery } from '@/lib/business/report-export.mjs';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    await authorize(request);
    const params = new URL(request.url).searchParams, store = await db();
    const snapshot = params.get('snapshot');
    const report = snapshot ? await getReportSnapshot(store,text(snapshot,'Informe guardado',100,true)) : await buildBusinessReport(store,reportRequestQuery(params));
    const filename = `informe-${report.query.period}-${report.bounds.startDate}${report.snapshot ? `-r${report.snapshot.revision}` : ''}.xlsx`;
    return attachment(exportBusinessReport(report),filename,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } catch (error) { return errorResponse(error); }
}
