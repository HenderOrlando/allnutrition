/** @type {import('next').NextConfig} */
const config = {
  poweredByHeader: false,
  serverExternalPackages: ['pg'],
  outputFileTracingIncludes: { '/*': ['./db/sqlite.sql'] },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};
export default config;
