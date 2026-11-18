import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import {
  units, configFiles, gateNames, pgGroups, browserSpecs, isDocs, isHarness, isNodeTest, isInfra, isSource,
  isMigration, isCorePersistence, isWebEntry, isBrowserPair, roots, domains, nodeOwners, postgresByDomain, domainSpecs,
} from './release-impact-matrix.mjs';

export { configFiles, gateNames };
export const sha40 = /^[a-f0-9]{40}$/;
const imageIdPattern = /^sha256:[a-f0-9]{64}$/;
const none = '0'.repeat(40);
const sort = iterable => [...iterable].sort();
export const canonicalPlan = plan => `${JSON.stringify(plan, null, 2)}\n`;
export function imageTag(kind, imageId) {
  if (!['app', 'runner'].includes(kind) || !imageIdPattern.test(imageId)) throw Error('Identidad de imagen inválida');
  return `${kind === 'app' ? 'allnutrition' : 'allnutrition-social-browser'}:release-${imageId.slice(7, 19)}`;
}
export function requiredChecks(plan, mode = 'impact') {
  if (mode === 'full') return ['full:contracts', 'full:playwright', 'node:tests/heka-browser.mjs', ...['runtime', 'https', 'migration', 'restore', 'scheduler', 'runner', 'audit', 'compose'].map(g => `gate:${g}`)].sort();
  if (mode !== 'impact') throw Error('Modo de aceptación inválido');
  return sort(new Set([...plan.gates.map(g => `gate:${g}`), ...plan.node.map(file => `node:${file}`), ...plan.postgres.map(group => `pg:${group}`), ...plan.playwright.map(spec => spec === 'privacy' ? 'gate:https' : `playwright:${spec}`)]));
}

