import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { databaseConfig } from '../../lib/db/config.mjs';
import { openPostgres } from '../../lib/db/postgres.mjs';
import { Store } from '../../lib/store.mjs';
import { testDatabaseEnv } from '../postgres-fixture.mjs';
import { hash, insertRow } from '../../lib/business/commands.mjs';
import { SOCIAL_ANALYSIS_VERSION, buildSocialHistoricalForecast } from '../../lib/business/social-analysis.mjs';
import { saveSocialSettings } from '../../lib/business/social-settings.mjs';
import { loadSocialRuntime } from '../../lib/social/config.mjs';
import { saveCredentials } from '../../lib/social/credentials.mjs';
import { socialMeasurementQueryKey } from '../../lib/social/evidence.mjs';
import { improvementMeasurement, exactMetric } from '../social-improvements-fixture.mjs';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { login, navigate, selectWorkspace, openDisclosure, signOut } from './helpers.mjs';

const ROOT = '/api/admin/social';

// Use the authenticated panel's CSRF token and existing HTTP contracts only.
async function advertisingFixture(page, info) {
  const panelRequest = page.waitForRequest(request => new URL(request.url()).pathname.startsWith('/api/admin/') && Boolean(request.headers()['x-csrf-token']));
  await login(page);
  const request = await panelRequest;
  const headers = { Origin: new URL(page.url()).origin, 'x-csrf-token': await request.headerValue('x-csrf-token') };
  const marker = `publicidad-${info.project.name}-${randomUUID()}`;
  const get = async path => {
    const response = await page.request.get(path);
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const post = async (path, data) => {
    const response = await page.request.post(path, { headers, data: { ...data, requestId: randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const asset = id => get(`${ROOT}/assets/${id}`);
  const campaign = async id => {
    // Analysis contains a read-time cut; compare the durable campaign instead.
    const { analysis: _analysis, ...detail } = await get(`${ROOT}/campaigns/${id}`);
    return detail;
  };
  return { marker, get, post, asset, campaign };
}

async function expectView(page, values) {
  await expect(page).toHaveURL(url => Object.entries(values).every(([key, value]) => value == null ? !url.searchParams.has(key) : url.searchParams.get(key) === String(value)));
}

function card(page, name) {
  return page.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
}

function expectUnpublished(detail) {
  expect(detail.state).toBe('draft');
  expect(detail.connectionId).toBeNull();
  expect(detail.assetId).toBeNull();
  expect(detail.revisions).toEqual([]);
  expect(detail.deliveries).toEqual([]);
  expect(detail.operations).toEqual([]);
}

function observeWrites(page) {
  const writes = [];
  const watch = request => {
    if (new URL(request.url()).pathname.startsWith('/api/admin/') && !['GET', 'HEAD'].includes(request.method())) writes.push({ method: request.method(), url: request.url() });
  };
  page.on('request', watch);
  return { writes, stop: () => page.off('request', watch) };
}

async function keyboardGuide(page) {
  const guide = page.locator('summary').filter({ hasText: /^Cómo usar Publicidad$/ });
  await expect(guide).toBeVisible();
  await expect(guide.locator('..')).not.toHaveAttribute('open', '');
  await guide.focus();
  await page.keyboard.press('Enter');
  await expect(guide.locator('..')).toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(guide.locator('..')).not.toHaveAttribute('open', '');
}

async function expectPreview(page, id) {
  const image = page.getByRole('img', { name: /^Derivado normalizado de / }).and(page.locator(`img[src*="/assets/${id}/content"]`));
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate(element => element.complete && element.naturalWidth > 0)).toBe(true);
}

async function closeAsset(page) {
  const workspace = page.getByRole('region', { name: 'Publicidad en redes sociales', exact: true });
  await workspace.getByRole('button', { name: /^Cerrar / }).click();
  await expectView(page, { record: null });
}

test('publicidad guiada: guardar y organizar sin publicar', async ({ page }, info) => {
  test.setTimeout(180000);
  const f = await advertisingFixture(page, info);
  const name = `${f.marker} idea`, unsavedName = `${f.marker} cambio sin guardar`;
  await navigate(page, 'Publicidad');
  const advertisingTabs = page.getByRole('navigation', { name: 'Vistas de publicidad', exact: true });
  await expect(advertisingTabs.getByRole('button', { name: 'Cuentas conectadas', exact: true })).toHaveCount(0);
  await expect(advertisingTabs.locator('option[value="connections"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conectar con Facebook', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Crear publicidad', exact: true }).first().click();
  const nameInput = page.locator('input[name="name"]');
  await nameInput.fill(name);
  const saving = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/campaigns` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
  const response = await saving;
  expect(response.ok(), await response.text()).toBe(true);
  const saved = await response.json();
  await expectView(page, { section: 'advertising', tab: 'campaigns', record: saved.id });
  const baseline = await f.campaign(saved.id);
  expectUnpublished(baseline);
  expect(baseline.name).toBe(name);
  await page.reload();
  await expect(nameInput).toHaveValue(name);

  await nameInput.fill(unsavedName);
  let accept = false, confirmations = 0;
  const discard = async dialog => {
    expect(dialog.type()).toBe('confirm');
    confirmations++;
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  };
  page.on('dialog', discard);
  try {
    await page.getByRole('button', { name: 'Volver a publicaciones', exact: true }).click();
    await expect.poll(() => confirmations).toBe(1);
    await expectView(page, { record: saved.id });
    await expect(nameInput).toHaveValue(unsavedName);
    expect(await f.campaign(saved.id)).toEqual(baseline);
    accept = true;
    await page.getByRole('button', { name: 'Volver a publicaciones', exact: true }).click();
    await expect.poll(() => confirmations).toBe(2);
    await expectView(page, { record: null });
  } finally {
    page.off('dialog', discard);
  }
  await card(page, name).getByRole('button', { name: 'Continuar borrador', exact: true }).click();
  await expect(nameInput).toHaveValue(name);

  const reading = observeWrites(page), steps = page.getByRole('navigation', { name: 'Pasos de preparación', exact: true });
  const caption = `${f.marker} texto conservado entre pasos`;
  try {
    await steps.getByRole('button').nth(1).click();
    await page.locator('textarea[name="caption"]').fill(caption);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await expect(steps.getByRole('button').nth(2)).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('heading', { name: 'Paso 3 de 3 · Revisar y publicar' })).toBeFocused();
    await steps.getByRole('button').first().click();
    await expect(nameInput).toHaveValue(name);
    await steps.getByRole('button').nth(1).click();
    await expect(page.locator('textarea[name="caption"]')).toHaveValue(caption);
    expect(await f.campaign(saved.id)).toEqual(baseline);
    expect(reading.writes).toEqual([]);
  } finally {
    reading.stop();
  }
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Volver a publicaciones', exact: true }).click();
  await expectView(page, { record: null });

  const guideReads = observeWrites(page), dialogs = [];
  const rejectUnexpectedDialog = async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); };
  page.on('dialog', rejectUnexpectedDialog);
  try {
    await keyboardGuide(page);
    await card(page, name).getByRole('button', { name: 'Continuar borrador', exact: true }).click();
    await expect(nameInput).toHaveValue(name);
    await page.getByRole('button', { name: 'Volver a publicaciones', exact: true }).click();
    await expectView(page, { record: null });
    expect(dialogs).toEqual([]);
    expect(guideReads.writes).toEqual([]);
  } finally {
    guideReads.stop();
    page.off('dialog', rejectUnexpectedDialog);
  }

  const paidName = `${f.marker} anuncio`;
  const paid = await f.post(`${ROOT}/campaigns`, { name: paidName, mode: 'paid' });
  const search = page.getByRole('textbox', { name: 'Buscar publicación', exact: true });
  await search.fill(f.marker);
  await page.getByRole('combobox', { name: 'Tipo de publicación', exact: true }).selectOption('organic');
  const filtered = { section: 'advertising', tab: 'campaigns', q: f.marker, mode: 'organic', record: null };
  await expectView(page, filtered);
  await expect(card(page, name)).toBeVisible();
  await expect(card(page, paidName)).toHaveCount(0);
  await page.reload();
  await expect(search).toHaveValue(f.marker);
  await expect(page.getByRole('combobox', { name: 'Tipo de publicación', exact: true })).toHaveValue('organic');
  await expect(card(page, name)).toBeVisible();
  await expect(card(page, paidName)).toHaveCount(0);
  await page.getByRole('button', { name: /^Quitar filtro: .*: Publicación sin inversión$/ }).click();
  await expect(search).toBeFocused();
  await expectView(page, { q: f.marker, mode: null, page: null });
  await expect(card(page, paidName)).toBeVisible();
  await page.goBack();
  await expectView(page, filtered);
  await expect(card(page, paidName)).toHaveCount(0);
  await expect(card(page, name)).toBeVisible();
  await page.goForward();
  await expectView(page, { q: f.marker, mode: null });
  await expect(card(page, paidName)).toBeVisible();

  const outOfRange = new URL(page.url());
  outOfRange.searchParams.set('page', '99');
  await page.goto(outOfRange.href);
  await expect(page.getByRole('button', { name: 'Ir a la primera página', exact: true })).toBeVisible();
  await expect(card(page, name)).toHaveCount(0);
  await page.getByRole('button', { name: 'Ir a la primera página', exact: true }).click();
  await expectView(page, { q: f.marker, page: null });
  await expect(card(page, name)).toBeVisible();
  await expect(card(page, paidName)).toBeVisible();
  expectUnpublished(await f.campaign(paid.id));
  expect(await f.campaign(saved.id)).toEqual(baseline);
});

test('publicidad guiada: archivo utilizable y archivo archivado son distintos', async ({ page }, info) => {
  test.setTimeout(240000);
  const f = await advertisingFixture(page, info), name = `${f.marker} imagen`, originalName = `${f.marker}-original.png`;
  const png = await sharp({ create: { width: 400, height: 500, channels: 4, background: { r: 70, g: 155, b: 90, alpha: 1 } } }).png().toBuffer();
  await navigate(page, 'Publicidad');
  await selectWorkspace(page, 'Vistas de publicidad', 'Biblioteca');
  await page.getByLabel('Archivo de imagen o video', { exact: true }).setInputFiles({ name: originalName, mimeType: 'image/png', buffer: png });
  await page.getByRole('textbox', { name: /^Nombre para encontrarlo después/ }).fill(name);
  const reserving = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/assets` && response.request().method() === 'POST');
  const uploading = page.waitForResponse(response => /^\/api\/admin\/social\/assets\/[^/]+\/content$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Subir archivo', exact: true }).click();
  const reservedResponse = await reserving;
  expect(reservedResponse.ok(), await reservedResponse.text()).toBe(true);
  const reserved = await reservedResponse.json(), uploadedResponse = await uploading;
  expect(uploadedResponse.status(), await uploadedResponse.text()).toBe(202);
  expect(['processing', 'ready']).toContain((await uploadedResponse.json()).state);
  // Only the real scheduler can turn the uploaded bytes into a ready derivative.
  await expect.poll(async () => {
    const current = await f.asset(reserved.id);
    return { state: current.state, diagnostic: current.diagnostic || null };
  }, { timeout: 120000, intervals: [500, 1000, 2000], message: 'El scheduler debe preparar el PNG real; el diagnóstico se conserva si falla.' }).toMatchObject({ state: 'ready' });
  const ready = await f.asset(reserved.id);
  expect(ready.originalBytes).toBe(png.length);
  expect(ready.derivativeBytes).toBeGreaterThan(0);
  const previewResponse = await page.request.get(`${ROOT}/assets/${ready.id}/content?variant=derivative`);
  expect(previewResponse.ok()).toBe(true);
  const preparedBytes = await previewResponse.body();

  const search = page.getByRole('textbox', { name: 'Buscar imagen o video', exact: true }), state = page.locator('select[name="assetState"]');
  await search.fill(`  ${name.toLocaleUpperCase('es')}  `);
  await expect(card(page, name)).toBeVisible({ timeout: 15000 });
  await search.fill(f.marker);
  await state.selectOption('ready');
  await expectView(page, { tab: 'assets', q: f.marker, status: 'ready' });
  await expect(card(page, name)).toBeVisible();
  await card(page, name).getByRole('button', { name: 'Ver archivo', exact: true }).click();
  await expectView(page, { record: ready.id, q: f.marker, status: 'ready' });
  await expectPreview(page, ready.id);
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
  await expectView(page, { record: null, q: null, status: null, page: null });
  await expect(search).toBeFocused();
  await search.fill(f.marker);
  await state.selectOption('ready');
  await expectView(page, { q: f.marker, status: 'ready' });

  page.once('dialog', async dialog => { expect(dialog.type()).toBe('confirm'); await dialog.accept(); });
  const archiving = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/assets/${ready.id}/actions` && response.request().method() === 'POST');
  await card(page, name).getByRole('button', { name: /^Archivar/ }).click();
  const archiveResponse = await archiving;
  expect(archiveResponse.ok(), await archiveResponse.text()).toBe(true);
  await expect(card(page, name)).toHaveCount(0);
  const archived = await f.asset(ready.id);
  expect(archived.state).toBe('archived');
  for (const key of ['bytes', 'originalBytes', 'originalSha256', 'derivativeBytes', 'derivativeSha256']) expect(archived[key]).toEqual(ready[key]);
  const originalResponse = await page.request.get(`${ROOT}/assets/${ready.id}/content?variant=original`);
  expect(originalResponse.ok()).toBe(true);
  expect(await originalResponse.body()).toEqual(png);
  const archivedPreview = await page.request.get(`${ROOT}/assets/${ready.id}/content?variant=derivative`);
  expect(archivedPreview.ok()).toBe(true);
  expect(await archivedPreview.body()).toEqual(preparedBytes);

  await state.selectOption('archived');
  await expect(card(page, name)).toBeVisible();
  await card(page, name).getByRole('button', { name: 'Ver archivo', exact: true }).click();
  await expectPreview(page, ready.id);
  await closeAsset(page);
  await page.getByRole('button', { name: /^Quitar filtro: .*: Archivada$/ }).click();
  await expect(search).toBeFocused();
  await expectView(page, { q: f.marker, status: null });
  await expect(card(page, name)).toBeVisible();
  await state.selectOption('archived');
  await page.getByRole('button', { name: new RegExp(`^Quitar filtro: .*: ${f.marker}$`) }).click();
  await expect(search).toBeFocused();
  await expectView(page, { q: null, status: 'archived' });
  await expect(card(page, name)).toBeVisible();

  await selectWorkspace(page, 'Vistas de publicidad', 'Publicaciones y campañas');
  await page.getByRole('button', { name: 'Crear publicidad', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Pasos de preparación', exact: true }).getByRole('button').nth(1).click();
  await page.getByRole('button', { name: 'Elegir de biblioteca', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Archivo de biblioteca', exact: true });
  await expect(selector).toBeVisible();
  await expect(selector.locator(`option[value="${ready.id}"]`)).toHaveCount(0);
});

test('publicidad guiada: oferta y pieza en el mismo borrador', async ({ page }, info) => {
  test.setTimeout(180000);
  const f = await advertisingFixture(page, info), tag = f.marker.slice(-8);
  const normal = { status: 'draft', orderable: true, presentation: '500 g', price: 23000, stockQuantity: 20 };
  const title = `Suplemento ${tag}`;
  const cacao = await f.post('/api/admin/products', { ...normal, title, slug: `cacao-${tag}`, flavor: `Cacao ${tag}`, sku: `CA-${tag}` });
  const vanilla = await f.post('/api/admin/products', { ...normal, title, presentation: '30 g', slug: `vainilla-${tag}`, flavor: `Vainilla ${tag}`, sku: `VA-${tag}` });
  const gift = await f.post('/api/admin/products', { ...normal, title: `Muestra ${tag}`, slug: `muestra-${tag}`, presentation: '30 g', flavor: 'Vainilla', productType: 'gift', price: 0, items: [{ productId: vanilla.id, quantity: 1 }] });
  const combo = await f.post('/api/admin/combos', { title: `Dúo ${tag}`, slug: `duo-${tag}`, status: 'draft', orderable: true, price: 52000, conditions: 'Dos unidades de la misma referencia', items: [{ productId: cacao.id, quantity: 2 }] });
  await navigate(page, 'Publicidad');
  await page.getByRole('button', { name: 'Crear publicidad', exact: true }).first().click();
  await page.getByRole('combobox', { name: 'Objetivo comercial', exact: true }).selectOption('whatsapp');
  const writes = observeWrites(page);
  await page.getByRole('button', { name: 'Elegir oferta del catálogo', exact: true }).click();
  const search = page.getByRole('searchbox', { name: /Buscar oferta por nombre/ });
  await expect(search).toBeFocused();
  await search.fill(`CACAO ${tag.toUpperCase()}`);
  await expect(page.getByRole('button', { name: new RegExp(`SKU CA-${tag}`) })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(`SKU VA-${tag}`) })).toHaveCount(0);
  await page.getByRole('combobox', { name: 'Tipo de oferta', exact: true }).selectOption('combo');
  await search.fill(`Dúo ${tag}`);
  const choice = page.getByRole('button', { name: new RegExp(`Dúo ${tag}.*Ref`) });
  await choice.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('input[name="name"]')).toHaveValue(new RegExp(`Dúo ${tag}.*WhatsApp`));
  await page.getByRole('button', { name: 'Añadir un obsequio', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Buscar obsequios' }).fill(`Muestra ${tag}`);
  await page.getByRole('button', { name: new RegExp(`Muestra ${tag}.*COP 0`) }).click();
  const condition = `Solo con Dúo ${tag}`;
  await page.locator('textarea[name="giftCondition"]').fill(condition);
  await expect(page.getByRole('list', { name: 'Composición de la oferta' }).getByRole('listitem')).toHaveText(`2 × ${title} · 500 g · Cacao ${tag}`);
  await expect(page.getByRole('list', { name: 'Composición del obsequio' }).getByRole('listitem')).toHaveText(`1 × ${title} · 30 g · Vainilla ${tag}`);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  const caption = page.locator('textarea[name="caption"]');
  await caption.fill('Conoce el combo exacto y pregunta por WhatsApp.');
  await page.getByRole('button', { name: 'Anterior', exact: true }).click();
  await expect(page.locator('textarea[name="giftCondition"]')).toHaveValue(condition);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(caption).toHaveValue('Conoce el combo exacto y pregunta por WhatsApp.');
  expect(writes.writes).toEqual([]);

  const draftResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/campaigns` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar borrador y preparar imagen', exact: true }).click();
  const savedResponse = await draftResponse;
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  const saved = await savedResponse.json();
  await expectView(page, { record: saved.id });
  await expect(page.getByRole('heading', { name: 'Paso 2 de 3 · Preparar contenido' })).toBeFocused();
  await expect(page.getByRole('group', { name: 'Preparar contenido', exact: true }).getByText('Invita a consultar por WhatsApp', { exact: false })).toBeVisible();
  const composer = page.getByRole('region', { name: 'Crear imagen', exact: true });
  await expect(composer.getByText('No está configurado el servicio de imágenes.', { exact: false })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Solicitar imagen con posible cargo' })).toBeDisabled();
  await expect(composer.getByText(condition, { exact: false })).toBeVisible();
  expect((await f.get(`${ROOT}/generation?campaignId=${saved.id}`)).jobs).toEqual([]);
  expect(writes.writes.filter(item => new URL(item.url).pathname === `${ROOT}/generation`)).toEqual([]);
  expectUnpublished(await f.campaign(saved.id));

  await page.getByRole('button', { name: 'Subir imagen', exact: true }).click();
  const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#226644' } }).png().toBuffer();
  await page.getByLabel('Archivo de imagen o video', { exact: true }).setInputFiles({ name: `duo-${tag}.png`, mimeType: 'image/png', buffer: png });
  const uploaded = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/content') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Subir archivo', exact: true }).click();
  const file = await (await uploaded).json();
  const useOriginal = page.getByRole('button', { name: 'Usar tal cual', exact: true });
  await expect(useOriginal).toBeEnabled({ timeout: 120000 });
  await expect.poll(() => page.locator(`img[src*="/assets/${file.id}/content"]`).first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  expect((await f.campaign(saved.id)).assetId).toBeNull();
  await useOriginal.click();
  const commit = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/campaigns/${saved.id}` && response.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
  expect((await commit).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('textarea[name="giftCondition"]')).toHaveValue(condition);
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.locator(`img[src*="/assets/${file.id}/content"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByLabel('Presupuesto total (no diario)', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Por comprobar: elige la cuenta', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Editar oferta' }).click();
  await page.getByRole('radio', { name: /^Campaña pagada/ }).check();
  await page.getByRole('button', { name: /3\. Revisar y publicar/ }).click();
  await expect(page.getByLabel('Presupuesto total (no diario)', { exact: false })).toBeVisible();
  const persisted = await f.campaign(saved.id);
  expect(persisted).toMatchObject({ state: 'draft', mode: 'organic', assetId: file.id, deliveries: [], operations: [], revisions: [], offerSnapshot: { primary: { id: combo.id, price: 52000, components: [{ id: cacao.id, quantity: 2 }] }, gift: { id: gift.id, price: 0, condition } } });
  expect(writes.writes.filter(item => new URL(item.url).pathname === `${ROOT}/generation`)).toEqual([]);
  expect(await page.locator('html').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1);
  writes.stop();
});

const controlledImages = process.env.ADVERTISING_IMAGE_E2E_URL;
const imageProject = process.env.ADVERTISING_IMAGE_COMPOSE_PROJECT;
test.describe('creador de imágenes con transporte sintético aislado', () => {
  test.use({ baseURL: controlledImages });
  test.skip(!controlledImages || !imageProject, 'Requiere un segundo fixture descartable HTTPS, con scheduler ordinario detenido.');
  function worker(action, id = '-') {
    expect(imageProject).toMatch(/^allnutrition-guided-image-[a-z0-9-]+$/);
    expect(controlledImages).toMatch(/^https:\/\/localhost:\d+$/);
    expect(controlledImages).not.toBe(process.env.E2E_BASE_URL);
    const result = spawnSync('docker', ['exec', `${imageProject}-web-1`, 'node', './tests/e2e/guided-image-worker.mjs', action, id, controlledImages], { encoding: 'utf8', timeout: 30000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }
  async function generate(page, f, composer, { campaignId, baseAssetId = null }) {
    const submit = composer.getByRole('button', { name: /^Solicitar (imagen|ajuste) con posible cargo$/ });
    await expect(submit).toBeDisabled();
    await composer.getByRole('checkbox', { name: /^Autorizo el envío/ }).check();
    const posted = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/generation` && response.request().method() === 'POST');
    await submit.click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(202);
    const job = await response.json();
    expect(job).toMatchObject({ campaignId, baseAssetId });
    worker('generation', job.id);
    const ready = await f.get(`${ROOT}/generation/${job.id}`);
    expect(ready.asset.state).toBe('ready');
    const derivative = await page.request.get(ready.asset.previewUrl);
    expect((await sharp(await derivative.body()).metadata()).format).toBe('jpeg');
    expect((await f.campaign(campaignId)).assetId).toBeNull();
    return ready.asset;
  }

  test('publicidad guiada: derivado nuevo y ajuste vertical nunca sustituyen automáticamente', async ({ page }, info) => {
    test.setTimeout(180000);
    const f = await advertisingFixture(page, info);
    worker('configure');
    await navigate(page, 'Publicidad');
    await page.getByRole('button', { name: 'Crear publicidad', exact: true }).first().click();
    await page.locator('input[name="name"]').fill(`${f.marker} contexto`);
    await page.getByLabel('Objetivo comercial').selectOption('reach');
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.locator('textarea[name="caption"]').fill('Conoce la marca y sus referencias.');
    await page.getByRole('button', { name: 'Guardar borrador y preparar imagen' }).click();
    const composer = page.getByRole('region', { name: 'Crear imagen', exact: true });
    await expect(composer.getByRole('heading', { name: 'Datos y fotos para preparar la imagen' })).toBeVisible();
    const campaignId = new URL(page.url()).searchParams.get('record');
    const image = await generate(page, f, composer, { campaignId });
    const use = composer.getByRole('button', { name: 'Usar esta imagen' });
    await expect(use).toBeEnabled({ timeout: 15000 });
    await page.getByRole('button', { name: 'Anterior', exact: true }).click();
    await page.getByLabel('Objetivo comercial').selectOption('whatsapp');
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await expect(use).toBeDisabled();
    await expect(composer.getByText('Esta imagen corresponde a otra oferta u objetivo', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Anterior', exact: true }).click();
    await page.getByLabel('Objetivo comercial').selectOption('reach');
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await use.click();
    expect((await f.campaign(campaignId)).assetId).toBeNull();
    await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
    await expect.poll(async () => (await f.campaign(campaignId)).assetId).toBe(image.id);
    await page.reload();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await expect(page.locator(`img[src*="/assets/${image.id}/content"]`)).toBeVisible();
    expect(await f.campaign(campaignId)).toMatchObject({ state: 'draft', deliveries: [], revisions: [], aiDisclosure: true });

    await page.getByRole('button', { name: 'Volver a publicaciones' }).click();
    await page.getByRole('button', { name: 'Crear publicidad', exact: true }).first().click();
    await page.locator('input[name="name"]').fill(`${f.marker} ajuste`);
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.getByRole('button', { name: 'Subir imagen', exact: true }).click();
    const vertical = await sharp({ create: { width: 540, height: 960, channels: 3, background: '#7a5522' } }).withExif({ IFD0: { Artist: 'NO-SALE-DEL-FIXTURE' } }).png().toBuffer();
    await page.getByLabel('Archivo de imagen o video', { exact: true }).setInputFiles({ name: 'vertical.png', mimeType: 'image/png', buffer: vertical });
    const upload = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/content') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Subir archivo', exact: true }).click();
    const uploaded = await (await upload).json();
    worker('asset', uploaded.id);
    const base = await f.asset(uploaded.id);
    expect(base.diagnostic.code).toBe('IMAGE_GEOMETRY');
    await expect(page.getByRole('button', { name: 'Usar tal cual' })).toBeDisabled();
    await page.getByRole('button', { name: 'Ajustar para publicar' }).click({ timeout: 15000 });
    const adjustment = page.getByRole('region', { name: 'Ajustar con indicaciones', exact: true });
    const display = adjustment.getByRole('img', { name: 'Imagen a modificar', exact: true });
    await expect(display).toHaveAttribute('src', new RegExp(`/assets/${base.id}/content\\?variant=reference&sha256=`));
    const baseResponse = await page.request.get(await display.getAttribute('src'));
    expect((await sharp(await baseResponse.body()).metadata()).exif).toBeUndefined();
    const adjustedCampaign = new URL(page.url()).searchParams.get('record');
    await adjustment.getByRole('textbox', { name: /^Indicaciones para esta imagen/ }).fill('Aclara el fondo y conserva el encuadre completo.');
    const variant = await generate(page, f, adjustment, { campaignId: adjustedCampaign, baseAssetId: base.id });
    expect(variant.id).not.toBe(base.id);
    await expect(adjustment.getByRole('button', { name: 'Usar la variante' })).toBeEnabled({ timeout: 15000 });
    await adjustment.getByRole('button', { name: 'Conservar original' }).click();
    expectUnpublished(await f.campaign(adjustedCampaign));
    expect(await f.asset(base.id)).toMatchObject({ state: 'failed', originalSha256: base.originalSha256 });
  });
});

test('publicidad guiada: consulta de Resultados persistente y sin efectos', async ({ page }, info) => {
  test.setTimeout(180000);
  const f = await advertisingFixture(page, info), draft = await f.post(`${ROOT}/campaigns`, { name: `${f.marker} resultados` });
  const baseline = await f.campaign(draft.id);
  expectUnpublished(baseline);
  const reading = observeWrites(page);
  try {
    await navigate(page, 'Publicidad');
    await selectWorkspace(page, 'Vistas de publicidad', 'Resultados');
    await page.getByRole('textbox', { name: 'Buscar publicaciones', exact: true }).fill(f.marker);
    await page.getByRole('button', { name: 'Buscar publicaciones', exact: true }).click();
    const publication = page.getByRole('combobox', { name: 'Publicación o campaña', exact: true });
    await expect(publication.locator(`option[value="${draft.id}"]`)).toHaveCount(1);
    await publication.selectOption(draft.id);
    await expectView(page, { record: draft.id });
    await expect(page.getByText('Borrador · Sin entregas; aún no hay rendimiento que analizar.', { exact: true })).toBeVisible();
    await openDisclosure(page, /^Medición de esta pieza y filtros$/);
    const from = page.locator('input[name="from"]'), to = page.locator('input[name="to"]');
    await from.fill('2026-11-01');
    await to.fill('2026-11-07');
    await expectView(page, { from: null, to: null });
    await page.getByRole('button', { name: 'Aplicar fechas', exact: true }).click();
    await openDisclosure(page, /^Más filtros de resultados$/);
    await page.getByRole('combobox', { name: 'Origen de los datos', exact: true }).selectOption('browser');
    await page.getByRole('combobox', { name: 'Tipo de resultados', exact: true }).selectOption('paid');
    await page.getByRole('combobox', { name: 'Ver por', exact: true }).selectOption('daily');
    const fullQuery = { section: 'advertising', tab: 'results', record: draft.id, from: '2026-11-01', to: '2026-11-07', integrationMethod: 'browser', scope: 'paid', dimension: 'daily' };
    await expectView(page, fullQuery);
    const summary = page.locator('summary').filter({ hasText: /^Más filtros de resultados$/ });
    await summary.click();
    const chips = page.getByRole('button', { name: /^Quitar filtro:/ });
    await expect(chips).toHaveCount(5);
    for (const chip of await chips.all()) await expect(chip).toBeVisible();
    const savedURL = page.url();
    await page.reload();
    await expectView(page, fullQuery);
    await openDisclosure(page, /^Medición de esta pieza y filtros$/);
    await expect(from).toHaveValue(fullQuery.from);
    await expect(to).toHaveValue(fullQuery.to);
    await expect(page.locator('select[name="integrationMethod"]')).toHaveValue('browser');
    await expect(page.locator('select[name="scope"]')).toHaveValue('paid');
    await expect(page.locator('select[name="dimension"]')).toHaveValue('daily');
    await page.goBack();
    await expectView(page, { ...fullQuery, dimension: null });
    await page.goForward();
    await expectView(page, fullQuery);
    await keyboardGuide(page);
    expect(reading.writes).toEqual([]);

    await signOut(page);
    await expect(page).toHaveURL(url => url.pathname === '/admin/login');
    await page.goto(savedURL);
    await expect(page).toHaveURL(url => url.pathname === '/admin/login' && Boolean(url.searchParams.get('next')));
    // Submit the login that received `next`; login() would replace that destination.
    await page.getByLabel('Correo de administrador').fill('e2e@example.test');
    await page.getByLabel('Contraseña', { exact: true }).fill('clave-e2e-solo-pruebas');
    const loggingIn = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login' && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Entrar al panel', exact: true }).click();
    expect((await loggingIn).status()).toBe(200);
    await expectView(page, fullQuery);
    await expect(from).toHaveValue(fullQuery.from);
    await expect(to).toHaveValue(fullQuery.to);
    await expect(page.locator('select[name="integrationMethod"]')).toHaveValue('browser');
    await expect(page.locator('select[name="scope"]')).toHaveValue('paid');
    await openDisclosure(page, /^Medición de esta pieza y filtros$/);
    await expect(page.locator('select[name="dimension"]')).toHaveValue('daily');

    await page.getByRole('button', { name: /^Quitar filtro: Ver por:/ }).click();
    await expect(summary).toBeFocused();
    await openDisclosure(page, /^Más filtros de resultados$/);
    const withoutDimension = { ...fullQuery, dimension: null };
    await expectView(page, withoutDimension);
    const appliedFromChip = page.getByRole('button', { name: /^Quitar filtro: Desde:/ });
    const appliedFromName = await appliedFromChip.getAttribute('aria-label');
    await from.fill('2026-11-08');
    await to.fill('2026-11-01');
    await expect(appliedFromChip).toHaveAttribute('aria-label', appliedFromName);
    await page.getByRole('button', { name: 'Aplicar fechas', exact: true }).click();
    const alert = page.getByRole('region', { name: 'Resultados de publicidad', exact: true }).getByRole('alert');
    await expect(alert).toBeVisible();
    await expect(alert).toBeFocused();
    await expectView(page, withoutDimension);
    await page.getByRole('button', { name: 'Limpiar filtros de resultados', exact: true }).click();
    await expect(summary).toBeFocused();
    await expectView(page, { section: 'advertising', tab: 'results', record: draft.id, from: null, to: null, integrationMethod: null, scope: null, dimension: null, page: null });
    await expect(from).toHaveValue('');
    await expect(to).toHaveValue('');
    await expect(chips).toHaveCount(0);
    await expect(page.getByText('Métricas completas, capturas y estado por destino', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Revisar mejoras', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Abrir borrador', exact: true })).toBeVisible();
    const refreshing = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === `${ROOT}/results` && url.searchParams.get('campaignId') === draft.id && response.request().method() === 'GET';
    });
    await page.getByRole('button', { name: 'Actualizar vista', exact: true }).click();
    const refreshed = await refreshing;
    expect(refreshed.ok(), await refreshed.text()).toBe(true);
    const results = await refreshed.json();
    expect(results.measurements).toEqual([]);
    expect(results.deliveries).toEqual([]);
    await page.getByRole('button', { name: 'Medición de la cuenta', exact: true }).click();
    await expectView(page, { section: 'advertising', tab: 'results', record: null });
    await expect(page.getByRole('heading', { name: 'Elige una publicación o campaña' })).toBeVisible();
    expect(await f.campaign(draft.id)).toEqual(baseline);
    expect(reading.writes).toEqual([]);
  } finally {
    reading.stop();
  }
});

async function seedResults(f) {
  const env = testDatabaseEnv(), host = new URL(env.DATABASE_URL).hostname;
  if (!['db', 'localhost', '127.0.0.1'].includes(host) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) throw new Error('La evidencia solo se instala en el fixture PostgreSQL local con TLS verificado.');
  const store = new Store(await openPostgres(databaseConfig(env)));
  try {
    if ((await store.db.get('SELECT current_database() AS name')).name !== 'allnutrition_test') throw new Error('La conexión real no corresponde al fixture allnutrition_test.');
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const now = new Date(), at = new Date(now - 1000).toISOString(), start = new Date(now - 8 * 86400000).toISOString();
    const connectionId = randomUUID(), assetId = randomUUID(), deliveryId = randomUUID(), forecastId = randomUUID();
    const identities = { userId: '100', businessId: '500', pageId: '200' }, name = `${f.marker} post confirmado`;
    const common = { version: 1, created_at: start, updated_at: at };
    await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'api', state: 'connected', data: JSON.stringify({ name: 'Cuenta de ensayo', identities, capabilities: { facebookPublish: true } }), ...common });
    await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256: 'a'.repeat(64), bytes: 100, data: JSON.stringify({ name: 'Pieza de ensayo', kind: 'image', derivativeSha256: 'a'.repeat(64) }), ...common });
    const tag = f.marker.slice(-8), product = await f.post('/api/admin/products', { title: `Oferta de prueba ${tag}`, slug: `prueba-${tag}`, status: 'draft', orderable: true, stockQuantity: 20, price: 25000, presentation: '500 g', flavor: 'Cacao' });
    const { offer } = await f.get(`${ROOT}/offers?kind=product&id=${product.id}`);
    const offerRef = { primary: { kind: 'product', id: product.id, factsHash: offer.factsHash }, gift: null };
    const draft = await f.post(`${ROOT}/campaigns`, { name, connectionId, assetId, offerRef, mode: 'organic', objective: 'engagement', caption: 'Texto actual de la publicación', platforms: ['facebook'], placements: ['facebook_feed'], aiDisclosure: false });
    const draftDetail = await f.campaign(draft.id);
    const fields = ['name','mode','objective','connectionId','assetId','caption','headline','destinationUrl','whatsappNumber','whatsappGreeting','platforms','placements','audience','budgetMinor','currency','publishAt','startAt','endAt','observationDays','targetCostMinor','aiDisclosure','integrationMethod','identities','timeZone'];
    const spec = { ...Object.fromEntries(fields.map(key => [key, draftDetail[key]]).filter(([, value]) => value !== undefined)), assetHash: 'a'.repeat(64), assetType: 'image', offerHash: draftDetail.offerHash };
    const specHash = hash(spec), evidenceHash = hash([draft.id, at]), recommendationId = randomUUID();
    const forecast = { ...buildSocialHistoricalForecast(spec, [], { asOf: start }), specHash, generatedAt: start };
    await insertRow(store, 'social_forecasts', { id: forecastId, campaign_id: draft.id, spec_hash: specHash, generated_at: start, data: JSON.stringify(forecast) });
    await insertRow(store, 'social_revisions', { campaign_id: draft.id, revision: 1, spec_hash: specHash, approved_at: start, actor_id: actor.id, data: JSON.stringify({ spec, forecastId, forecast, rightsAccepted: true, offerSnapshot: draftDetail.offerSnapshot }) });
    const object = BigInt(`0x${deliveryId.replaceAll('-', '')}`).toString().slice(0, 16), remoteId = `200_${object}`;
    const remoteRefs = { postId: remoteId, photoId: object, remoteId, permalink: `https://www.facebook.com/200/posts/${object}` };
    const delivery = { id: deliveryId, channel: 'facebook', remoteId, remoteRefs, integrationMethod: 'api', state: 'published', publishedAt: start, publicationTimeSource: 'publication_request_sent_at' };
    await insertRow(store, 'social_deliveries', { id: deliveryId, campaign_id: draft.id, revision: 1, channel: 'facebook', state: 'published', remote_id: remoteId, next_sync_at: null, data: JSON.stringify(delivery), ...common });
    await insertRow(store, 'social_operations', { id: randomUUID(), campaign_id: draft.id, delivery_id: deliveryId, operation_key: `delivery:${deliveryId}:publish`, step: 'publish', state: 'confirmed', next_attempt_at: null, data: JSON.stringify({ actorId: actor.id, specHash, chart: 'provider-controlled fixture', integrationMethod: 'api', channel: 'facebook', result: { evidence: { remoteRead: true } } }), ...common });
    const capture = improvementMeasurement(spec, delivery, { id: randomUUID(), now: at, values: { interactions: exactMetric(0, 'fixture_post_interactions') } });
    const { id: captureId, deliveryId: _delivery, fetchedAt, payloadHash: _hash, ...measurement } = capture;
    await insertRow(store, 'social_measurements', { id: captureId, delivery_id: deliveryId, query_key: socialMeasurementQueryKey(measurement), fetched_at: fetchedAt, payload_hash: hash(measurement), data: JSON.stringify(measurement) });
    const revision = Number((await store.db.get(`SELECT value FROM ${store.t('counters')} WHERE id='business_revision'`)).value);
    const row = await store.db.get(`SELECT data FROM ${store.t('social_campaigns')} WHERE id=?`, [draft.id]);
    const analysis = { analysisVersion: SOCIAL_ANALYSIS_VERSION, evidenceHash, businessRevision: revision, linkVersions: { orders: [], expenses: [] }, asOf: at, checkedAt: at, measurementCount: 1, recommendationIds: [recommendationId] };
    await store.db.run(`UPDATE ${store.t('social_campaigns')} SET data=?,state='published',updated_at=? WHERE id=?`, [JSON.stringify({ ...JSON.parse(row.data), analysis }), at, draft.id]);
    await insertRow(store, 'social_recommendations', { id: recommendationId, campaign_id: draft.id, evidence_hash: evidenceHash, rule_key: 'organic_response', state: 'suggested',
      data: JSON.stringify({ proposedChange: { type: 'copy', text: 'Probar una llamada a la acción más clara' }, primaryEvidence: { channel: 'facebook' }, observation: 'Respuesta por debajo de la referencia comparable.', successCriterion: { text: 'Aumentar interacciones al mismo horizonte.', metric: 'organicResponse', operator: 'gt', target: 0.1 }, sampleIds: [], metricIds: [captureId] }),
      ...common });
    await insertRow(store, 'social_recommendations', { id: randomUUID(), campaign_id: draft.id, evidence_hash: hash([draft.id, start]), rule_key: 'organic_response', state: 'evaluated',
      data: JSON.stringify({ proposedChange: { type: 'copy', text: 'Texto claro en la prueba anterior' }, primaryEvidence: { channel: 'facebook' }, observation: 'Prueba anterior para esta oferta.',
        successCriterion: { text: 'Aumentar interacciones al mismo horizonte.', metric: 'organicResponse', operator: 'gt', target: 0.1 }, conclusion: 'improved',
        evaluation: { complete: true, conclusion: 'improved', metric: 'organicResponse', parentValue: 0.08, childValue: 0.14, asOf: at } }), ...common });
    return { id: draft.id, name, recommendationId, connectionId };
  } finally { await store.close(); }
}

async function retireResultsConnection(record) {
  const env = testDatabaseEnv(), dbURL = new URL(env.DATABASE_URL);
  if (!['db','localhost','127.0.0.1'].includes(dbURL.hostname) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) {
    throw new Error('Solo se puede retirar la conexión sintética de este test en PostgreSQL local con TLS verificado.');
  }
  const store = new Store(await openPostgres(databaseConfig(env)));
  try {
    if ((await store.db.get('SELECT current_database() AS name')).name !== 'allnutrition_test') {
      throw new Error('La limpieza solo puede tocar el fixture allnutrition_test.');
    }
    await store.transaction(async tx => {
      const connection = await tx.db.get(`SELECT provider,integration_method,state,version FROM ${tx.t('social_connections')} WHERE id=?`, [record.connectionId]);
      if (!connection || connection.provider !== 'meta' || connection.integration_method !== 'api') {
        throw new Error('La limpieza no reconoció la conexión API sintética propia del test.');
      }
      const result = await tx.db.run(`UPDATE ${tx.t('social_connections')} SET state='disconnected',version=version+1,updated_at=? WHERE id=? AND provider='meta' AND integration_method='api' AND version=?`, [new Date().toISOString(), record.connectionId, connection.version]);
      if (result.changes !== 1) throw new Error('No se pudo retirar la conexión API sintética del test.');
    });
  } finally { await store.close(); }
}

test('publicidad guiada: preparar un cambio aquí o una variante sin enviar', async ({ page }, info) => {
  test.setTimeout(120000);
  const base = new URL(info.project.use.baseURL);
  if (base.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('La prueba de cambios requiere la aplicación HTTPS descartable local.');
  const f = await advertisingFixture(page, info), record = await seedResults(f);
  try {
    await page.goto(`/admin?section=advertising&tab=results&record=${record.id}&resultsFocus=recommendations`);
  await expect(page.getByRole('heading', { name: record.name, exact: true })).toBeVisible();
  await expect(page.getByText('0 reportado', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cambiar solo Facebook · Probar aquí' }).click();
  const prepare = page.getByRole('dialog');
  await prepare.getByRole('checkbox').check();
  const prepared = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/recommendations/${record.recommendationId}/actions`));
  await prepare.getByRole('button', { name: 'Preparar cambio', exact: true }).click();
  const same = await prepared;
  expect(same.status(), await same.text()).toBe(201);
  const change = await same.json();
  await expectView(page, { tab: 'campaigns', record: change.id });
  const local = await f.campaign(change.id);
  expect(local.applicationMode).toBe('same');
  expect(local.revisions).toEqual([]);
  expect((await f.campaign(record.id)).operations).toHaveLength(1);
  await f.post(`${ROOT}/recommendations/${record.recommendationId}/actions`, { action: 'cancel-in-place', version: local.changeDraft.recommendationVersion, evidenceHash: local.changeDraft.evidenceHash, draftId: change.id, draftVersion: local.version, deliveryId: local.changeDraft.deliveryId });
  await page.goBack();
  await expectView(page, { tab: 'results', record: record.id, resultsFocus: 'recommendations' });
  await page.getByRole('button', { name: 'Probar en una nueva publicación' }).click();
  const variant = page.getByRole('dialog');
  await variant.getByRole('checkbox').check();
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith(`/recommendations/${record.recommendationId}/actions`));
  await variant.getByRole('button', { name: 'Crear variante', exact: true }).click();
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const newDraft = await response.json();
  await expectView(page, { tab: 'campaigns', record: newDraft.id });
  const child = await f.campaign(newDraft.id);
  expect(child.caption).toBe('Texto actual de la publicación');
  expect(child.deliveries).toEqual([]);
  expect(child.operations).toEqual([]);
  await page.goBack();
  await expectView(page, { tab: 'results', record: record.id });
  await expect(page.getByRole('heading', { name: 'Qué aprendimos' })).toBeVisible();
  await expect(page.getByText('Mejoró según este criterio', { exact: true })).toBeVisible();
  await page.goto(`/admin?section=advertising&tab=campaigns&record=${newDraft.id}`);
  await page.getByRole('button', { name: 'Anterior', exact: true }).click();
  const reads = observeWrites(page);
  try {
    await expect(page.getByText(/Revisa el texto de la versión que alcanzó el criterio/)).toBeVisible();
    await page.getByRole('button', { name: 'Usar esta idea', exact: true }).click();
    await expect(page.getByText(/Se añadió una orientación editable/)).toBeVisible();
    await expect(page.locator('textarea[name="caption"]')).toHaveValue(child.caption);
    expect(reads.writes).toEqual([]);
  } finally { reads.stop(); }
  } finally { await retireResultsConnection(record); }
});

test('aprobación orgánica no publica', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'Escenario aislado de Chromium de escritorio.');
  test.setTimeout(120000);
  const base = new URL(info.project.use.baseURL);
  const env = testDatabaseEnv(), database = new URL(env.DATABASE_URL);
  if (base.protocol !== 'https:' || base.hostname !== 'localhost' ||
      !['localhost', '127.0.0.1'].includes(database.hostname) || env.DB_SSL !== 'verify' ||
      !(env.DB_CA_CERT || env.DB_CA_CERT_FILE) ||
      !['INTEGRATION_SECRETS_DIR', 'SOCIAL_BROWSER_CONTROL_DIR', 'SOCIAL_MEDIA_DIR'].every(name => process.env[name] && isAbsolute(process.env[name]))) {
    throw new Error('La prueba requiere HTTPS localhost, PostgreSQL local descartable con TLS verificado y rutas absolutas de custodia/medios compartidas con el servidor de prueba.');
  }
  // This fixture uses no Meta application, tokens, cookies, or running publication workers.
  await page.context().route('**/*', route => new URL(route.request().url()).origin === base.origin ? route.continue() : route.abort());
  const store = new Store(await openPostgres(databaseConfig(env)));
  let settings, setPublishing;
  try {
    if ((await store.db.get('SELECT current_database() AS name')).name !== 'allnutrition_test' ||
        await store.db.get(`SELECT id FROM ${store.t('social_connections')} LIMIT 1`) ||
        await store.db.get(`SELECT id FROM ${store.t('social_integration_settings')} LIMIT 1`)) {
      throw new Error('La prueba exige un fixture recién sembrado, sin conexiones ni configuración social previa.');
    }
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=? AND active=1`, ['e2e@example.test']);
    expect(actor?.id).toBeTruthy();
    setPublishing = publishingEnabled => saveSocialSettings(store, {
      version: settings?.version || 0, requestId: randomUUID(), publicBaseUrl: base.origin,
      appId: '', loginConfigId: '', browserEnabled: true, publishingEnabled,
    }, actor.id, { allowedOrigins: [base.origin], env: process.env });
    settings = await setPublishing(false);
    const runtime = await loadSocialRuntime(store);
    const connectionId = randomUUID(), assetId = randomUUID(), now = new Date().toISOString();
    const identities = { userId: '100', businessId: '500', pageId: '200', instagramId: '300' };
    const connectionName = 'Cuenta exclusiva de la prueba editorial', assetName = 'Imagen exclusiva de la prueba editorial';
    const record = { version: 1, created_at: now, updated_at: now };
    await insertRow(store, 'social_connections', { id: connectionId, provider: 'meta', integration_method: 'browser', state: 'connected', ...record, data: JSON.stringify({
      name: connectionName, identities, sessionEpoch: 0, validatedAt: now, configurationFingerprint: runtime.fingerprint,
      capabilities: { facebookPublish: true, instagramPublish: true },
      resources: { pages: [{ id: '200', name: 'Página sintética', businessId: '500', instagramId: '300', tasks: ['CREATE_CONTENT'] }] },
    }) });
    await saveCredentials(store, connectionId, { storageState: { cookies: [], origins: [] } }, { runtime });
    const width = 540, height = 675;
    const bytes = await sharp({ create: { width, height, channels: 3, background: '#336699' } }).jpeg().toBuffer();
    const sha256 = createHash('sha256').update(bytes).digest('hex'), derivativeKey = `${assetId}/derivative.jpg`;
    await mkdir(join(runtime.mediaRoot, assetId), { recursive: true, mode: 0o700 });
    await writeFile(join(runtime.mediaRoot, derivativeKey), bytes, { flag: 'wx', mode: 0o600 });
    await insertRow(store, 'social_assets', { id: assetId, state: 'ready', sha256, bytes: bytes.length, ...record, data: JSON.stringify({
      name: assetName, kind: 'image', contentType: 'image/jpeg', derivativeKey, derivativeSha256: sha256,
      derivativeBytes: bytes.length, derivativeContentType: 'image/jpeg', width, height,
    }) });

    const f = await advertisingFixture(page, info);
    expect((await f.get(`${ROOT}/connections`)).connections.map(item => item.id)).toEqual([connectionId]);
    const content = await page.request.get(`${ROOT}/assets/${assetId}/content?variant=derivative`);
    expect(content.ok(), await content.text()).toBe(true);
    expect(await content.body()).toEqual(bytes);
    const caption = 'Texto congelado para Facebook e Instagram.';
    const name = `${f.marker} doble paso`;
    const publishAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const draft = await f.post(`${ROOT}/campaigns`, {
      name, connectionId, assetId, mode: 'organic', objective: 'engagement',
      caption, platforms: ['facebook', 'instagram'], placements: ['facebook_feed', 'instagram_feed'], aiDisclosure: false, publishAt,
    });
    await f.post(`${ROOT}/campaigns/${draft.id}/forecast`, { version: draft.version });
    const editorURL = `/admin?section=advertising&tab=campaigns&record=${draft.id}`;
    const pending = page.getByRole('heading', { name: `${name} · Aprobada, pendiente de publicar`, exact: true });
    const scheduled = page.getByRole('heading', { name: `${name} · Programada`, exact: true });
    const publish = page.getByRole('button', { name: 'Publicar', exact: true });
    const actionsPath = `${ROOT}/campaigns/${draft.id}/actions`;
    const waitForAction = action => page.waitForResponse(response => {
      const request = response.request();
      return request.method() === 'POST' && new URL(response.url()).pathname === actionsPath && request.postDataJSON().action === action;
    });
    const expectNoDeliveries = async () => {
      const detail = await f.campaign(draft.id);
      expect(detail.state).toBe('ready');
      expect(detail.revisions).toHaveLength(1);
      expect(detail.revisions[0].spec).toMatchObject({ connectionId, assetId, caption, publishAt });
      expect(detail.deliveries).toEqual([]);
      expect(detail.operations).toEqual([]);
      return detail;
    };
    await page.goto(editorURL);
    await page.getByRole('button', { name: '3. Revisar y publicar', exact: true }).click();
    const consent = page.getByRole('group', { name: 'Autorización de la revisión' });
    const approval = consent.getByRole('button', { name: 'Aprobar sin publicar', exact: true });
    await expect(approval).toBeDisabled();
    for (const box of await consent.getByRole('checkbox').all()) await box.check();
    const approvalResponse = waitForAction('approve-organic');
    await approval.click();
    const approved = await approvalResponse;
    expect(approved.status(), await approved.text()).toBe(200);
    expect(await approved.json()).toMatchObject({ state: 'ready', revision: 1, deliveryIds: [], operationIds: [], deliveries: [] });
    await expect(pending).toBeVisible();
    await expect(publish).toHaveCount(0);
    await expectNoDeliveries();

    settings = await setPublishing(true);
    await page.reload();
    await expect(pending).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Configuración aprobada · Solo lectura' })).toBeVisible();
    await expect(page.locator('textarea[name="caption"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ver rendimiento', exact: true })).toHaveCount(0);
    await expect(publish).toBeEnabled();
    const frozen = await expectNoDeliveries();
    const writing = observeWrites(page);
    const dialog = page.getByRole('dialog', { name: 'Publicar revisión aprobada' });
    const confirm = dialog.getByRole('button', { name: 'Confirmar publicación', exact: true });
    const permission = dialog.getByRole('checkbox');
    const openPublish = async () => {
      await publish.click();
      await expect(dialog).toBeVisible();
      await expect(permission).not.toBeChecked();
      await expect(confirm).toBeDisabled();
    };
    try {
      await openPublish();
      await expect(dialog.getByText(connectionName, { exact: true })).toBeVisible();
      await expect(dialog.getByText(assetName, { exact: true })).toBeVisible();
      await expect(dialog.getByText(caption, { exact: true })).toBeVisible();
      await expect(dialog.getByText(/Página de Facebook.*Cuenta profesional de Instagram/)).toBeVisible();
      await expect(dialog.getByText('America/Bogota', { exact: true })).toBeVisible();
      await permission.check();
      await dialog.getByRole('button', { name: 'Volver sin ejecutar', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await expectNoDeliveries();
      await openPublish();
      page.once('dialog', prompt => prompt.accept());
      await page.reload();
      await expect(pending).toBeVisible();
      await expect(dialog).toHaveCount(0);
      await expectNoDeliveries();
      expect(writing.writes).toEqual([]);
    } finally { writing.stop(); }

    await openPublish();
    await permission.check();
    const publicationResponse = waitForAction('publish-organic');
    await confirm.click();
    const published = await publicationResponse;
    expect(published.status(), await published.text()).toBe(202);
    const receipt = await published.json(), request = published.request(), payload = request.postDataJSON();
    expect(payload).toEqual({ action: 'publish-organic', version: frozen.version, requestId: expect.any(String), revision: 1, specHash: frozen.revisions[0].specHash, publishAccepted: true });
    expect(receipt.state).toBe('scheduled');
    expect(receipt.deliveryIds).toHaveLength(2);
    expect(new Set(receipt.deliveryIds).size).toBe(2);
    const replay = await page.request.post(actionsPath, { headers: { Origin: base.origin, 'x-csrf-token': await request.headerValue('x-csrf-token') }, data: payload });
    expect(replay.status(), await replay.text()).toBe(202);
    expect(await replay.json()).toEqual(receipt);
    await expect(scheduled).toBeVisible();
    await page.reload();
    await expect(scheduled).toBeVisible();
    await expect(publish).toHaveCount(0);
    const queued = await f.campaign(draft.id);
    expect(queued.revisions).toEqual(frozen.revisions);
    expect(queued.deliveries.map(delivery => delivery.channel)).toEqual(['facebook', 'instagram']);
    expect(queued.deliveries.map(delivery => delivery.id).sort()).toEqual([...receipt.deliveryIds].sort());
    for (const delivery of queued.deliveries) expect(delivery).toMatchObject({ state: 'scheduled', remoteId: null, publishRequestedBy: actor.id });
  } finally {
    try { if (settings?.publishingEnabled) await setPublishing(false); }
    finally { await store.close(); }
  }
});
