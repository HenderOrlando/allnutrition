import { authorizeAssistant, db, json } from '@/lib/server.mjs';
import { listAssistantThreads } from '@/lib/assistant/conversations.mjs';
import { assistantHTTPError } from '@/lib/assistant/proposal-http.mjs';
import { fail, integer } from '@/lib/validation-core.mjs';

export const runtime = 'nodejs';

export async function GET(request) {
  try {
    const session = await authorizeAssistant(request);
    const query = new URL(request.url).searchParams;
    for (const key of query.keys()) {
      if (!['page', 'q', 'archived'].includes(key) || query.getAll(key).length > 1) fail('Consulta no válida.', 422);
    }
    const rawPage = query.get('page');
    if (rawPage !== null && !/^[1-9]\d*$/.test(rawPage)) fail('Página no válida.', 422);
    const page = rawPage === null ? 1 : integer(Number(rawPage), 'Página', 1, 100000);
    const archived = query.get('archived');
    if (archived !== null && archived !== '1') fail('Archivo de conversación inválido.', 422);
    const result = await listAssistantThreads(await db(), session, { page, q: query.get('q') ?? '', archived: archived === '1' });
    return json({
      threads: result.threads.map(thread => ({
        id: thread.id, version: thread.version, title: thread.data.title, topic: thread.data.topic, archived: thread.archived,
        createdAt: thread.createdAt, updatedAt: thread.updatedAt,
      })),
      page: result.page, hasMore: result.hasMore,
      pagination: { page: result.page, pageSize: 20, hasMore: result.hasMore },
    });
  } catch (error) { return assistantHTTPError(error); }
}
