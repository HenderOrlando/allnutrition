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
import { saveSocialSettings } from '../../lib/business/social-settings.mjs';
import { loadSocialRuntime } from '../../lib/social/config.mjs';
import { saveCredentials } from '../../lib/social/credentials.mjs';
import { test, expect } from '@playwright/test';
import sharp from 'sharp';
import { login, navigate, selectWorkspace, openDisclosure, signOut } from './helpers.mjs';
import { catalogTag, seedResults } from './social-results-fixture.mjs';

const ROOT = '/api/admin/social';
const controlledImages = process.env.ADVERTISING_IMAGE_E2E_URL;
const imageProject = process.env.ADVERTISING_IMAGE_COMPOSE_PROJECT;


function runGuidedFixture(script, args, extra = []) {
  const project = imageProject, origin = controlledImages;
  expect(project).toMatch(/^allnutrition-guided-image-[a-z0-9-]+$/);
  expect(origin).toMatch(/^https:\/\/localhost:\d+$/);
  expect(origin).not.toBe(process.env.E2E_BASE_URL);
  const result = spawnSync('docker', ['exec', `${project}-web-1`, 'node', `./tests/e2e/${script}.mjs`, ...args, origin, ...extra], { encoding: 'utf8', timeout: 30000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split('\n').at(-1);
}

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
  await workspace.getByRole('button', { name: 'Volver a la biblioteca', exact: true }).click();
  await expectView(page, { record: null });
}

async function beginDraft(page, mode = 'organic') {
  await page.getByRole('button', { name: 'Crear publicación o campaña', exact: true }).click();
  await page.getByRole('button', { name: 'Definir primero, sin imagen aún', exact: true }).click();
  await page.getByRole('button', { name: mode === 'paid' ? 'Anuncio pagado' : 'Publicación sin inversión', exact: true }).click();
}

async function chooseOptions(page, triggerName, title, names) {
  await page.getByRole('button', { name: triggerName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: title });
  for (const name of names) await dialog.getByRole('checkbox', { name, exact: true }).check();
  await dialog.getByRole('button', { name: 'Aplicar', exact: true }).click();
}

async function expectNoOverflow(page) {
  expect(await page.locator('html').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1);
}

async function captureAdvertisingSurface(page, info, name) {
  await expectNoOverflow(page);
  if (process.env.ADVERTISING_UX_PROOFS) {
    await page.screenshot({ path: join(process.env.ADVERTISING_UX_PROOFS, `${info.project.name}-${name}.png`) });
  }
}

test('publicidad guiada: guardar y organizar sin publicar', async ({ page }, info) => {
  test.setTimeout(180000);
  const f = await advertisingFixture(page, info);
  const name = `${f.marker} idea`, unsavedName = `${f.marker} cambio sin guardar`;
  await navigate(page, 'Publicidad');
  const start = page.getByRole('region', { name: 'Prepara tu próxima publicación' });
  await expect(start.getByRole('list', { name: 'Recorrido de una publicación' }).getByRole('listitem')).toHaveCount(3);
  await expect(start.getByRole('button', { name: 'Crear publicación o campaña' })).toBeInViewport();
  const advertisingTabs = page.getByRole('navigation', { name: 'Vistas de publicidad', exact: true });
  await expect(advertisingTabs.getByRole('button', { name: 'Cuentas conectadas', exact: true })).toHaveCount(0);
  await expect(advertisingTabs.locator('option[value="connections"]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Conectar con Facebook', exact: true })).toHaveCount(0);
  await beginDraft(page);
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
    await page.locator('textarea[name="caption"]').fill(caption);
    await page.getByRole('button', { name: 'Continuar a revisión', exact: true }).click();
    await expect(steps.getByRole('button').nth(1)).toHaveAttribute('aria-current', 'step');
    await expect(page.getByRole('heading', { name: 'Paso 2 de 2 · Revisar y publicar' })).toBeFocused();
    const requirements = page.getByRole('region', { name: 'Qué falta antes de aprobar' });
    await expect(requirements).toContainText(/Todavía no hay cuentas conectadas|Selecciona una cuenta de Facebook o Instagram/);
    await expect(requirements.getByRole('button', { name: /^(Conectar en Redes sociales|Elegir cuenta)$/ })).toBeVisible();
    await requirements.getByRole('button', { name: 'Elegir mercados' }).press('Enter');
    await expect(page.getByRole('button', { name: 'Elegir mercados', exact: true })).toBeFocused();
    await expect(steps.getByRole('button').first()).toHaveAttribute('aria-current', 'step');
    await expect(nameInput).toHaveValue(name);
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
    const guide = page.locator('#advertising-guide');
    await page.getByRole('button', { name: 'Ver guía', exact: true }).press('Enter');
    await expect(guide.locator(':scope > summary')).toBeFocused();
    await expect(guide).toHaveAttribute('open', '');
    await guide.locator(':scope > summary').press('Space');
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
  const startUpload = page.getByRole('button', { name: 'Subir archivo privado', exact: true });
  const uploadDialog = page.getByRole('dialog', { name: 'Subir archivo privado' });
  await startUpload.click();
  await expect(uploadDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(uploadDialog).not.toBeVisible();
  await expect(startUpload).toBeFocused();
  await startUpload.click();
  await expect(uploadDialog.getByRole('button', { name: 'Subir archivo', exact: true })).toBeInViewport({ ratio: 1 });
  await captureAdvertisingSurface(page, info, 'biblioteca-carga');
  const picking = page.waitForEvent('filechooser');
  await uploadDialog.getByRole('button', { name: 'Seleccionar archivo', exact: true }).click();
  await (await picking).setFiles({ name: originalName, mimeType: 'image/png', buffer: png });
  await expect(uploadDialog.getByText(originalName, { exact: true })).toBeVisible();
  await uploadDialog.getByRole('textbox', { name: /^Nombre para encontrarlo después/ }).fill(name);
  const reserving = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/assets` && response.request().method() === 'POST');
  const uploading = page.waitForResponse(response => /^\/api\/admin\/social\/assets\/[^/]+\/content$/.test(new URL(response.url()).pathname) && response.request().method() === 'PUT');
  await uploadDialog.getByRole('button', { name: 'Subir archivo', exact: true }).click();
  const reservedResponse = await reserving;
  expect(reservedResponse.ok(), await reservedResponse.text()).toBe(true);
  const reserved = await reservedResponse.json(), uploadedResponse = await uploading;
  expect(uploadedResponse.status(), await uploadedResponse.text()).toBe(202);
  expect(['processing', 'ready']).toContain((await uploadedResponse.json()).state);
  await uploadDialog.getByRole('button', { name: 'Cerrar carga', exact: true }).click();
  await expect(uploadDialog).not.toBeVisible();
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
  await card(page, name).scrollIntoViewIfNeeded();
  await captureAdvertisingSurface(page, info, 'biblioteca-galeria');
  await card(page, name).getByRole('button', { name: 'Ver archivo', exact: true }).click();
  await expectView(page, { record: ready.id, q: f.marker, status: 'ready' });
  await expectPreview(page, ready.id);
  await expect(page.getByRole('heading', { name, exact: true })).toBeFocused();
  await captureAdvertisingSurface(page, info, 'biblioteca-ficha');
  await closeAsset(page);
  await expect(card(page, name).getByRole('button', { name: 'Ver archivo', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Limpiar filtros', exact: true }).click();
  await expectView(page, { record: null, q: null, status: null, page: null });
  await expect(search).toBeFocused();
  await search.fill(f.marker);
  await state.selectOption('ready');
  await expectView(page, { q: f.marker, status: 'ready' });

  await card(page, name).getByRole('button', { name: 'Ver archivo', exact: true }).click();
  const archiveTrigger = page.getByRole('button', { name: 'Archivar archivo', exact: true });
  await archiveTrigger.click();
  const archiveDialog = page.getByRole('dialog', { name: /^¿Archivar/ });
  await expect(archiveDialog.getByRole('button', { name: 'Cancelar', exact: true })).toBeFocused();
  await archiveDialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
  await expect(archiveTrigger).toBeFocused();
  await archiveTrigger.click();
  await captureAdvertisingSurface(page, info, 'biblioteca-archivar');
  const archiving = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/assets/${ready.id}/actions` && response.request().method() === 'POST');
  await archiveDialog.getByRole('button', { name: 'Sí, archivar archivo', exact: true }).click();
  const archiveResponse = await archiving;
  expect(archiveResponse.ok(), await archiveResponse.text()).toBe(true);
  await expect(archiveDialog).not.toBeVisible();
  await closeAsset(page);
  await expect(card(page, name)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No hay imágenes o videos con estos filtros', exact: true })).toBeVisible();
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
  await page.getByRole('button', { name: 'Crear publicación o campaña', exact: true }).click();
  await page.getByRole('button', { name: 'Elegir de biblioteca', exact: true }).click();
  const selector = page.getByRole('combobox', { name: 'Archivo de biblioteca', exact: true });
  await expect(selector).toBeVisible();
  await expect(selector.locator(`option[value="${ready.id}"]`)).toHaveCount(0);
});

test('estudio de publicaciones: oferta y foto propia sin IA en el mismo borrador', async ({ page }, info) => {
  test.setTimeout(180000);
  const f = await advertisingFixture(page, info), tag = catalogTag(f.marker);
  const normal = { status: 'draft', orderable: true, presentation: '500 g', price: 23000, stockQuantity: 20 };
  const title = `Suplemento ${tag}`;
  const cacao = await f.post('/api/admin/products', { ...normal, title, slug: `cacao-${tag}`, flavor: `Cacao ${tag}`, sku: `CA-${tag}` });
  const vanilla = await f.post('/api/admin/products', { ...normal, title, presentation: '30 g', slug: `vainilla-${tag}`, flavor: `Vainilla ${tag}`, sku: `VA-${tag}` });
  const gift = await f.post('/api/admin/products', { ...normal, title: `Muestra ${tag}`, slug: `muestra-${tag}`, presentation: '30 g', flavor: 'Vainilla', productType: 'gift', price: 0, items: [{ productId: vanilla.id, quantity: 1 }] });
  const combo = await f.post('/api/admin/combos', { title: `Dúo ${tag}`, slug: `duo-${tag}`, status: 'draft', orderable: true, price: 52000, conditions: 'Dos unidades de la misma referencia', items: [{ productId: cacao.id, quantity: 2 }] });
  await navigate(page, 'Publicidad');
  await beginDraft(page);
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
  const caption = page.locator('textarea[name="caption"]');
  await caption.fill('Conoce el combo exacto y pregunta por WhatsApp.');
  await page.getByRole('button', { name: 'Continuar a revisión', exact: true }).click();
  await page.getByRole('button', { name: 'Editar definición', exact: true }).click();
  await expect(page.locator('textarea[name="giftCondition"]')).toHaveValue(condition);
  await expect(caption).toHaveValue('Conoce el combo exacto y pregunta por WhatsApp.');
  expect(writes.writes).toEqual([]);

  const draftResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/campaigns` && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
  const savedResponse = await draftResponse;
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  const saved = await savedResponse.json();
  await expectView(page, { record: saved.id });
  await expect(page.getByRole('heading', { name: 'Paso 1 de 2 · Definir publicación' })).toBeVisible();
  await expect(page.getByText('Invita a consultar por WhatsApp', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Abrir estudio visual', exact: true }).click();
  const composer = page.getByRole('region', { name: 'Estudio visual', exact: true });
  await expect(composer.getByText('No está configurado el servicio de imágenes.', { exact: false })).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Enviar idea', exact: true })).toHaveCount(0);
  const contextName = 'Datos y fotos para preparar imagen';
  await composer.getByRole('button', { name: contextName, exact: true }).click();
  const context = page.getByRole('dialog', { name: contextName, exact: true });
  await expect(context.getByText(condition, { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(context).toHaveCount(0);
  expect((await f.get(`${ROOT}/generation?campaignId=${saved.id}`)).jobs).toEqual([]);
  expect(writes.writes.filter(item => new URL(item.url).pathname === `${ROOT}/generation`)).toEqual([]);
  expectUnpublished(await f.campaign(saved.id));

  await composer.getByRole('button', { name: 'Adjuntar foto o video', exact: true }).click();
  const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#226644' } }).png().toBuffer();
  await page.getByLabel('Archivo de imagen o video', { exact: true }).setInputFiles({ name: `duo-${tag}.png`, mimeType: 'image/png', buffer: png });
  const uploaded = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/content') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Subir archivo', exact: true }).click();
  const response = await uploaded;
  expect(response.ok(), await response.text()).toBe(true);
  const file = await response.json();
  await expect.poll(async () => (await f.asset(file.id)).state, {
    message: 'El scheduler del fixture principal debe procesar la foto subida',
    timeout: 90_000,
  }).toBe('ready');
  const useOriginal = composer.getByRole('button', { name: 'Usar esta pieza y continuar', exact: true });
  await expect(useOriginal).toBeEnabled({ timeout: 120000 });
  await expect.poll(() => page.locator(`img[src*="/assets/${file.id}/content"]`).first().evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  expect((await f.campaign(saved.id)).assetId).toBeNull();
  await useOriginal.click();
  // The thread selection is async; closing the studio changes the mobile layout.
  await expect(composer).toHaveCount(0);
  const saveDraft = page.getByRole('button', { name: 'Guardar borrador', exact: true });
  await expect(saveDraft).toBeFocused();
  const commit = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/campaigns/${saved.id}` && response.request().method() === 'PATCH');
  await saveDraft.click();
  expect((await commit).ok()).toBe(true);
  await page.reload();
  await expect(page.locator('textarea[name="giftCondition"]')).toHaveValue(condition);
  await expect(page.locator(`img[src*="/assets/${file.id}/content"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Continuar a revisión', exact: true }).click();
  await expect(page.getByLabel('Presupuesto total (no diario)', { exact: false })).toHaveCount(0);
  await expect(page.getByText('Por comprobar: elige la cuenta', { exact: false })).toBeVisible();
  await expectNoOverflow(page);
  await page.getByRole('region', { name: 'Qué falta antes de aprobar' }).getByRole('button', { name: 'Elegir mercados', exact: true }).click();
  const marketTrigger = page.getByRole('button', { name: 'Elegir mercados', exact: true });
  await expect(marketTrigger).toBeFocused();
  await expect(marketTrigger).toHaveAccessibleDescription('Ningún país elegido');
  const market = page.getByRole('dialog', { name: '¿En qué país o países quieres publicar?' });
  await marketTrigger.press('Enter');
  await market.getByRole('searchbox', { name: 'Buscar país' }).fill('Mexico');
  await market.getByRole('checkbox', { name: 'México (MX)', exact: true }).check();
  await expectNoOverflow(page);
  await page.keyboard.press('Escape');
  await expect(market).toHaveCount(0);
  await expect(marketTrigger).toBeFocused();
  await expect(marketTrigger).toHaveAccessibleDescription('Ningún país elegido');
  await marketTrigger.click();
  await market.getByRole('searchbox', { name: 'Buscar país' }).fill('Mexico');
  await market.getByRole('checkbox', { name: 'México (MX)', exact: true }).check();
  await market.getByRole('button', { name: 'Aplicar', exact: true }).click();
  await expect(marketTrigger).toHaveAccessibleDescription('México (MX)');
  await page.getByRole('button', { name: 'Continuar a revisión', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Qué falta antes de aprobar' }).getByRole('button', { name: 'Elegir mercados', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Editar definición', exact: true }).click();
  await page.getByRole('radio', { name: /^Anuncio pagado/ }).check();
  await expect(page.getByLabel('Presupuesto total (no diario)', { exact: false })).toBeVisible();
  const persisted = await f.campaign(saved.id);
  expect(persisted).toMatchObject({ state: 'draft', mode: 'organic', assetId: file.id, deliveries: [], operations: [], revisions: [], offerSnapshot: { primary: { id: combo.id, price: 52000, components: [{ id: cacao.id, quantity: 2 }] }, gift: { id: gift.id, price: 0, condition } } });
  expect(writes.writes.filter(item => new URL(item.url).pathname === `${ROOT}/generation`)).toEqual([]);
  expect(await page.locator('html').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1);
  writes.stop();
});

test.describe('estudio de publicaciones · transporte sintético aislado', () => {
  test.use({ baseURL: controlledImages });
  test.skip(!controlledImages || !imageProject, 'Requiere un segundo fixture descartable HTTPS, con scheduler ordinario detenido.');
  const worker = (action, id = '-') => runGuidedFixture('guided-image-worker', [action, id]);
  const remote = (action, id = '-') => JSON.parse(runGuidedFixture('guided-publication-worker', [action, id]));
  const provider = action => runGuidedFixture('guided-audience-provider', [action]);
  const actionButton = (page, label) => page.getByRole('button', { name: label, exact: true });
  async function submit(page, path, button, action) {
    const waited = page.waitForResponse(response => {
      const request = response.request();
      return request.method() === 'POST' && new URL(response.url()).pathname === path && (!action || request.postDataJSON().action === action);
    });
    await button.click();
    const response = await waited;
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  }
  async function pickMarket(page, label) {
    await actionButton(page, 'Elegir mercados').click();
    const dialog = page.getByRole('dialog', { name: '¿En qué país o países quieres publicar?' });
    await dialog.getByRole('searchbox', { name: 'Buscar país' }).fill(label);
    await dialog.getByRole('checkbox', { name: new RegExp(`^${label} \\(`) }).check();
    await actionButton(dialog, 'Aplicar').click();
  }
  async function approveReview(page, id, label, action) {
    const approvals = page.getByRole('group', { name: 'Autorización de la revisión' });
    const button = actionButton(approvals, label);
    await expect(button).toBeDisabled();
    for (const box of await approvals.getByRole('checkbox').all()) await box.check();
    return submit(page, `${ROOT}/campaigns/${id}/actions`, button, action);
  }
  const dateTime = date => new Date(date - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  async function generate(page, f, composer, { campaignId, baseAssetId = null, reference }) {
    const submit = composer.getByRole('button', { name: baseAssetId ? 'Enviar ajuste' : 'Enviar idea', exact: true });
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await composer.getByRole('checkbox', { name: /^Autorizo el envío/ }).check();
    const posted = page.waitForResponse(response => new URL(response.url()).pathname === `${ROOT}/generation` && response.request().method() === 'POST');
    await submit.click();
    const response = await posted;
    expect(response.status(), await response.text()).toBe(202);
    const job = await response.json();
    expect(job).toMatchObject({ campaignId, baseAssetId });
    if (reference) expect(response.request().postDataJSON().sources).toEqual([{ kind: 'asset', id: reference.id, version: reference.version }]);
    runGuidedFixture('guided-image-worker', ['generation', job.id], reference ? [reference.id] : []);
    const ready = await f.get(`${ROOT}/generation/${job.id}`);
    expect(ready.asset.state).toBe('ready');
    const derivative = await page.request.get(ready.asset.previewUrl);
    expect((await sharp(await derivative.body()).metadata()).format).toBe('jpeg');
    if (campaignId) expect((await f.campaign(campaignId)).assetId).toBeNull();
    return ready.asset;
  }

  test('chat creativo: conversación, contexto y referencias por turno', async ({ page }, info) => {
    test.setTimeout(120000);
    const f = await advertisingFixture(page, info);
    worker('configure');
    await navigate(page, 'Publicidad');
    const reading = observeWrites(page);
    const generations = () => reading.writes.filter(({ url }) => new URL(url).pathname === `${ROOT}/generation`);
    try {
      await actionButton(page, 'Crear publicación o campaña').click();
      const chat = page.getByRole('region', { name: 'Chat creativo', exact: true });
      const input = chat.getByRole('textbox', { name: 'Escríbele a Ali', exact: true });
      const contextName = 'Datos y fotos para preparar imagen';
      const trigger = actionButton(chat, contextName);
      const dialog = page.getByRole('dialog', { name: contextName });
      const first = 'Ali, quiero un fondo claro y con espacio para el título.';
      const second = 'Conserva el encuadre y toma los colores de la foto adjunta.';
      const filename = 'Paleta bosque.png';
      await expect(chat.getByText(/^Hola, soy Ali/)).toBeVisible();
      await input.fill(first);
      await trigger.click();
      await expect(dialog.getByRole('heading', { name: contextName })).toBeFocused();
      await expect(dialog.getByRole('region', { name: 'Datos de marca y campaña' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await expect(input).toHaveValue(first);
      expect(generations()).toHaveLength(0);
      const original = await generate(page, f, chat, { campaignId: null });
      await expect(chat.getByText(/^Ya tengo una versión para ti/)).toBeVisible();
      await input.fill(second);
      const authorize = chat.getByRole('checkbox', { name: /^Autorizo el envío/ });
      await authorize.check();
      await actionButton(chat, 'Adjuntar foto').click();
      const bytes = await sharp({ create: { width: 480, height: 480, channels: 3, background: '#237454' } }).png().toBuffer();
      await dialog.getByLabel('Archivo de imagen', { exact: true }).setInputFiles({ name: filename, mimeType: 'image/png', buffer: bytes });
      const uploaded = page.waitForResponse(response => response.request().method() === 'PUT' && /\/assets\/[^/]+\/content$/.test(new URL(response.url()).pathname));
      await actionButton(dialog, 'Adjuntar al turno').click();
      const uploadResponse = await uploaded;
      expect(uploadResponse.ok(), await uploadResponse.text()).toBe(true);
      const { id: assetId } = await uploadResponse.json();
      worker('asset', assetId);
      const photos = dialog.getByRole('list', { name: 'Fotos adjuntas en el chat' });
      await expect(photos.getByRole('button', { name: `Quitar ${filename}`, exact: true })).toBeVisible();
      await expect(photos.getByText('Referencia para el próximo envío')).toBeVisible();
      await expect(dialog.getByRole('img', { name: 'Imagen a modificar', exact: true })).toBeVisible();
      await actionButton(dialog, 'Volver al chat').click();
      await expect(authorize).not.toBeChecked();
      await expect(input).toHaveValue(second);
      await expect(actionButton(chat, 'Enviar ajuste')).toBeDisabled();
      await authorize.check();
      await authorize.uncheck();
      await expect(actionButton(chat, 'Enviar ajuste')).toBeDisabled();
      await input.press('Control+Enter');
      expect(generations()).toHaveLength(1);
      await trigger.click();
      await expect(photos.getByRole('button', { name: `Quitar ${filename}`, exact: true })).toBeVisible();
      await captureAdvertisingSurface(page, info, 'ali-chat-contexto');
      await actionButton(dialog, 'Volver al chat').click();
      const reference = await f.asset(assetId);
      await generate(page, f, chat, { campaignId: null, baseAssetId: original.id, reference });
      const transcript = chat.getByRole('list', { name: 'Turnos del chat' });
      await expect(transcript.getByRole('listitem')).toHaveCount(2);
      await expect(transcript.getByRole('listitem').first()).toContainText(first);
      await expect(transcript.getByRole('listitem').last()).toContainText(second);
      await expect(transcript.getByText('Tú', { exact: true })).toHaveCount(2);
      await expect(transcript.getByText('Ali', { exact: true })).toHaveCount(2);
      await expect(transcript.getByText(/^Ya tengo una versión para ti/)).toHaveCount(2);
      await expect(authorize).not.toBeChecked();
      expect(generations()).toHaveLength(2);
      expect(reading.writes.some(({ url }) => /\/campaigns(?:\/|$)/.test(new URL(url).pathname))).toBe(false);
      await chat.getByRole('heading', { name: 'Chat creativo' }).scrollIntoViewIfNeeded();
      await captureAdvertisingSurface(page, info, 'ali-chat-conversacion');
    } finally { reading.stop(); }
  });

  test('idea, ajuste exacto, recarga, publicación de Instagram y cero comprobado sin reenviar', async ({ page }, info) => {
    test.setTimeout(180000);
    const f = await advertisingFixture(page, info);
    worker('configure');
    const { connectionId } = remote('configure');
    await navigate(page, 'Publicidad');
    const opening = observeWrites(page);
    await page.getByRole('button', { name: 'Crear publicación o campaña', exact: true }).click();
    const composer = page.getByRole('region', { name: 'Estudio visual', exact: true });
    const chat = composer.getByRole('region', { name: 'Chat creativo', exact: true });
    const preview = composer.getByRole('region', { name: 'Tu pieza', exact: true });
    await expect(composer.getByRole('heading', { name: 'Estudio visual' })).toBeFocused();
    const example = composer.getByRole('button', { name: /^Muestra el producto sobre un fondo claro/ });
    await example.focus();
    await page.keyboard.press('Enter');
    const idea = chat.getByRole('textbox', { name: 'Escríbele a Ali', exact: true });
    await expect(idea).toBeFocused();
    await expect(idea).toHaveValue(/Muestra el producto/);
    expect(opening.writes).toEqual([]);
    opening.stop();
    const ideaText = 'Fondo liso con espacio para una pieza nueva.';
    await idea.fill(ideaText);
    const original = await generate(page, f, composer, { campaignId: null });
    await expect(page).toHaveURL(url => url.searchParams.get('record') === 'new' && Boolean(url.searchParams.get('studio')));
    const threadId = new URL(page.url()).searchParams.get('studio');
    expect(new URL(page.url()).searchParams.toString()).not.toContain('Fondo');
    await expect(chat.getByText(ideaText, { exact: true })).toBeVisible();
    const adjust = composer.getByRole('textbox', { name: 'Escríbele a Ali', exact: true });
    await adjust.fill('Aclara el fondo, conserva la etiqueta.');
    const variant = await generate(page, f, composer, { campaignId: null, baseAssetId: original.id });
    expect(variant.id).not.toBe(original.id);
    expect(variant.sha256).not.toBe(original.sha256);
    const history = await f.get(`${ROOT}/creative-threads/${threadId}`);
    expect(history.turns).toEqual(expect.arrayContaining([expect.objectContaining({ baseAssetId: original.id, prompt: 'Aclara el fondo, conserva la etiqueta.' })]));
    expect(history.turns).toHaveLength(2);
    expect(history.thread.campaignId).toBeNull();
    await page.reload();
    await expect(chat.getByText('Aclara el fondo, conserva la etiqueta.', { exact: true })).toBeVisible();
    await expect(chat.getByText(ideaText, { exact: true })).toHaveCount(1);
    await expect(preview.getByRole('button', { name: /^Original/ })).toBeVisible();
    const bounds = { chat: await chat.boundingBox(), preview: await preview.boundingBox() };
    if (info.project.name === 'mobile') {
      expect(bounds.chat.y).toBeLessThan(bounds.preview.y);
      await preview.getByRole('button', { name: 'Ampliar vista previa' }).click();
      await expect(preview.getByRole('button', { name: 'Reducir vista previa' })).toBeVisible();
    } else expect(bounds.chat.x).toBeLessThan(bounds.preview.x);
    expect(await page.locator('html').evaluate(root => root.scrollWidth - root.clientWidth)).toBeLessThanOrEqual(1);
    await preview.getByRole('button', { name: 'Comparar con el original' }).click();
    await expect(preview.getByRole('img', { name: 'Archivo original' })).toHaveAttribute('src', new RegExp(`/assets/${original.id}/content`));
    await expect(preview.getByRole('button', { name: 'Usar esta pieza y continuar' })).toBeDisabled();
    await preview.getByRole('button', { name: 'Volver al archivo preparado' }).click();
    await preview.getByRole('button', { name: 'Usar esta pieza y continuar' }).click();
    await expect(page.getByRole('heading', { name: '¿Qué quieres publicar?' })).toBeFocused();
    await page.getByRole('button', { name: 'Publicación sin inversión', exact: true }).click();
    await page.locator('input[name="name"]').fill(`${f.marker} post`);
    await page.locator('select[name="connectionId"]').selectOption(connectionId);
    await chooseOptions(page, 'Elegir redes', 'Redes donde saldrá', [/^Cuenta profesional de Instagram(?: ·|$)/]);
    await chooseOptions(page, 'Elegir ubicaciones', 'Ubicaciones', ['Instagram · Feed']);
    await pickMarket(page, 'México');
    await page.locator('textarea[name="caption"]').fill('Observa la presentación y comparte qué detalle te interesa.');
    const saved = page.waitForResponse(result => new URL(result.url()).pathname === `${ROOT}/campaigns` && result.request().method() === 'POST');
    await page.getByRole('button', { name: 'Guardar borrador', exact: true }).click();
    const result = await saved;
    expect(result.ok(), await result.text()).toBe(true);
    const campaign = await result.json();
    await expectView(page, { record: campaign.id, studio: null });
    expect(await f.campaign(campaign.id)).toMatchObject({ mode: 'organic', marketCountries: ['MX'], assetId: variant.id, aiDisclosure: true, state: 'draft', deliveries: [], revisions: [] });
    expect((await f.get(`${ROOT}/creative-threads/${threadId}`)).thread).toMatchObject({ campaignId: campaign.id, selectedAsset: { id: variant.id, sha256: variant.sha256, version: variant.version } });
    expect((await f.asset(original.id)).sha256).toBe(original.sha256);
    await actionButton(page, '2. Revisar y publicar').click();
    await expect(page.getByRole('heading', { name: /^Cuenta profesional de Instagram ·/ })).toBeVisible();
    await submit(page, `${ROOT}/campaigns/${campaign.id}/forecast`, actionButton(page, 'Guardar y obtener estimación'));
    await approveReview(page, campaign.id, 'Aprobar sin publicar', 'approve-organic');
    const approved = await f.campaign(campaign.id);
    expect(approved).toMatchObject({ state: 'ready', deliveries: [], operations: [], revisions: [{ spec: { marketCountries: ['MX'], platforms: ['instagram'], assetId: variant.id, aiDisclosure: true } }] });
    await expect(actionButton(page, 'Publicar')).toBeFocused();
    await actionButton(page, 'Publicar').click();
    const dialog = page.getByRole('dialog', { name: 'Publicar revisión aprobada', exact: true });
    await expect(dialog.getByText('Cuando se procese en segundo plano', { exact: true })).toBeVisible();
    const confirm = actionButton(dialog, 'Confirmar publicación');
    await expect(confirm).toBeDisabled();
    await dialog.getByRole('checkbox').check();
    await submit(page, `${ROOT}/campaigns/${campaign.id}/actions`, confirm, 'publish-organic');
    await expect(actionButton(page, 'Ver resultados')).toHaveCount(0);
    const lost = remote('publish-uncertain', campaign.id);
    expect(lost).toMatchObject({ state: 'uncertain', remoteId: null });
    await page.reload();
    await submit(page, `${ROOT}/campaigns/${campaign.id}/actions`, actionButton(page, 'Comprobar en Meta sin reenviar'), 'reconcile');
    const reconciled = remote('reconcile', campaign.id);
    expect(reconciled).toMatchObject({ state: 'published', operationId: lost.operationId, deliveryId: lost.deliveryId, remoteId: expect.any(String) });
    await page.reload();
    const readOnly = observeWrites(page);
    await actionButton(page, 'Ver resultados').click();
    await expectView(page, { tab: 'results', record: campaign.id });
    const metaPerformance = page.getByRole('region', { name: 'Rendimiento reportado por Meta', exact: true });
    await expect(metaPerformance).toBeVisible();
    await expect(metaPerformance.getByText('0', { exact: true })).toHaveCount(0);
    expect(readOnly.writes).toEqual([]);
    readOnly.stop();
    await openDisclosure(page, /^Operaciones de la entrega$/);
    const metricsPath = `${ROOT}/campaigns/${campaign.id}/actions`;
    const beforeConsent = observeWrites(page);
    await actionButton(page, 'Actualizar desde Meta').click();
    const metricsConsent = page.getByRole('dialog', { name: 'Autorizar consulta de métricas a Meta', exact: true });
    await expect(metricsConsent).toBeVisible();
    expect(beforeConsent.writes.filter(({ url }) => new URL(url).pathname === metricsPath)).toEqual([]);
    beforeConsent.stop();
    await submit(page, metricsPath, actionButton(metricsConsent, 'Autorizar consulta a Meta'), 'sync');
    const measured = remote('measure', campaign.id);
    expect(measured.measurementId).toEqual(expect.any(String));
    await page.reload();
    await expect(metaPerformance.getByText('0', { exact: true }).first()).toBeVisible();
    await openDisclosure(page, /^Evidencia y acciones de las recomendaciones$/);
    await submit(page, `${ROOT}/campaigns/${campaign.id}/actions`, actionButton(page, 'Revisar mejoras'), 'analyze');
    remote('analyze', campaign.id);
    await page.reload();
    await openDisclosure(page, /^Evidencia y acciones de las recomendaciones$/);
    await expect(page.getByRole('heading', { name: 'Falta evidencia suficiente' })).toBeVisible();
    const originalPost = await f.campaign(campaign.id);
    expect(originalPost.revisions).toEqual(approved.revisions);
    expect(originalPost.deliveries).toMatchObject([{ id: lost.deliveryId, state: 'published', remoteId: reconciled.remoteId }]);
  });

  test('foto propia, pauta México y Perú, IA opcional y zona manual sin ampliación', async ({ page }, info) => {
    test.setTimeout(180000);
    const f = await advertisingFixture(page, info);
    const { connectionId } = remote('configure');
    provider('configure');
    try {
      await navigate(page, 'Publicidad');
      await actionButton(page, 'Crear publicación o campaña').click();
      const composer = page.getByRole('region', { name: 'Estudio visual', exact: true });
      await actionButton(composer, 'Adjuntar foto o video').click();
      const png = await sharp({ create: { width: 400, height: 500, channels: 3, background: '#448033' } }).png().toBuffer();
      await page.getByLabel('Archivo de imagen o video', { exact: true }).setInputFiles({ name: 'foto-propia.png', mimeType: 'image/png', buffer: png });
      const upload = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/content') && response.request().method() === 'PUT');
      const attaching = page.waitForResponse(result => new URL(result.url()).pathname.startsWith(`${ROOT}/creative-threads/`) && result.request().method() === 'PATCH');
      await actionButton(page, 'Subir archivo').click();
      const image = await (await upload).json();
      expect((await attaching).ok()).toBe(true);
      worker('asset', image.id);
      await actionButton(composer, 'Usar esta pieza y continuar').click();
      await actionButton(page, 'Anuncio pagado').click();
      const writes = observeWrites(page);
      await expect(actionButton(page, 'Definir con IA')).toHaveCount(0);
      expect(writes.writes).toEqual([]);
      writes.stop();
      await page.locator('input[name="name"]').fill(`${f.marker} pauta`);
      await page.locator('select[name="connectionId"]').selectOption(connectionId);
      await chooseOptions(page, 'Elegir redes', 'Redes donde saldrá', [/^Página de Facebook(?: ·|$)/]);
      await chooseOptions(page, 'Elegir ubicaciones', 'Ubicaciones', ['Facebook · Feed']);
      await page.locator('textarea[name="caption"]').fill('Conoce la pieza de este ensayo sin cargos.');
      await page.locator('select[name="aiDisclosure"]').selectOption('false');
      await pickMarket(page, 'México');
      await pickMarket(page, 'Perú');
      await page.getByLabel('Presupuesto total (no diario)', { exact: false }).fill('90000');
      await page.locator('input[name="startAt"]').fill(dateTime(new Date(Date.now() + 3600000)));
      await page.locator('input[name="endAt"]').fill(dateTime(new Date(Date.now() + 3 * 86400000)));
      const draft = await submit(page, `${ROOT}/campaigns`, actionButton(page, 'Guardar borrador'));
      const path = `${ROOT}/campaigns/${draft.id}`, actions = `${path}/actions`, audiencePath = `${path}/audience`, preflight = `${path}/browser-preflight`;
      await expectView(page, { record: draft.id });
      await actionButton(page, '1. Definir publicación').click();
      await actionButton(page, 'Definir con IA').click();
      await expect(page.getByText('openai-compatible · guided-audience-synthetic', { exact: false })).toBeVisible();
      await expect(page.getByText(/Mercados: México \(MX\), Perú \(PE\)/)).toBeVisible();
      const requestAI = actionButton(page, 'Solicitar audiencia con IA');
      await expect(requestAI).toBeDisabled();
      await page.getByRole('checkbox', { name: /^Autorizo esta consulta/ }).check();
      const automatic = await submit(page, audiencePath, requestAI, 'propose');
      expect(automatic).toMatchObject({ status: 'proposed', mode: 'automatic', proposal: { age: { before: [18, 65], after: [23, 55] } } });
      expect(await f.campaign(draft.id)).toMatchObject({ version: draft.version, audience: { countries: [], ageMin: 18 } });
      const applyAutomatic = actionButton(page, 'Aplicar solo diferencias elegidas');
      await expect(applyAutomatic).toBeDisabled();
      await page.getByRole('checkbox', { name: /^Usar los mercados confirmados como países completos/ }).check();
      await page.getByRole('checkbox', { name: 'Aplicar el cambio de edad', exact: true }).check();
      await submit(page, audiencePath, applyAutomatic, 'apply');
      await expect(page.getByText(/^Audiencia guardada: Definida con IA/)).toBeVisible();
      expect(await f.campaign(draft.id)).toMatchObject({ marketCountries: ['MX', 'PE'], audienceMode: 'automatic', audience: { countries: ['MX', 'PE'], ageMin: 23 } });

      await actionButton(page, 'Definir yo').click();
      await page.getByRole('checkbox', { name: /^Acepto crear un borrador privado/ }).check();
      await submit(page, preflight, actionButton(page, 'Guardar y preparar borrador privado'));
      expect(remote('preflight', draft.id).stage).toBe('prepare');
      await page.reload();
      await actionButton(page, '1. Definir publicación').click();
      await actionButton(page, 'Definir yo').click();
      const saveEdits = async () => {
        const saved = page.waitForResponse(response => response.request().method() === 'PATCH' && new URL(response.url()).pathname === path);
        await page.locator('button[type="submit"]').filter({ hasText: /^Guardar borrador$/ }).click();
        const response = await saved;
        expect(response.ok(), await response.text()).toBe(true);
      };
      await actionButton(page, 'Quitar país MX').click();
      await saveEdits();
      await page.getByRole('searchbox', { name: 'Buscar por nombre' }).fill('Ciudad de México');
      await submit(page, preflight, actionButton(page, 'Buscar candidatos verificados'));
      expect(remote('preflight', draft.id).stage).toBe('targeting');
      await actionButton(page, 'Seleccionar Ciudad de México').click();
      await page.getByLabel('Unidad', { exact: true }).selectOption('kilometer');
      await page.getByLabel('Radio explícito', { exact: true }).fill('20');
      await page.getByLabel('Edad mínima (18–65)').fill('27');
      await saveEdits();
      await page.locator('select[name="kind"]').selectOption('interest');
      await page.getByRole('searchbox', { name: 'Buscar por nombre' }).fill('Fitness');
      await submit(page, preflight, actionButton(page, 'Buscar candidatos verificados'));
      expect(remote('preflight', draft.id).candidates[0].label).toBe('Fitness');
      const offered = actionButton(page, 'Solicitar recomendaciones');
      await expect(offered).toBeDisabled();
      await expect(page.getByText(/Ciudad de México · México \(MX\) · Radio 20 km/)).toBeVisible();
      await page.getByRole('checkbox', { name: /^Autorizo esta consulta/ }).check();
      const manual = await submit(page, audiencePath, offered, 'propose');
      expect(manual).toMatchObject({ status: 'proposed', mode: 'manual', proposal: { age: { before: [27, 55], after: [23, 55] }, interests: [{ label: 'Fitness', status: 'verified' }] } });
      const current = await f.campaign(draft.id);
      expect(current.audience).toMatchObject({ countries: ['PE'], cities: [{ label: 'Ciudad de México', context: { radius: 20 } }], ageMin: 27, interests: [] });
      await page.getByRole('checkbox', { name: 'Aplicar el cambio de edad', exact: true }).check();
      await submit(page, audiencePath, actionButton(page, 'Aplicar solo diferencias elegidas'), 'apply');
      await expect(page.getByLabel('Edad mínima (18–65)')).toHaveValue('23');
      expect((await f.campaign(draft.id)).audience).toEqual({ ...current.audience, ageMin: 23 });

      await actionButton(page, 'Continuar a revisión').click();
      await submit(page, preflight, actionButton(page, 'Guardar y validar el mismo borrador'));
      expect(remote('preflight', draft.id).stage).toBe('validate');
      await page.reload();
      await actionButton(page, '2. Revisar y publicar').click();
      await submit(page, `${path}/forecast`, actionButton(page, 'Guardar y obtener estimación'));
      await approveReview(page, draft.id, 'Preparar sin activar', 'prepare-paid');
      await expect(actionButton(page, 'Autorizar inversión')).toHaveCount(0);
      expect(remote('prepare', draft.id)).toMatchObject({ state: 'ready', remoteId: null });
      await page.reload();
      expect((await f.campaign(draft.id)).deliveries[0]).toMatchObject({ state: 'ready', budgetSnapshot: { currency: 'COP', remainingMinor: 9000000 } });
      await actionButton(page, 'Autorizar inversión').click();
      const authorization = page.getByRole('dialog', { name: 'Autorizar inversión', exact: true });
      const confirm = actionButton(authorization, 'Confirmar solicitud');
      await expect(confirm).toBeDisabled();
      await expect(authorization.getByText('Presupuesto restante verificado en Meta')).toBeVisible();
      await authorization.getByRole('checkbox').check();
      await submit(page, actions, confirm, 'activate-paid');
      const enabled = remote('activate', draft.id);
      expect(enabled).toMatchObject({ state: 'scheduled', remoteId: expect.any(String) });
      expect((await f.campaign(draft.id)).deliveries[0]).toMatchObject({ state: enabled.state, remoteId: enabled.remoteId, everActivated: true });
    } finally {
      provider('disable');
    }
    const broad = await f.post(`${ROOT}/campaigns`, { name: `${f.marker} sin personalizar`, mode: 'paid', marketCountries: ['MX', 'PE'] });
    await page.goto(`/admin?section=advertising&tab=campaigns&record=${broad.id}`);
    const audienceUrl = `${ROOT}/campaigns/${broad.id}/audience`;
    await actionButton(page, 'Definir con IA').click();
    await expect(page.getByText('Ali no está disponible. Puedes definir la audiencia tú o continuar sin personalizar.')).toBeVisible();
    expect((await f.campaign(broad.id)).audience.countries).toEqual([]);
    await actionButton(page, 'Sin personalizar').click();
    await submit(page, audienceUrl, actionButton(page, 'Usar público amplio sin IA'), 'broad');
    expect(await f.campaign(broad.id)).toMatchObject({ audienceMode: 'broad', audience: { countries: ['MX', 'PE'], ageMin: 18, ageMax: 65, cities: [], interests: [] } });
  });
  test('la foto vertical no publicable se conserva y sirve solo para ajustar', async ({ page }, info) => {
    test.setTimeout(180000);
    const f = await advertisingFixture(page, info);
    worker('configure');
    await navigate(page, 'Publicidad');
    await page.getByRole('button', { name: 'Crear publicación o campaña', exact: true }).click();
    const adjustment = page.getByRole('region', { name: 'Estudio visual', exact: true });
    await adjustment.getByRole('button', { name: 'Adjuntar foto o video', exact: true }).click();
    const vertical = await sharp({ create: { width: 540, height: 960, channels: 3, background: '#7a5522' } }).withExif({ IFD0: { Artist: 'NO-SALE-DEL-FIXTURE' } }).png().toBuffer();
    await page.getByLabel('Archivo de imagen o video', { exact: true }).setInputFiles({ name: 'vertical.png', mimeType: 'image/png', buffer: vertical });
    const upload = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/content') && response.request().method() === 'PUT');
    const attaching = page.waitForResponse(result => new URL(result.url()).pathname.startsWith(`${ROOT}/creative-threads/`) && result.request().method() === 'PATCH');
    await page.getByRole('button', { name: 'Subir archivo', exact: true }).click();
    const uploaded = await (await upload).json();
    const attached = await attaching;
    expect(attached.ok(), await attached.text()).toBe(true);
    worker('asset', uploaded.id);
    const base = await f.asset(uploaded.id);
    expect(base.diagnostic.code).toBe('IMAGE_GEOMETRY');
    await expect(adjustment.getByText(/Solo para ajustar: esta foto no se puede publicar tal cual/)).toBeVisible();
    await expect(adjustment.getByRole('button', { name: 'Usar esta pieza y continuar' })).toHaveCount(0);
    await actionButton(adjustment, 'Datos y fotos para preparar imagen').click();
    const adjustmentContext = page.getByRole('dialog', { name: 'Datos y fotos para preparar imagen' });
    const display = adjustmentContext.getByRole('img', { name: 'Imagen a modificar', exact: true });
    await expect(display).toHaveAttribute('src', new RegExp(`/assets/${base.id}/content\\?variant=reference&sha256=`));
    const baseResponse = await page.request.get(await display.getAttribute('src'));
    expect((await sharp(await baseResponse.body()).metadata()).exif).toBeUndefined();
    await actionButton(adjustmentContext, 'Volver al chat').click();
    await adjustment.getByRole('textbox', { name: 'Escríbele a Ali', exact: true }).fill('Aclara el fondo y conserva el encuadre completo.');
    const variant = await generate(page, f, adjustment, { campaignId: null, baseAssetId: base.id });
    expect(variant.id).not.toBe(base.id);
    await expect(adjustment.getByRole('button', { name: 'Usar esta pieza y continuar' })).toBeEnabled({ timeout: 15000 });
    const studioId = new URL(page.url()).searchParams.get('studio');
    expect((await f.get(`${ROOT}/creative-threads/${studioId}`)).thread).toMatchObject({ campaignId: null, selectedAsset: null });
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
    const search = page.getByRole('searchbox', { name: 'Buscar publicaciones', exact: true });
    const submit = page.getByRole('button', { name: 'Buscar publicaciones', exact: true });
    await search.fill(`${f.marker}-sin-coincidencias`);
    await submit.click();
    await expect(page.getByRole('heading', { name: 'No hay coincidencias con ese nombre' })).toBeVisible();
    await search.fill(f.marker);
    await submit.click();
    await expectView(page, { q: f.marker, record: null });
    const publication = page.getByRole('button', { name: `${f.marker} resultados`, exact: true });
    await expect(publication).toBeVisible();
    await publication.scrollIntoViewIfNeeded();
    await captureAdvertisingSurface(page, info, 'resultados-lista');
    await publication.click();
    await expectView(page, { record: draft.id, q: f.marker });
    await expect(page.getByText(/^Borrador · Sin entregas; aún no hay rendimiento que analizar\./)).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Período y filtros', exact: true })).toBeVisible();
    await captureAdvertisingSurface(page, info, 'resultados-sin-entregas');
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
    await captureAdvertisingSurface(page, info, 'resultados-filtros');
    const summary = page.locator('summary').filter({ hasText: /^Más filtros de resultados$/ });
    await summary.click();
    const chips = page.getByRole('button', { name: /^Quitar filtro:/ });
    await expect(chips).toHaveCount(5);
    for (const chip of await chips.all()) await expect(chip).toBeVisible();
    const savedURL = page.url();
    await page.reload();
    await expectView(page, fullQuery);
    await expect(page.getByRole('heading', { name: 'Período y filtros', exact: true })).toBeVisible();
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
    await expectView(page, { section: 'advertising', tab: 'results', q: f.marker, record: null });
    const accountHeading = page.getByRole('heading', { name: 'Medición de la cuenta', exact: true });
    await expect(accountHeading).toBeFocused();
    await expect(publication).toBeVisible();
    await expect(accountHeading).toBeInViewport({ ratio: 1 });
    await captureAdvertisingSurface(page, info, 'resultados-medicion');
    await expect(page.getByRole('heading', { name: 'Elige una publicación o campaña' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Objetivo del negocio y medición' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Análisis histórico y contenido actual' })).toBeVisible();
    await page.getByRole('heading', { name: 'Análisis histórico y contenido actual' }).scrollIntoViewIfNeeded();
    await captureAdvertisingSurface(page, info, 'resultados-historial');
    expect(await f.campaign(draft.id)).toEqual(baseline);
    expect(reading.writes).toEqual([]);
  } finally {
    reading.stop();
  }
});

test('publicidad guiada: campañas consultadas y ficha económica', async ({ page }, info) => {
  test.setTimeout(180000);
  const f = await advertisingFixture(page, info), seeded = await seedMetaInventory(f);
  const { connectionId, accountId, campaignId, oldSnapshot, local, draft } = seeded;
  const reading = observeWrites(page), remoteReads = [];
  const track = request => remoteReads.push(new URL(request.url()).pathname);
  page.on('request', track);
  try {
    const linkedBaseline = await f.campaign(local.id), draftBaseline = await f.campaign(draft.id);
    const linkedOrdersBefore = (await f.get(`${ROOT}/results?campaignId=${local.id}`)).business.orders;
    await page.goto(`/admin?section=business&tab=social&record=${connectionId}`);
    const consulted = page.getByRole('region', { name: 'Datos consultados', exact: true });
    await expect(consulted.getByRole('heading', { name: `Campaña ${campaignId}`, exact: true })).toBeVisible();
    await expect(page.getByText('Esta consulta por fecha no se guarda.', { exact: false })).toBeVisible();
    await expectView(page, { section: 'business', tab: 'social', record: connectionId, source: null });
    remoteReads.length = 0;
    await page.getByRole('button', { name: 'Ver campañas consultadas en Publicidad', exact: true }).click();
    await expectView(page, { section: 'advertising', tab: 'campaigns', source: 'meta', connection: connectionId, record: null, account: null });
    const inventory = page.getByRole('region', { name: 'Campañas consultadas en Meta', exact: true });
    await expect(inventory.getByText('26 campañas', { exact: true })).toBeVisible();
    const row = inventory.getByRole('row').filter({ hasText: `Campaña ${campaignId}` });
    await expect(row.getByText('También creada en All Nutrition', { exact: true })).toBeVisible();
    await expect(row.getByText('Configuración disponible · Sin métricas', { exact: true })).toBeVisible();
    await expect(inventory.getByText('También creada en All Nutrition', { exact: true })).toHaveCount(1);
    await captureAdvertisingSurface(page, info, 'consultadas-en-meta-lista');

    const listPages = inventory.getByRole('navigation', { name: 'Páginas de campañas consultadas' });
    await listPages.getByRole('button', { name: 'Siguiente' }).click();
    await expectView(page, { page: '2', connection: connectionId, account: null });
    await expect(listPages).toContainText('Página 2 de 3');
    const secondPage = inventory.getByRole('button', { name: /^Ver detalle:/ }).first();
    const secondLabel = await secondPage.getAttribute('aria-label');
    await secondPage.click();
    await expectView(page, { page: '2', connection: connectionId, account: accountId });
    await page.reload();
    await page.getByRole('button', { name: 'Volver a campañas consultadas', exact: true }).click();
    await expectView(page, { page: '2', connection: connectionId, account: null, metaCampaign: null });
    await expect(inventory.getByRole('button', { name: secondLabel, exact: true })).toBeFocused();
    await listPages.getByRole('button', { name: 'Anterior' }).click();
    await row.getByRole('button', { name: /^Ver detalle:/ }).click();
    await expectView(page, { metaCampaign: campaignId, account: accountId, record: null });

    const detail = page.getByRole('region', { name: 'Detalle de campaña consultada' });
    const estimate = detail.getByRole('region', { name: 'Estimación antes de invertir' });
    const meta = detail.getByRole('region', { name: 'Rendimiento reportado por Meta' });
    const trade = detail.getByRole('region', { name: 'Resultado comercial en All Nutrition' });
    for (const block of [estimate, meta, trade]) await expect(block).toBeVisible();
    await expect(meta).toContainText('Configuración disponible · Sin métricas');
    await expect(trade).toContainText('Sin pedidos vinculados');
    await expect(detail.getByRole('button', { name: /^(Editar|Aprobar|Pausar|Activar|Autorizar inversión|Publicar|Vincular)/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Crear publicación o campaña', exact: true })).toHaveCount(0);
    await openDisclosure(detail, /^Conjuntos de anuncios \(12\)$/);
    const children = detail.getByRole('navigation', { name: 'Páginas de conjuntos de anuncios' });
    await children.getByRole('button', { name: 'Siguiente' }).click();
    await expect(children).toContainText('Página 2 de 2');
    await expect(detail.getByText(`Conjunto ${seeded.lastAdSet}`, { exact: true })).toBeVisible();
    await expect(detail.getByText(`Conjunto ${seeded.orphan}`, { exact: true })).toHaveCount(0);
    await expectView(page, { metaCampaign: campaignId, connection: connectionId, page: null });

    await estimate.getByLabel('Presupuesto total de la pauta', { exact: true }).fill('100000');
    await estimate.getByLabel('Contribución esperada por venta', { exact: true }).fill('30000');
    await estimate.getByLabel('Moneda del escenario', { exact: true }).fill('COP');
    await expect(estimate).toContainText('4 ventas');
    await captureAdvertisingSurface(page, info, 'consultadas-en-meta-ficha-economica');
    await detail.getByRole('combobox', { name: 'Lectura guardada' }).selectOption(oldSnapshot);
    await expectView(page, { snapshot: oldSnapshot, connection: connectionId });
    await expect(meta).toContainText('2025-08-01');
    await expect(meta).toContainText('2025-08-07');
    await expect(meta).toContainText(/0\s*COP/);
    await expect(meta).toContainText('Sin datos');
    await expect(trade).toContainText(/corte/i);
    await expect(trade).not.toContainText('2025-08-07');
    await expect(estimate).toContainText('4 ventas');
    await detail.getByRole('button', { name: 'Volver a campañas consultadas', exact: true }).click();
    await inventory.getByRole('button', { name: `Ver detalle: Campaña ${seeded.otherCampaign} · ${accountId}`, exact: true }).click();
    await expect(estimate).toContainText('Sin base para estimar');
    await expect(estimate.getByLabel('Contribución esperada por venta', { exact: true })).toHaveValue('');
    await expect(trade).toContainText('Sin campaña propia vinculada');
    expect(remoteReads.filter(path => path === `${ROOT}/campaigns` || path.startsWith(`${ROOT}/assets`) || /\/connections\/[^/]+\/advertising$/.test(path))).toEqual([]);

    await selectWorkspace(page, 'Origen de campañas', 'Creadas en All Nutrition');
    await expectView(page, { source: null, connection: null, account: null, metaCampaign: null, page: null });
    await selectWorkspace(page, 'Origen de campañas', 'Consultadas en Meta');
    await expectView(page, { section: 'advertising', tab: 'campaigns', source: 'meta', connection: null, account: null });
    const account = inventory.getByRole('combobox', { name: 'Cuenta publicitaria', exact: true });
    await expect(account.locator('option:checked')).toHaveText('Todas las cuentas');
    await account.selectOption(accountId);
    await expectView(page, { account: accountId, connection: null });
    await expect(inventory.getByText('26 campañas', { exact: true })).toBeVisible();
    await expect(inventory.getByText('También creada en All Nutrition', { exact: true })).toHaveCount(1);
    await row.getByRole('button', { name: /^Ver detalle:/ }).click();
    await detail.getByRole('button', { name: 'Abrir ficha propia', exact: true }).click();
    await expectView(page, { source: null, account: null, connection: null, record: local.id });

    await page.goto(`/admin?section=advertising&tab=campaigns&q=${encodeURIComponent(f.marker)}`);
    const linked = card(page, local.name);
    await expect(linked.getByText('Consultada en Meta', { exact: true })).toBeVisible();
    await card(page, draft.name).getByRole('button', { name: 'Ver ficha económica', exact: true }).click();
    await expectView(page, { tab: 'results', record: draft.id, source: null });
    await expect(page.getByRole('heading', { name: 'Resultado comercial en All Nutrition', exact: true })).toBeVisible();
    await page.goto(`/admin?section=advertising&tab=campaigns&record=${draft.id}`);
    const caption = page.locator('textarea[name=\"caption\"]');
    await caption.fill('Texto provisional no guardado');
    const discard = page.waitForEvent('dialog');
    const leaving = page.getByRole('button', { name: 'Volver a publicaciones', exact: true }).click();
    const confirmation = await discard;
    expect(confirmation.message()).toMatch(/cambios sin guardar/);
    await confirmation.dismiss();
    await leaving;
    await expect(caption).toHaveValue('Texto provisional no guardado');
    await page.getByRole('button', { name: 'Continuar a revisión', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Qué falta antes de aprobar' })).toBeVisible();
    await page.getByRole('button', { name: 'Editar definición', exact: true }).click();
    await expect(caption).toHaveValue('Texto provisional no guardado');
    expect(await f.campaign(local.id)).toEqual(linkedBaseline);
    expect(await f.campaign(draft.id)).toEqual(draftBaseline);
    expect(reading.writes).toEqual([]);
    expect((await f.get(`${ROOT}/results?campaignId=${local.id}`)).business.orders).toEqual(linkedOrdersBefore);
  } finally {
    page.off('request', track);
    reading.stop();
    await seeded.cleanup();
  }
});

async function seedMetaInventory(f) {
  const env = testDatabaseEnv(), host = new URL(env.DATABASE_URL).hostname;
  if (!['db', 'localhost', '127.0.0.1'].includes(host) || env.DB_SSL !== 'verify' || !(env.DB_CA_CERT || env.DB_CA_CERT_FILE)) throw new Error('El inventario sintético requiere PostgreSQL local con TLS verificado.');
  const store = new Store(await openPostgres(databaseConfig(env)));
  const createdCampaigns = [];
  let ready = false;
  try {
    if ((await store.db.get('SELECT current_database() AS name')).name !== 'allnutrition_test') throw new Error('La conexión real no corresponde al fixture allnutrition_test.');
    const actor = await store.db.get(`SELECT id FROM ${store.t('users')} WHERE email=?`, ['e2e@example.test']);
    const at = new Date(Date.now() - 2000).toISOString(), earlier = new Date(Date.parse(at) - 86400000).toISOString();
    const historicalPeriod = { type: 'range', since: '2025-08-01', until: '2025-08-07', timeZone: 'America/Bogota' };
    const connectionId = randomUUID(), secondConnection = randomUUID(), assetId = randomUUID();
    const snapshot = randomUUID(), oldSnapshot = randomUUID(), secondSnapshot = randomUUID();
    const prefix = BigInt(`0x${connectionId.replaceAll('-', '')}`).toString().slice(0, 25);
    const accountId = `act_${prefix}00`, campaignId = `${prefix}100`, otherCampaign = `${prefix}101`;
    const lastAdSet = `${prefix}211`, orphan = `${prefix}244`;
    const localName = `${f.marker} vinculada`, draftName = `${f.marker} para revisar`;
    const local = await f.post(`${ROOT}/campaigns`, { name: localName, mode: 'paid' });
    createdCampaigns.push(local.id);
    const draft = await f.post(`${ROOT}/campaigns`, { name: draftName });
    createdCampaigns.push(draft.id);
    const evidence = async (tx, analysisId, kind, resourceId, observedAt, data) => insertRow(tx, 'social_account_analysis_items', {
      id: randomUUID(), analysis_id: analysisId, resource_kind: kind, resource_id: resourceId, created_at: observedAt, updated_at: observedAt,
      data: JSON.stringify({ accountId, observedAt, ...data })
    });
    await store.transaction(async tx => {
      const identities = { adAccountId: accountId };
      for (const [id, label] of [[connectionId, 'Principal'], [secondConnection, 'Segunda']]) await insertRow(tx, 'social_connections', {
        id, provider: 'meta', integration_method: 'api', state: 'connected', version: 1, created_at: earlier, updated_at: at,
        data: JSON.stringify({ name: `${f.marker} ${label}`, authenticationMethod: 'token', readOnly: true, identities,
          currency: 'COP', timeZone: 'America/Bogota', capabilities: { insights: true },
          resources: { adAccounts: [{ id: accountId, name: 'Cuenta sintética de publicidad', currency: 'COP', timeZone: 'America/Bogota' }] },
          evaluation: { permissions: [{ name: 'ads_read', status: 'granted' }] }
        })
      });
      const assetHash = hash(assetId);
      await insertRow(tx, 'social_assets', { id: assetId, state: 'archived', sha256: assetHash, bytes: 0,
        version: 1, created_at: earlier, updated_at: at, data: JSON.stringify({ name: 'Pieza histórica sintética', kind: 'image', derivativeSha256: assetHash }) });
      for (const [id, connection, observedAt] of [[snapshot, connectionId, at], [oldSnapshot, connectionId, earlier], [secondSnapshot, secondConnection, earlier]]) await insertRow(tx, 'social_account_analyses', {
        id, connection_id: connection, actor_id: actor.id, state: 'completed', version: 1, created_at: observedAt, updated_at: observedAt,
        data: JSON.stringify({ period: historicalPeriod, phase: 'completed', stats: { completedUnits: 3, resources: 1, pages: 2, objects: 26 }, work: [],
          permissions: ['ads_read'], coverage: { [`ad_account:${accountId}`]: { kind: 'ad_account', resourceId: accountId, state: 'accessible_complete', missing: [] } } })
      });
      for (let index = 0; index < 26; index++) await evidence(tx, snapshot, 'campaigns', `${prefix}${100 + index}`, new Date(Date.parse(at) - index * 1000).toISOString(), {
        period: { type: 'current_snapshot', at }, configuration: { objective: 'OUTCOME_SALES', status: 'PAUSED', effective_status: 'PAUSED' }
      });
      for (let index = 0; index < 44; index++) await evidence(tx, snapshot, 'adsets', `${prefix}${200 + index}`, at, {
        period: { type: 'current_snapshot', at }, configuration: { campaignId: index < 12 ? campaignId : `${prefix}${101 + index % 25}`, status: 'PAUSED', optimization_goal: 'REACH' }
      });
      await evidence(tx, snapshot, 'adsets', orphan, at, { period: { type: 'current_snapshot', at }, configuration: { campaignId: `${prefix}999` } });
      await evidence(tx, secondSnapshot, 'campaigns', campaignId, earlier, { period: { type: 'current_snapshot', at: earlier }, configuration: { status: 'PAUSED' } });
      await evidence(tx, oldSnapshot, 'ads_campaign', campaignId, earlier, {
        period: historicalPeriod, dimensions: { level: 'campaign', breakdowns: [] }, scope: 'paid', currency: 'COP',
        values: { spend: { value: '0', unit: 'account_currency_decimal', status: 'reported' }, impressions: { value: '0', unit: 'count', status: 'reported' } }
      });
      const spec = { name: localName, mode: 'paid', objective: 'reach', platforms: ['facebook'], marketCountries: ['CO'], placements: ['facebook_feed'],
        connectionId, integrationMethod: 'api', identities, currency: 'COP', timeZone: 'America/Bogota', assetId, assetHash, assetType: 'image' };
      await insertRow(tx, 'social_revisions', { campaign_id: local.id, revision: 1, spec_hash: hash(spec), approved_at: earlier, actor_id: actor.id, data: JSON.stringify({ spec }) });
      const deliveryId = randomUUID();
      await insertRow(tx, 'social_deliveries', { id: deliveryId, campaign_id: local.id, revision: 1, channel: 'meta_ads', state: 'paused',
        remote_id: campaignId, next_sync_at: null, version: 1, created_at: earlier, updated_at: at,
        data: JSON.stringify({ id: deliveryId, remoteRefs: { campaignId }, integrationMethod: 'api', lastConfirmedState: 'paused', lastConfirmedAt: at, evidence: { remoteRead: true } })
      });
      await tx.db.run(`UPDATE ${tx.t('social_campaigns')} SET state='paused',connection_id=?,asset_id=? WHERE id=?`, [connectionId, assetId, local.id]);
    });
    ready = true;
    return { connectionId, campaignId, accountId, otherCampaign, oldSnapshot, lastAdSet, orphan, local: { id: local.id, name: localName }, draft: { id: draft.id, name: draftName },
      cleanup: async () => {
        try {
          await store.transaction(async tx => {
            await tx.db.run(`DELETE FROM ${tx.t('social_deliveries')} WHERE campaign_id=?`, [local.id]);
            await tx.db.run(`DELETE FROM ${tx.t('social_revisions')} WHERE campaign_id=?`, [local.id]);
            await tx.db.run(`DELETE FROM ${tx.t('social_campaigns')} WHERE id IN (?,?)`, [local.id, draft.id]);
            await tx.db.run(`DELETE FROM ${tx.t('social_assets')} WHERE id=?`, [assetId]);
            await tx.db.run(`DELETE FROM ${tx.t('social_account_analyses')} WHERE id IN (?,?,?)`, [snapshot, oldSnapshot, secondSnapshot]);
            await tx.db.run(`DELETE FROM ${tx.t('social_connections')} WHERE id IN (?,?)`, [connectionId, secondConnection]);
          });
        } finally { await store.close(); }
      }
    };
  } finally {
    if (!ready) {
      try {
        if (createdCampaigns.length) await store.db.run(`DELETE FROM ${store.t('social_campaigns')} WHERE id IN (${createdCampaigns.map(() => '?').join(',')})`, createdCampaigns);
      } finally { await store.close(); }
    }
  }
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

test('estudio de publicaciones · abrir la captura exacta y preparar una variante sin enviar', async ({ page }, info) => {
  test.setTimeout(120000);
  const base = new URL(info.project.use.baseURL);
  if (base.protocol !== 'https:' || !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('La prueba de cambios requiere la aplicación HTTPS descartable local.');
  const f = await advertisingFixture(page, info), record = await seedResults(f);
  try {
    await page.goto(`/admin?section=advertising&tab=results&record=${record.id}&resultsFocus=recommendations`);
  await expect(page.getByRole('heading', { name: record.name, exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rendimiento reportado por Meta', exact: true }).getByText('0', { exact: true }).first()).toBeVisible();
  await expectNoOverflow(page);
  await openDisclosure(page, /^Métricas completas, capturas y estado por destino$/);
  await expect(page.getByRole('heading', { name: 'Estado de publicación por red' })).toBeVisible();
  await captureAdvertisingSurface(page, info, 'resultados-capturas');
  await openDisclosure(page, /^Evidencia y acciones de las recomendaciones$/);
  const capture = page.getByRole('button', { name: 'Abrir captura citada', exact: true });
  await capture.scrollIntoViewIfNeeded();
  await captureAdvertisingSurface(page, info, 'resultados-recomendacion');
  await capture.click();
  const cited = page.getByRole('dialog', { name: 'Captura exacta del análisis' });
  await expect(cited.getByText(/Lectura conservada, independiente de los filtros/)).toBeVisible();
  const metrics = cited.getByRole('region', { name: 'Métricas de la captura' });
  const interactions = metrics.getByRole('heading', { name: 'Interacciones', exact: true });
  await expect(interactions).toBeInViewport();
  await expect(interactions.locator('..').getByText('0', { exact: true })).toBeInViewport();
  await captureAdvertisingSurface(page, info, 'resultados-evidencia');
  await openDisclosure(page, /^Fechas, cobertura y evidencia de la captura$/);
  await expect(cited.getByText(record.captureId, { exact: true })).toBeVisible();
  await cited.getByRole('button', { name: 'Cerrar captura', exact: true }).click();
  await expect(capture).toBeFocused();
  await page.getByRole('button', { name: 'Cambiar aquí · solo Facebook' }).click();
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
  await openDisclosure(page, /^Evidencia y acciones de las recomendaciones$/);
  await page.getByRole('button', { name: 'Preparar una variante', exact: true }).click();
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
  expect(child.marketCountries).toEqual(['MX']);
  expect(child.deliveries).toEqual([]);
  expect(child.operations).toEqual([]);
  await page.goBack();
  await expectView(page, { tab: 'results', record: record.id });
  await openDisclosure(page, /^Historial de pruebas y aprendizajes$/);
  await expect(page.getByRole('heading', { name: 'Qué aprendimos' })).toBeVisible();
  await expect(page.getByText('Mejoró según este criterio', { exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'Qué aprendimos' }).scrollIntoViewIfNeeded();
  await captureAdvertisingSurface(page, info, 'resultados-aprendizaje');
  await page.goto(`/admin?section=advertising&tab=campaigns&record=${newDraft.id}`);
  await expect(page.getByRole('heading', { name: 'Paso 1 de 2 · Definir publicación' })).toBeVisible();
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
      caption, marketCountries: ['CO'], platforms: ['facebook', 'instagram'], placements: ['facebook_feed', 'instagram_feed'], aiDisclosure: false, publishAt,
    });
    const editorURL = `/admin?section=advertising&tab=campaigns&record=${draft.id}`;
    const editor = page.getByRole('region', { name: 'Publicidad en redes sociales' });
    const pending = editor.getByText('Aprobada, pendiente de publicar', { exact: true });
    const scheduled = editor.getByText('Programada', { exact: true }).first();
    const publish = page.getByRole('button', { name: 'Programar', exact: true });
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
    await page.getByRole('button', { name: '2. Revisar y publicar', exact: true }).click();
    const estimate = editor.getByRole('region', { name: 'Consulta una estimación' });
    const obtainEstimate = async button => {
      const posted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `${ROOT}/campaigns/${draft.id}/forecast`);
      await button.click();
      const response = await posted;
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const firstEstimate = await obtainEstimate(estimate.getByRole('button', { name: 'Guardar y obtener estimación', exact: true }));
    expect(firstEstimate.manualScenario).toBeNull();
    await page.reload();
    const updateEstimate = estimate.getByRole('button', { name: 'Actualizar estimación', exact: true });
    await expect(updateEstimate).toBeEnabled();
    await expect(updateEstimate).toHaveClass(/\bsubtle\b/);
    await openDisclosure(page, 'Agregar mi propia hipótesis');
    await estimate.getByRole('checkbox', { name: /^Quiero incluir mi hipótesis/ }).check();
    const scenario = { metric: 'facebook.interactions', lower: 3, upper: 9, basis: 'Hipótesis de ensayo: entre tres y nueve interacciones.' };
    await estimate.getByRole('combobox', { name: 'Métrica primaria' }).selectOption(scenario.metric);
    await estimate.getByRole('spinbutton', { name: 'Límite inferior' }).fill(String(scenario.lower));
    await estimate.getByRole('spinbutton', { name: 'Límite superior' }).fill(String(scenario.upper));
    await estimate.getByRole('textbox', { name: 'Fundamento explícito' }).fill(scenario.basis);
    const updatedEstimate = await obtainEstimate(updateEstimate);
    expect(updatedEstimate.id).not.toBe(firstEstimate.id);
    expect(updatedEstimate).toMatchObject({ version: draft.version, specHash: firstEstimate.specHash, manualScenario: scenario });
    const visibleHypothesis = estimate.getByRole('paragraph').filter({ hasText: scenario.basis });
    await expect(visibleHypothesis).toBeVisible();
    expect(await f.campaign(draft.id)).toMatchObject({ state: 'draft', forecastId: updatedEstimate.id, revisions: [], deliveries: [], operations: [] });
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
    await expect(page.getByRole('button', { name: 'Abrir opciones de Meta en Redes sociales' })).toBeVisible();
    const approvedDraft = await expectNoDeliveries();
    expect(approvedDraft.revisions.at(-1)).toMatchObject({ forecastId: updatedEstimate.id, forecast: { manualScenario: scenario } });

    settings = await setPublishing(true);
    await page.reload();
    await expect(pending).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Configuración aprobada · Solo lectura' })).toBeVisible();
    await expect(page.locator('textarea[name="caption"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ver resultados', exact: true })).toHaveCount(0);
    await expect(publish).toBeEnabled();
    const frozen = await expectNoDeliveries();
    const writing = observeWrites(page);
    const dialog = page.getByRole('dialog', { name: 'Programar revisión aprobada' });
    const confirm = dialog.getByRole('button', { name: 'Confirmar programación', exact: true });
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
      await expect(dialog.getByRole('definition').filter({ hasText: assetName })).toHaveText(assetName);
      await expect(dialog.getByRole('img', { name: `Vista previa de la pieza: ${assetName}` })).toBeVisible();
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
