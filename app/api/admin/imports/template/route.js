import { authorize, attachment, errorResponse } from '@/lib/server.mjs';
import { writeImportTemplate } from '@/lib/business/import-templates.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    await authorize(request);
    return attachment(writeImportTemplate(), 'plantilla-negocio.xlsx');
  } catch (error) { return errorResponse(error); }
}
