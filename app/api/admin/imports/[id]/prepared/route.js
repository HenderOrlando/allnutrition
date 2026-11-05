import { authorize, db, attachment, errorResponse } from '@/lib/server.mjs';
import { getImportPrepared } from '@/lib/business/imports.mjs';
import { writePreparedImportWorkbook } from '@/lib/business/import-templates.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    await authorize(request);
    const { id } = await params;
    const prepared = await getImportPrepared(await db(), id);
    return attachment(writePreparedImportWorkbook(prepared.data), prepared.filename);
  } catch (error) { return errorResponse(error); }
}
