import { authorizeAssistant, json } from '@/lib/server.mjs';
import { adminAreas } from '@/lib/admin-view.mjs';
import { searchAssistantCapabilities } from '@/lib/assistant/capabilities.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

const areas = new Set(adminAreas.map(({ id }) => id));

export async function GET(request) {
  try {
    await authorizeAssistant(request);
    const params = new URL(request.url).searchParams;
    const query = params.get('query');
    const area = params.get('area');
    const rawPage = params.get('page');
    const page = rawPage === null ? 1 : Number(rawPage);
    if (params.size !== Number(query !== null) + Number(area !== null) + Number(rawPage !== null)
      || query !== null && (query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query))
      || area !== null && !areas.has(area)
      || rawPage !== null && (!/^[1-9]\d{0,5}$/u.test(rawPage) || page > 100000)) {
      fail('Consulta del directorio no válida.', 422);
    }
    const response = json(searchAssistantCapabilities(query ?? '', { area, page }));
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) { return assistantHTTPError(error); }
}
