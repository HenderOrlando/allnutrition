import { fail } from '../validation-core.mjs';

// An approved revision owns the method. Availability never selects another path.
// transport optionally injects fetchImpl or a signed browser client for isolated scenarios.
export async function createSocialConnector({ connection, credentials, runtime, transport = {} }) {
  if (!connection || !['api', 'browser'].includes(connection.integrationMethod)) fail('Conexión social no válida.');
  if (!credentials) fail('La conexión requiere autenticación.', 409);
  if (!runtime) fail('Falta la configuración social de ejecución.', 409);
  if (connection.integrationMethod === 'api') {
    const { createMetaApiConnector } = await import('./meta.mjs');
    return createMetaApiConnector({ connection, credentials, runtime, transport });
  }
  const { createMetaBrowserConnector } = await import('./meta-browser.mjs');
  let client = transport.browserClient;
  if (!client) {
    const { createBrowserClient } = await import('./browser-client.mjs');
    client = createBrowserClient({ baseUrl: runtime.browserUrl, controlKey: runtime.keys?.control, runtime, fetchImpl: transport.fetchImpl });
  }
  return createMetaBrowserConnector({ client, connection, credentials });
}
