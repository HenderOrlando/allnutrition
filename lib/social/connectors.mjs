import { fail } from '../validation-core.mjs';
import { socialConfig, secretKey } from './config.mjs';

// An approved revision owns the method. Availability never selects another path.
// transport optionally injects fetchImpl or a signed browser client for isolated scenarios.
export async function createSocialConnector({ connection, credentials, transport = {} }) {
  if (!connection || !['api', 'browser'].includes(connection.integrationMethod)) fail('Conexión social no válida.');
  if (!credentials) fail('La conexión requiere autenticación.', 409);
  if (connection.integrationMethod === 'api') {
    const { createMetaApiConnector } = await import('./meta.mjs');
    return createMetaApiConnector({ connection, credentials, transport });
  }
  const { createMetaBrowserConnector } = await import('./meta-browser.mjs');
  let client = transport.browserClient;
  if (!client) {
    const { createBrowserClient } = await import('./browser-client.mjs');
    client = createBrowserClient({ baseUrl: socialConfig().browserUrl, controlKey: secretKey('SOCIAL_BROWSER_CONTROL_KEY'), fetchImpl: transport.fetchImpl });
  }
  return createMetaBrowserConnector({ client, connection, credentials });
}
