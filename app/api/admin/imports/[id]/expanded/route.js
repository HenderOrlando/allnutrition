import { authorize, db, attachment, errorResponse } from '@/lib/server.mjs';
import { downloadImportOriginal } from '@/lib/business/imports.mjs';
import { expandExcelWorkbook } from '@/lib/business/excel.mjs';

export const runtime = 'nodejs';

export async function GET(request, { params }) {
  try {
    await authorize(request);
    const { id } = await params;
    const file = await downloadImportOriginal(await db(), id);
    const bytes = await expandExcelWorkbook(file.bytes, { filename: file.filename });
    return attachment(bytes, `${file.filename.replace(/\.[^.]+$/, '')} - con operacion.xlsx`);
  } catch (error) { return errorResponse(error); }
}
