// Deployment units and the non-import edges in the candidate's test graph.
export const units = ['web', 'scheduler', 'social-browser-worker', 'social-browser', 'db'];
export const pgGroups = ['core', 'business', 'imports', 'backup', 'heka', 'social', 'assistant', 'schema'];
export const browserDomains = ['privacy', 'storefront', 'orders', 'cash', 'reports', 'imports', 'business', 'media', 'security', 'heka', 'social', 'assistant'];
export const gateNames = ['harness', 'runtime', 'https', 'postgres', 'migration', 'restore', 'scheduler', 'runner', 'audit', 'compose', 'infra', 'desktop'];
export const configFiles = ['compose.yaml', 'compose.nginx.yaml', 'compose.production.yaml', 'compose.staging.yaml', 'deploy/Caddyfile.production', 'deploy/Caddyfile.staging', 'deploy/nginx/allnutrition-acme.conf', 'deploy/nginx/allnutrition.wintimeapp.co.conf', 'deploy/pg_hba.conf', 'deploy/postgres-entrypoint.sh', 'deploy/social-browser-seccomp.json'];
const advisorSpecs = [
  'advisor-account-learning-controls',
  'advisor-audience-controls',
  'advisor-campaign-form-controls',
  'advisor-creative-input-controls',
  'advisor-google-oauth-controls',
  'advisor-library-controls',
  'advisor-measurement-controls',
  'advisor-meta-connection-controls',
  'advisor-meta-inventory-controls',
  'advisor-onboarding-controls',
  'advisor-result-recommendations',
];
export const browserSpecs = ['advertising', 'app', 'assistant', 'integrations', 'security', 'workbook', ...advisorSpecs];
export const manualNode = ['tests/heka-browser.mjs'];
export const roots = {
  scheduler: ['scripts/business-jobs.mjs', 'scripts/migrate.mjs'],
  'social-browser-worker': ['scripts/business-jobs.mjs', 'scripts/migrate.mjs'],
  'social-browser': ['scripts/social-browser.mjs'],
};
export const isSource = path => /\.(?:[cm]?[jt]s|[jt]sx|css)$/.test(path);
export const isNodeTest = path => /^tests\/[^/]+\.test\.mjs$/.test(path) && !['tests/postgres.integration.test.mjs', 'tests/assistant-work-postgres.test.mjs', 'tests/release-impact.test.mjs'].includes(path);
export const isDocs = path => path.startsWith('docs/') || /^[^/]+\.md$/i.test(path);
export const isWebEntry = path => /^(app|components|public)\//.test(path) || /^(?:next\.config\.|jsconfig\.json$|tsconfig\.json$|proxy\.|instrumentation\.)/.test(path);
export const isHarness = path => /^(?:\.github\/|scripts\/(?:release-|production-|verify-docker|check\.|deploy-production|audit-|deployment-)|Dockerfile\.checks$|tests\/(?:native\/|docker\/|release-impact\.test\.mjs$)|playwright\.config\.|\.nvmrc$|\.gitignore$|deploy\/(?:systemd|audit)\/)/.test(path);
export const isInfra = path => /^(?:compose\.|deploy\/(?!(?:systemd|audit)\/))/.test(path);
export const isCorePersistence = path => /^(?:db\/(?:sqlite|supabase)\.sql|lib\/(?:store\.mjs|db\/(?:config|postgres|sqlite)\.mjs))$/.test(path);
export const isMigration = path => /^db\/.*\.sql$/.test(path);
export const isBrowserPair = path => /^(?:Dockerfile\.social-browser$|scripts\/social-browser\.mjs$|lib\/social\/(?:browser-|meta-ui)|deploy\/social-browser-seccomp\.json$)/.test(path);

export function domains(path) {
  const list = [];
  if (/privacy|social-data-deletion|deauthorize/.test(path)) list.push('privacy');
  if (/Storefront|app\/(?:\[section\]|page\.|robots\.)/.test(path)) list.push('storefront');
  if (/\b(?:Heka|ShippingIntegration|Shipments)|shipping|heka/.test(path)) list.push('heka');
  if (/Advertising|Social|Meta|advertising|(?:^|[/-])social(?:[/-]|\.mjs)|guided-image/.test(path)) list.push('social');
  if (/Assistant|assistant/.test(path)) list.push('assistant');
  if (/\b(?:Import|Workbook)|import|workbook/.test(path)) list.push('imports');
  if (/orders?|Order|shipment|Shipments/i.test(path) && !list.includes('imports')) list.push('orders');
  if (/cash|Cash|finance|Finance|settlements?|payroll|collections?/i.test(path)) list.push('cash');
  if (/reports?|Reports|Insights|dashboard|Dashboard/.test(path)) list.push('reports');
  if (/business|Business|AdminOverview|settings|inventory|catalog/i.test(path) && !list.length) list.push('business');
  if (/product-images|api\/media|api\/admin\/upload|\/media\.mjs/.test(path)) list.push('media');
  if (/^(app\/(?:layout|error|globals|not-found|admin\/layout)|components\/(?:Admin(?:\.|Navigation)|Login|UserManagement|WorkspaceTabs)|lib\/(?:auth|security|http|session)\b|next\.config\.|proxy\.)|api\/auth|api\/admin\/users/.test(path)) list.push('security');
  return list;
}

export const nodeOwners = {
  privacy: /(?:social-meta|social-oauth|auth-session)/,
  storefront: /(?:persistence|sqlite|validation|media|import-excel)/,
  heka: /(?:heka|shipping-bridge|business-shipments|integration-keyring|runtime-integrations-migration|backup-restore)/,
  social: /(?:social|advertising|backup-restore|integration-keyring)/,
  assistant: /assistant/,
  imports: /(?:import|workbook|onboarding)/,
  orders: /(?:order|shipment|catalog|collections|inventory)/,
  cash: /(?:cash|finance|payroll|collections|settlements)/,
  reports: /(?:report|insights|dashboard)/,
  business: /business|onboarding/,
  media: /(?:media|import-excel|persistence)/,
  security: /(?:auth|validation|security|persistence)/,
};
export const postgresByDomain = {
  heka: ['heka', 'backup'], social: ['social', 'backup'], assistant: ['assistant'], imports: ['imports'], orders: ['business'], cash: ['business'], reports: ['business'], business: ['business'], media: ['core', 'backup'], security: ['core'], storefront: ['core'],
};

// Domain-qualified browser tests are narrow; the verifier owns their fixed argv.
export const domainSpecs = {
  privacy: ['privacy'], storefront: ['app:storefront'], orders: ['app:orders'], cash: ['app:cash'], reports: ['app:reports'], imports: ['workbook'], business: ['app:business'], media: ['app:media', 'security:media'], security: browserSpecs,
  heka: ['integrations:heka'], social: ['integrations:social', 'advertising'], assistant: ['assistant', ...advisorSpecs],
};
