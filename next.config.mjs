/** @type {import('next').NextConfig} */
const config = {
  experimental: { agentUpgrade: 'security' },
  poweredByHeader: false,
  serverExternalPackages: ['pg', 'web-push'],
  outputFileTracingIncludes: { '/*': ['./db/*.sql'] },
  outputFileTracingExcludes: { '/*': ['./data/**/*', './.test-data/**/*', './desktop/**/*', './.env*'] },
  logging: {
    incomingRequests: { ignore: [/\/api\/admin\/(?:social|assistant)\/oauth\/callback(?:\?|$)/, /\/api\/social\/media\//] },
    browserToTerminal: false,
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }, { source: '/shipping-notifications-sw.js', headers: [
      { key: 'Service-Worker-Allowed', value: '/admin' },
      { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
    ] }];
  },
};
export default config;
