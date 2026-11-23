import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { openStore } from '../lib/db/index.mjs';
import { runAdvisorContracts, runAdvisorSchemaContracts } from './assistant-advisor-contract.mjs';
import { getAssistantCapability, searchAssistantCapabilities } from '../lib/assistant/capabilities.mjs';
import { panelInventory, panelExclusions } from './assistant-panel-inventory.mjs';

const factory = () => openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
test('Evolución del esquema privado del asesor (SQLite)', t => runAdvisorSchemaContracts(t, factory));
test('Contratos del asesor (SQLite)', t => runAdvisorContracts(t, factory));

test('C1 inventario nativo y catálogo coinciden en ambas direcciones', t => {
  const native = new Map();
  for (const row of panelInventory) {
    assert.ok(!native.has(row.id), `Intención nativa repetida: ${row.id}`);
    assert.ok(row.label && row.evidence && row.prerequisite && row.proof, `Evidencia o clasificación incompleta: ${row.id}`);
    assert.match(row.iteration, /^I[1-6]$/, row.id);
    native.set(row.id, row);
  }
  const directory = new Map();
  let page = 1, total = null;
  for (;;) {
    const result = searchAssistantCapabilities('', { page });
    assert.equal(result.page, page);
    if (total === null) total = result.total;
    assert.equal(result.total, total);
    assert.equal(result.items.length, Math.max(0, Math.min(5, total - directory.size)));
    for (const item of result.items) {
      assert.ok(!directory.has(item.id), `El directorio repite ${item.id} entre páginas`);
      directory.set(item.id, item);
    }
    if (directory.size === total) break;
    page++;
  }
  assert.deepEqual([...native.keys()].sort(), [...directory.keys()].sort(), 'Diferencia entre controles originales y catálogo');
  const families = {};
  for (const [id, row] of native) {
    const item = getAssistantCapability(id);
    assert.deepEqual({ area: item.area, mode: item.mode }, { area: row.area, mode: row.mode }, id);
    const family = id.split('.')[0];
    families[family] ??= {};
    families[family][row.iteration] = (families[family][row.iteration] || 0) + 1;
  }
  for (const row of panelExclusions) assert.ok(row.reason && row.evidence, 'Una exclusión requiere su control o ruta y motivo.');
  t.diagnostic(`C1 denominador por familia e iteración: ${JSON.stringify(families)} (${total} intenciones)`);
});

test('C1 las rutas administrativas tienen una intención o una exclusión explícita', () => {
  const shortReferences = {
    'assistant/oauth/complete': 'app/api/admin/assistant/oauth/callback y /complete',
    'assistant/turns/[turnId]/advance': '/turns/:turnId/advance',
    'assistant/turns/[turnId]/reads/[readId]': '/turns/:turnId/reads/all',
    'social/generation/brief': '/generation/brief?campaignId',
    'social/oauth/complete': '/oauth/complete GET/POST',
  };
  const evidence = [...panelInventory, ...panelExclusions].map(row => row.evidence).join('\n');
  const routes = readdirSync(new URL('../app/api/admin/', import.meta.url), { recursive: true })
    .map(path => path.replaceAll('\\', '/'))
    .filter(path => path.endsWith('/route.js')).map(path => path.slice(0, -'/route.js'.length));
  const unclassified = routes.filter(path => {
    const references = [path, path.replace(/\[([^\]]+)\]/g, ':id'), path.replace(/\[([^\]]+)\]/g, ':$1')];
    if (shortReferences[path]) references.push(shortReferences[path]);
    return !references.some(reference => evidence.includes(reference));
  });
  assert.deepEqual(unclassified, [], 'Cada ruta debe vincularse a una intención o a una exclusión motivada; las variantes se documentan por separado.');
});

test('C1 búsqueda de acciones normaliza acentos, respeta el área y no inventa coincidencias', () => {
  const { items } = searchAssistantCapabilities('  ARQUÉO  ', { area: 'cash' });
  assert.ok(items.some(item => item.id === 'cash.close-day'));
  assert.ok(items.every(item => item.area === 'cash'));
  assert.deepEqual(searchAssistantCapabilities('hipopótamo termonuclear'), { items: [], page: 1, total: 0 });
  assert.equal(getAssistantCapability('orders.not-an-action'), null);
});
