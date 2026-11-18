import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalPlan, requiredChecks, sha40 } from './release-impact.mjs';
import { browserSpecs, configFiles, gateNames, isNodeTest, manualNode, pgGroups, units } from './release-impact-matrix.mjs';

export const browserFilters = Object.freeze({
  'app:storefront': '@storefront', 'app:orders': '@orders', 'app:cash': '@cash', 'app:reports': '@reports', 'app:business': '@business',
  'app:media': 'sube una imagen local optimizada y la muestra en la vitrina pública',
  'security:media': '@media|multipart', 'integrations:heka': 'Heka: emparejar, confirmar', 'integrations:social': 'redes sociales: configuración dinámica',
});
export const organicCase = 'aprobación orgánica no publica';
export const fullPgGroups = [...pgGroups, 'assistant-work'];
export const nodeBrowser = file => file === 'tests/heka-browser.mjs';
export const nodeSandboxed = file => /^tests\/social-browser(?:-measurements)?\.test\.mjs$/.test(file);
export const nodeMedia = file => /\/(?:social-media|social-media-backup|social-generation|social-evidence)\.test\.mjs$/.test(file);
function assertList(list, validate, name) {
  if (!Array.isArray(list) || new Set(list).size !== list.length || list.some(item => typeof item !== 'string' || !validate(item))) throw Error(`Lista de impacto inválida: ${name}`);
}
export function readPlan(path, cwd) {
  const bytes = readFileSync(path, 'utf8');
  const plan = JSON.parse(bytes);
  if (plan.format !== 1 || !sha40.test(plan.head) || !Array.isArray(plan.paths) || !Array.isArray(plan.diagnostics) || !Number.isInteger(plan.schemaVersion) || bytes !== canonicalPlan(plan)) throw Error('Formato de plan de impacto inválido');
  assertList(plan.node, file => (isNodeTest(file) || manualNode.includes(file)) && existsSync(join(cwd, file)), 'node');
  assertList(plan.postgres, group => fullPgGroups.includes(group), 'postgres');
  assertList(plan.playwright, spec => spec === 'privacy' || (browserSpecs.includes(spec) || Object.hasOwn(browserFilters, spec)) && existsSync(join(cwd, `tests/e2e/${spec.split(':')[0]}.spec.mjs`)), 'playwright');
  assertList(plan.gates, gate => gateNames.includes(gate), 'gates');
  assertList(plan.build, kind => ['app', 'runner'].includes(kind), 'build');
  assertList(plan.recreate, service => units.includes(service) && service !== 'db', 'recreate');
  assertList(plan.config, path => configFiles.includes(path), 'config');
  return plan;
}
export function preflight(plan, mode) {
  const full = mode === 'full';
  const required = requiredChecks(plan, mode);
  return {
    npm: full || plan.node.some(file => !nodeSandboxed(file)) || required.some(id => /^(playwright:|gate:(harness|audit|desktop)$)/.test(id)),
    browser: full || plan.playwright.some(spec => spec !== 'privacy') || plan.node.some(nodeBrowser),
    ffmpeg: full || plan.node.some(nodeMedia),
    docker: full || Boolean(plan.build.length || plan.postgres.length || plan.playwright.length || plan.node.some(nodeSandboxed) || plan.gates.some(gate => !['audit', 'desktop'].includes(gate))),
  };
}

export function playwrightFailures(report) {
  const failures = [];
  const field = value => String(value ?? '').replace(/\b[\w+.-]+:\/\/\S+/g, '[URL redactada]').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
  function visit(suites) {
    for (const suite of suites) {
      for (const spec of suite.specs) for (const test of spec.tests) {
        if (!['unexpected', 'flaky', 'skipped'].includes(test.status)) continue;
        const attempt = test.results.findLast(result => ['failed', 'timedOut', 'interrupted'].includes(result.status));
        failures.push({ title: field(spec.title), project: field(test.projectName), status: attempt ? `${test.status}:${attempt.status}` : test.status });
      }
      visit(suite.suites || []);
    }
  }
  visit(report.suites);
  return failures;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.env.RELEASE_MODE || 'impact';
  process.stdout.write(JSON.stringify(preflight(readPlan(process.argv[2], process.env.RELEASE_CANDIDATE || process.cwd()), mode)) + '\n');
}