const maxBuffer = 96 * 1024 * 1024;
function command(bin, args, options) {
  const result = spawnSync(bin, args, { maxBuffer, ...options });
  if (result.error || result.status !== 0) throw Error(`${bin} ${args[0]} falló (${result.error?.code || result.signal || result.status})`);
  return result.stdout;
}
function gitAt(cwd) {
  return (args, options) => command('git', ['-C', cwd, ...args], { encoding: 'utf8', ...options });
}
function ancestor(cwd, parent, head) {
  return sha40.test(parent) && parent !== none && spawnSync('git', ['-C', cwd, 'merge-base', '--is-ancestor', parent, head], { stdio: 'ignore' }).status === 0;
}
function diff(git, base, head) {
  const parts = git(['diff', '--name-status', '-z', '--find-renames', base, head, '--']).split('\0');
  if (parts.pop() !== '') throw Error('Diff Git no delimitado');
  const paths = new Set();
  for (let i = 0; i < parts.length;) {
    const status = parts[i++];
    if (!/^(?:[ADMT]|[MR][0-9]{1,3})$/.test(status) || !parts[i]) throw Error('Estado de diff Git desconocido');
    paths.add(parts[i++]);
    if (status.startsWith('R')) {
      if (!parts[i]) throw Error('Renombre incompleto');
      paths.add(parts[i++]);
    }
  }
  return paths;
}
function tree(git, rev) {
  return new Map(git(['ls-tree', '-r', '-z', '--full-tree', rev]).split('\0').filter(Boolean).flatMap(entry => {
    const i = entry.indexOf('\t');
    const [, type, hash] = entry.slice(0, i).split(' ');
    return type === 'blob' ? [[entry.slice(i + 1), hash]] : [];
  }));
}
function migrationVersion(entries) {
  return Math.max(0, ...[...entries.keys()].map(path => Number(/^db\/[^/]*-v(\d+)\.(?:postgres|sqlite)\.sql$/.exec(path)?.[1] || 0)));
}
function readBlobs(git, hashes, cache) {
  const missing = sort(new Set(hashes.filter(hash => !cache.has(hash))));
  if (!missing.length) return;
  const result = git(['cat-file', '--batch'], { encoding: null, input: `${missing.join('\n')}\n` });
  let offset = 0;
  for (const hash of missing) {
    const newline = result.indexOf(10, offset);
    const [found, type, n] = result.toString('utf8', offset, newline).split(' ');
    const end = newline + 1 + Number(n);
    if (found !== hash || type !== 'blob' || result[end] !== 10) throw Error('Respuesta Git incompleta');
    cache.set(hash, result.toString('utf8', newline + 1, end));
    offset = end + 1;
  }
}
const graphPath = path => /^(?:app|components|lib|scripts|tests|desktop)\//.test(path) && isSource(path) || isWebEntry(path) && isSource(path);
function parsedReferences(ts, path, text) {
  if (path.endsWith('.css')) return [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?([^"'\s;)]+)/g)].map(match => match[1]);
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
  const refs = [];
  const visit = node => {
    const spec = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
      : ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require') ? node.arguments[0]
      : ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[1]?.kind === ts.SyntaxKind.PropertyAccessExpression ? node.arguments[0] : null;
    if (spec && ts.isStringLiteralLike(spec)) refs.push(spec.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return refs;
}
function graph(ts, git, entries, cache, parsed) {
  const sources = [...entries].filter(([path]) => graphPath(path));
  readBlobs(git, sources.map(([, blob]) => blob), cache);
  const reverse = new Map(), unresolved = new Map();
  const edge = (from, to) => {
    if (!entries.has(to)) return;
    if (!reverse.has(to)) reverse.set(to, new Set());
    reverse.get(to).add(from);
  };
  for (const [path, blob] of sources) {
    const parseKey = `${blob}:${posix.extname(path)}`;
    if (!parsed.has(parseKey)) parsed.set(parseKey, parsedReferences(ts, path, cache.get(blob)));
    for (const spec of parsed.get(parseKey)) {
      if (!/^(?:[.]|@\/|\/)/.test(spec) || spec.startsWith('//')) continue;
      const relative = spec.split(/[?#]/, 1)[0];
      const base = relative.startsWith('@/') ? relative.slice(2) : relative.startsWith('/') ? `public${relative}` : posix.normalize(posix.join(posix.dirname(path), relative));
      const target = ['', '.js', '.jsx', '.mjs', '.ts', '.tsx', '/index.js', '/index.mjs', '/index.ts'].map(ext => base + ext).find(name => entries.has(name));
      if (target) edge(path, target);
      else if (!relative.startsWith('/')) {
        if (!unresolved.has(path)) unresolved.set(path, new Set());
        unresolved.get(path).add(base);
      }
    }
  }
  for (const path of entries.keys()) if (isMigration(path)) {
    edge(/^db\/(?:sqlite|supabase)\.sql$/.test(path) ? 'lib/store.mjs' : 'lib/db/migrations.mjs', path);
    edge('scripts/migrate.mjs', path);
  }
  edge('tests/business-jobs-cli.test.mjs', 'scripts/business-jobs.mjs');
  edge('tests/heka-browser.mjs', 'tests/heka-browser-transport.mjs');
  edge('tests/e2e/advertising.spec.mjs', 'tests/e2e/guided-image-worker.mjs');
  edge('tests/heka-adapter.test.mjs', 'desktop/providers/heka.mjs');
  return { reverse, unresolved };
}
function dependents(path, graphs) {
  const visited = new Set([path]);
  for (const entry of visited) for (const { reverse } of graphs) for (const from of reverse.get(entry) || []) visited.add(from);
  return visited;
}
const composeInputs = ['compose.yaml', 'compose.nginx.yaml'];
function effectiveCompose(git, rev, entries) {
  if (!entries.has('compose.yaml')) throw Error('Compose base ausente');
  const temp = mkdtempSync(join(tmpdir(), 'allnutrition-impact-'));
  try {
    const args = ['compose', '-p', 'allnutrition-impact', '--project-directory', temp, '--profile', '*'];
    for (const name of composeInputs) if (entries.has(name)) {
      const path = join(temp, name);
      writeFileSync(path, git(['show', `${rev}:${name}`]));
      args.push('-f', path);
    }
    const env = { PATH: process.env.PATH, HOME: process.env.HOME || temp, DOCKER_CONFIG: process.env.DOCKER_CONFIG, LC_ALL: 'C', APP_IMAGE: 'allnutrition:synthetic', SCHEDULER_IMAGE: 'allnutrition:synthetic', SOCIAL_BROWSER_WORKER_IMAGE: 'allnutrition:synthetic', SOCIAL_BROWSER_IMAGE: 'allnutrition-runner:synthetic', POSTGRES_DB: 'allnutrition_test', POSTGRES_PASSWORD: 'local-fixture', DB_APP_PASSWORD: 'local-fixture', APP_URL: 'https://example.invalid', APP_DOMAIN: 'example.invalid', ADMIN_EMAIL: 'fixture@example.invalid', ADMIN_PASSWORD: 'local-fixture', LOCAL_UID: '1000', LOCAL_GID: '1000', DEPLOY_TLS_DIR: '/synthetic/tls', BACKUP_DIR: '/synthetic/backups', ARTIFACT_DIR: '/synthetic/artifacts' };
    return JSON.parse(command('docker', [...args, 'config', '--no-path-resolution', '--format', 'json'], { env, encoding: 'utf8' }));
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
function composeServices(before, after) {
  const affected = new Set();
  for (const service of new Set([...Object.keys(before.services), ...Object.keys(after.services)])) {
    const a = before.services[service], b = after.services[service];
    if (!isDeepStrictEqual(a, b)) { affected.add(service); continue; }
    for (const [kind, names] of [['networks', Object.keys(a?.networks || {})], ['volumes', (a?.volumes || []).filter(item => item.type === 'volume').map(item => item.source)]]) {
      if (names.some(name => !isDeepStrictEqual(before[kind]?.[name], after[kind]?.[name]))) affected.add(service);
    }
  }
  return affected;
}
function runtimeDeps(git, rev, entries) {
  if (!entries.has('package.json')) return {};
  const { dependencies, optionalDependencies, peerDependencies, overrides, engines } = JSON.parse(git(['show', `${rev}:package.json`]));
  return { dependencies, optionalDependencies, peerDependencies, overrides, engines };
}
const consumes = (unit, path, reached) => unit === 'web'
  ? [...reached].some(isWebEntry) || reached.has('scripts/migrate.mjs') || path === 'scripts/setup.mjs'
  : roots[unit]?.some(root => reached.has(root));
function markPlaywright(set, value) {
  const [file, domain] = value.split(':');
  if (!domain) { for (const selected of set) if (selected.startsWith(`${file}:`)) set.delete(selected); }
  if (!domain || !set.has(file)) set.add(value);
}

export async function calculateImpact({ head, base, state, cwd = process.cwd() }) {
  if (!sha40.test(head) || head === none) throw Error('Se requiere SHA completo del candidato');
  const git = gitAt(cwd);
  if (git(['rev-parse', '--verify', `${head}^{commit}`]).trim() !== head) throw Error('Candidato no es commit');
  const production = state !== undefined;
  const recognized = !production || state?.format === 1;
  const coveredThrough = recognized ? (production ? state.coveredThrough : base) : null;
  const configCommit = recognized ? (production ? state.configCommit : base) : null;
  const serviceBases = Object.fromEntries(units.map(unit => [unit, recognized ? (production ? state.services?.[unit]?.sourceCommit ?? null : base ?? null) : null]));
  const bases = { coveredThrough: coveredThrough ?? null, services: serviceBases, configCommit: configCommit ?? null, deploymentId: production && state?.deploymentId != null ? String(state.deploymentId) : null };
  const diagnostics = new Set();
  const changes = new Map();
  const getDiff = (rev, context) => {
    if (!ancestor(cwd, rev, head)) { diagnostics.add(`base:${context}:unknown-or-not-ancestor`); return null; }
    if (!changes.has(rev)) {
      try { changes.set(rev, diff(git, rev, head)); } catch { changes.set(rev, null); }
    }
    const found = changes.get(rev);
    if (!found) diagnostics.add(`base:${context}:unsupported-diff`);
    return found;
  };
  if (!recognized) diagnostics.add('base:unsupported-manifest');
  const common = getDiff(coveredThrough, 'coveredThrough');
  const configChanged = getDiff(configCommit, 'configCommit');
  const unitChanges = Object.fromEntries(units.map(unit => [unit, getDiff(serviceBases[unit], unit)]));
  const headTree = tree(git, head);
  bases.schemaVersion = !recognized ? null : production ? (Number.isInteger(state.schemaVersion) ? state.schemaVersion : null) : common ? migrationVersion(tree(git, coveredThrough)) : null;
  const paths = new Map();
  const reason = (path, why) => {
    if (!paths.has(path)) paths.set(path, new Set());
    paths.get(path).add(why);
  };
  for (const path of common || []) if (isDocs(path) || isNodeTest(path) || isHarness(path) || path.startsWith('tests/') || path.startsWith('desktop/') || path === 'package.json' || !production) reason(path, 'coveredThrough');
  for (const path of configChanged || []) if (isInfra(path)) reason(path, 'config');
  const input = new Set([...(common || []), ...(configChanged || []), ...Object.values(unitChanges).flatMap(set => [...(set || [])])]);
  const cache = new Map(), parsed = new Map(), trees = new Map([[head, headTree]]), graphs = new Map();
  const entries = rev => { if (!trees.has(rev)) trees.set(rev, tree(git, rev)); return trees.get(rev); };
  let ts;
  if ([...input].some(path => graphPath(path) || isMigration(path))) {
    try { const module = await import('typescript'); ts = module.default || module; }
    catch (cause) { throw Object.assign(Error('Instale el parser TypeScript con npm ci para analizar cambios de código', { cause }), { exitCode: 42 }); }
  }
  const getGraph = rev => {
    if (!ts || !rev) return null;
    if (!graphs.has(rev)) graphs.set(rev, graph(ts, git, entries(rev), cache, parsed));
    return graphs.get(rev);
  };
  const graphPair = rev => [getGraph(head), ...rev !== head ? [getGraph(rev)] : []].filter(Boolean);
  const node = new Set(), postgres = new Set(), playwright = new Set(), gates = new Set(), build = new Set(), recreate = new Set(), config = new Set(), runtimeUnits = new Set();
  const candidateTests = sort([...headTree.keys()].filter(isNodeTest));
  const addNode = file => { if (headTree.has(file)) node.add(file); };
  const addBrowser = names => names.forEach(name => {
    if (name === 'privacy' || headTree.has(`tests/e2e/${name.split(':')[0]}.spec.mjs`)) markPlaywright(playwright, name);
  });
  const addPg = list => {
    if (headTree.has('tests/postgres.integration.test.mjs')) list.forEach(g => postgres.add(g));
    if (list.includes('assistant') && headTree.has('tests/assistant-work-postgres.test.mjs')) postgres.add('assistant-work');
  };
  const everyTest = () => {
    candidateTests.forEach(file => node.add(file));
    addNode('tests/heka-browser.mjs');
    addPg(pgGroups);
    addBrowser(browserSpecs);
    ['https', 'restore', 'scheduler', 'runner', 'audit'].forEach(g => gates.add(g));
  };
  if (!common || !configChanged || [...Object.values(unitChanges)].includes(null)) everyTest();
  const scoped = new Map();
  const scope = (path, rev) => {
    const key = `${rev}:${path}`;
    if (!scoped.has(key)) scoped.set(key, dependents(path, graphPair(rev)));
    return scoped.get(key);
  };
  const dependencyChanges = new Set(['package-lock.json', '.dockerignore', 'scripts/install.mjs']);
  const touchedDeps = (path, rev) => dependencyChanges.has(path) || path === 'package.json' && !isDeepStrictEqual(runtimeDeps(git, rev, entries(rev)), runtimeDeps(git, head, headTree));
  for (const unit of units.filter(unit => unit !== 'db')) {
    if (!unitChanges[unit]) {
      build.add(unit === 'social-browser' ? 'runner' : 'app');
      runtimeUnits.add(unit);
      recreate.add(unit);
      continue;
    }
    const rev = serviceBases[unit];
    for (const path of unitChanges[unit]) {
      if (isDocs(path) || isInfra(path) || isHarness(path) || /^(?:tests|desktop)\//.test(path)) continue;
      const reached = scope(path, rev);
      const deps = touchedDeps(path, rev);
      if (deps || (unit === 'social-browser' ? path === 'Dockerfile.social-browser' : path === 'Dockerfile') || consumes(unit, path, reached)) {
        reason(path, `runtime:${unit}`);
        build.add(unit === 'social-browser' ? 'runner' : 'app');
        runtimeUnits.add(unit);
        recreate.add(unit);
        if (deps) gates.add('audit');
      } else if (!['Dockerfile', 'Dockerfile.social-browser', 'package.json'].includes(path) && !consumes('web', path, reached) && !Object.keys(roots).some(name => consumes(name, path, reached)) && /^(lib|scripts|app|public)\//.test(path)) {
        reason(path, 'runtime:unowned');
        reason(path, `runtime:${unit}`);
        build.add(unit === 'social-browser' ? 'runner' : 'app');
        runtimeUnits.add(unit);
        recreate.add(unit);
      }
    }
  }
  if (!configChanged) gates.add('infra');
  const relevantConfig = [...(configChanged || [])].filter(isInfra);
  if (relevantConfig.length) gates.add('compose');
  if (relevantConfig.some(path => composeInputs.includes(path))) {
    try {
      const old = effectiveCompose(git, configCommit, entries(configCommit));
      const next = effectiveCompose(git, head, headTree);
      for (const unit of composeServices(old, next)) {
        if (['db', 'proxy'].includes(unit) || /^(?:migrate|setup|backup|checks)$/.test(unit) && !next.services[unit]) gates.add('infra');
        else if (units.includes(unit)) recreate.add(unit);
      }
    } catch {
      diagnostics.add('compose:effective-config-unavailable');
      gates.add('infra');
      everyTest();
    }
  }
  for (const path of relevantConfig) {
    if (configFiles.includes(path)) config.add(path);
    if (/deploy\/(?:nginx|kvm|pg_hba|postgres-entrypoint)/.test(path)) gates.add('infra');
    if (path === 'deploy/social-browser-seccomp.json') { recreate.add('social-browser'); gates.add('runner'); }
  }
  for (const path of paths.keys()) {
    if (isDocs(path) || isInfra(path)) continue;
    if (isHarness(path) || path === 'package.json') { gates.add('harness'); continue; }
    const pathBases = new Set([...(common ? [coveredThrough] : []), ...units.filter(unit => paths.get(path).has(`runtime:${unit}`)).map(unit => serviceBases[unit])]);
    const reached = new Set([path, ...[...pathBases].flatMap(rev => [...scope(path, rev)])]);
    for (const hit of reached) if (isNodeTest(hit) || hit === 'tests/heka-browser.mjs') addNode(hit);
    const directSpec = /^tests\/e2e\/([^/]+)\.spec\.mjs$/.exec(path);
    if (directSpec) { addBrowser([directSpec[1]]); continue; }
    if (path === 'tests/postgres.integration.test.mjs' || path === 'tests/postgres-fixture.mjs') { addPg(pgGroups); continue; }
    if (path === 'tests/assistant-work-postgres.test.mjs') { addPg(['assistant']); continue; }
    if (path.startsWith('tests/')) {
      for (const hit of reached) {
        const match = /^tests\/e2e\/([^/]+)\.spec\.mjs$/.exec(hit);
        if (match) addBrowser([match[1]]);
      }
      if (/^tests\/e2e\/(?:helpers|setup|acceptance-fixtures)\.mjs$/.test(path)) addBrowser(browserSpecs);
      if (reached.has('tests/postgres.integration.test.mjs')) {
        const groups = domains(path).flatMap(domain => postgresByDomain[domain] || []);
        addPg(groups.length ? groups : pgGroups);
      }
      if (reached.has('tests/assistant-work-postgres.test.mjs')) addPg(['assistant']);
      continue;
    }
    if (path.startsWith('desktop/')) {
      candidateTests.filter(file => /heka|shipping-bridge/.test(file)).forEach(file => node.add(file));
      if (!/^desktop\/(?:providers|lib)\//.test(path)) gates.add('desktop');
      continue;
    }
    if (isCorePersistence(path)) { everyTest(); addPg(pgGroups); }
    if (isMigration(path)) { gates.add('migration'); gates.add('restore'); addPg(['schema', 'backup']); }
    if (/business-backup|backup/.test(path)) { gates.add('restore'); addPg(['backup']); }
    if (isBrowserPair(path)) gates.add('runner');
    const assigned = domains(path);
    if (assigned.includes('security')) addBrowser(browserSpecs);
    // Test indirect route owners when the leaf has no owner. Shared layouts and
    // admin entrypoints do not widen an already-owned UI leaf to all browser UI.
    if (!assigned.length) for (const hit of reached) if (/^app\/api\//.test(hit)) assigned.push(...domains(hit));
    for (const domain of new Set(assigned)) {
      if (isWebEntry(path) || [...reached].some(isWebEntry)) addBrowser(domainSpecs[domain]);
      if (!/^(?:components\/|app\/(?!api\/)|public\/)/.test(path)) {
        candidateTests.filter(file => nodeOwners[domain].test(file)).forEach(file => node.add(file));
        addPg(postgresByDomain[domain] || []);
      }
      if (domain === 'heka') addNode('tests/heka-browser.mjs');
    }
    if (!assigned.length && (isWebEntry(path) || paths.get(path).has('runtime:unowned'))) everyTest();
    for (const rev of pathBases) for (const g of graphPair(rev)) for (const hit of reached) if (g.unresolved.has(hit)) {
      diagnostics.add(`imports:${hit}:unresolved-local`);
      if (assigned.length) { addBrowser(assigned.flatMap(domain => domainSpecs[domain])); addPg(assigned.flatMap(domain => postgresByDomain[domain] || [])); }
      else everyTest();
    }
  }
  const schemaVersion = migrationVersion(headTree);
  if (production && recognized && Number.isInteger(state.schemaVersion) && state.schemaVersion !== schemaVersion) {
    gates.add('migration'); gates.add('restore'); addPg(['schema', 'backup']);
    if (state.schemaVersion > schemaVersion) diagnostics.add('schema:candidate-older-than-production');
    if (state.schemaVersion < schemaVersion) for (const writer of ['web', 'scheduler', 'social-browser-worker']) recreate.add(writer);
  }
  if (build.has('app')) { gates.add('runtime'); gates.add('https'); }
  if (!common || !configChanged || [...Object.values(unitChanges)].includes(null)) {
    if (schemaVersion) gates.add('migration');
  }
  if (runtimeUnits.has('scheduler')) gates.add('scheduler');
  if (runtimeUnits.has('social-browser') || runtimeUnits.has('social-browser-worker')) gates.add('runner');
  if (recreate.has('web') && build.has('app')) gates.add('https');
  if (gates.has('restore')) { addBrowser(['app:media']); gates.add('https'); }
  if (playwright.size) gates.add('https');
  if (postgres.size) gates.add('postgres');
  return { format: 1, head, bases, paths: sort(paths.keys()).map(path => ({ path, reasons: sort(paths.get(path)) })), diagnostics: sort(diagnostics), node: sort(node), postgres: sort(postgres), playwright: sort(playwright), gates: sort(gates), build: sort(build), recreate: sort(recreate), config: sort(config), schemaVersion };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = process.argv.slice(2);
    const [first, firstValue, second, secondValue] = options;
    const [headArg, head, baseArg, reference] = first === '--head' ? options : [second, secondValue, first, firstValue];
    if (options.length !== 4 || headArg !== '--head' || !['--base', '--state'].includes(baseArg) || !reference) throw Error('Uso: node scripts/release-impact.mjs --head <sha40> (--base <sha40> | --state <manifest.json>)');
    const plan = await calculateImpact({ head, ...(baseArg === '--base' ? { base: reference } : { state: JSON.parse(readFileSync(reference, 'utf8')) }) });
    for (const message of plan.diagnostics) console.error(message);
    process.stdout.write(canonicalPlan(plan));
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode || 1;
  }
}
