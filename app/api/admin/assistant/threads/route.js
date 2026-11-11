import { authorizeAssistant, db, json } from '@/lib/server.mjs';
import { listAssistantThreads } from '@/lib/assistant/conversations.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail, integer } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    const query = new URL(request.url).searchParams;
    if ([...query.keys()].some(key => key !== 'page') || query.getAll('page').length > 1) fail('Consulta no válida.', 422);
    const rawPage = query.get('page');
    if (rawPage !== null && !/^[1-9]\d*$/.test(rawPage)) fail('Página no válida.', 422);
    const page = rawPage === null ? 1 : integer(Number(rawPage), 'Página', 1, 100000);
    const result = await listAssistantThreads(await db(), session, { page });
    return json({
      threads: result.threads.map(thread => ({
        id: thread.id, version: thread.version, title: thread.data.title, topic: thread.data.topic,
        createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      })),
      page: result.page, hasMore: result.hasMore,
      pagination: { page: result.page, pageSize: 20, hasMore: result.hasMore },
    });
  } catch (error) { return assistantHTTPError(error); }
}
