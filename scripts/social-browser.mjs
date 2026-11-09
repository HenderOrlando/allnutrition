import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { createBrowserRuntime } from '../lib/social/browser-runtime.mjs';
import { socialConfig } from '../lib/social/config.mjs';
import { createIntegrationKeyring } from '../lib/integrations/keyring.mjs';

let runtime, server, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime?.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
try {
  if (process.argv.length !== 2) throw new Error('INVALID_ARGUMENTS');
  const config = socialConfig();
  runtime = await createBrowserRuntime({ chromium, keyring: createIntegrationKeyring(), mediaRoot: config.mediaRoot, maxContexts: config.browserMaxContexts });
  server = createServer(runtime.handle);
  server.requestTimeout = 310000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 24;
  server.listen(3320, '0.0.0.0', () => console.log('SOCIAL_BROWSER_READY'));
  server.on('error', () => { console.error('SOCIAL_BROWSER_UNAVAILABLE'); void stop(); process.exitCode = 1; });
  process.once('SIGTERM', () => { void stop(); });
  process.once('SIGINT', () => { void stop(); });
} catch {
  console.error('SOCIAL_BROWSER_UNAVAILABLE');
  await stop();
  process.exitCode = 1;
}
