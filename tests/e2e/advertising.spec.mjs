import { randomUUID } from 'node:crypto';
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
  // Assets have a paginated collection endpoint, not a GET /assets/:id route.
  const asset = async id => {
    for (let offset = 0; ; offset += 100) {
      const result = await get(`${ROOT}/assets?limit=100&offset=${offset}`);
      const found = result.assets.find(item => item.id === id);
      if (found) return found;
      if (result.assets.length < 100) throw new Error(`No aparece el archivo ${id} en el inventario privado.`);
    }
  };
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
  const image = page.locator(`img[src*="/assets/${id}/content"]`);
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
  await page.getByRole('button', { name: 'Crear publicación', exact: true }).first().click();
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
  await card(page, name).getByRole('button', { name: 'Abrir borrador', exact: true }).click();
  await expect(nameInput).toHaveValue(name);

  const reading = observeWrites(page), steps = page.getByRole('navigation', { name: 'Pasos de preparación', exact: true });
  const caption = `${f.marker} texto conservado entre pasos`;
  try {
    await steps.getByRole('button').nth(1).click();
    await page.locator('textarea[name="caption"]').fill(caption);
    for (let step = 2; step < 5; step++) {
      await page.getByRole('button', { name: 'Continuar', exact: true }).click();
      await expect(steps.getByRole('button').nth(step)).toHaveAttribute('aria-current', 'step');
    }
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
    await card(page, name).getByRole('button', { name: 'Abrir borrador', exact: true }).click();
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
  await selectWorkspace(page, 'Vistas de publicidad', 'Imágenes y videos');
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

  await selectWorkspace(page, 'Vistas de publicidad', 'Publicaciones');
  await page.getByRole('button', { name: 'Crear publicación', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Pasos de preparación', exact: true }).getByRole('button').nth(1).click();
  const selector = page.locator('select[name="assetId"]');
  await expect(selector).toBeVisible();
  await expect(selector.locator(`option[value="${ready.id}"]`)).toHaveCount(0);
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
    const publication = page.getByRole('combobox', { name: 'Publicación', exact: true });
    await expect(publication.locator(`option[value="${draft.id}"]`)).toHaveCount(1);
    await publication.selectOption(draft.id);
    await expectView(page, { record: draft.id });
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
    await expect(page.getByRole('heading', { name: 'Sin capturas en esta selección', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir borrador', exact: true }).first()).toBeVisible();
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
    await page.getByRole('button', { name: 'Redes sociales', exact: true }).click();
    await expectView(page, { section: 'business', tab: 'social', record: null });
    await expect(page.getByRole('form', { name: 'Opciones de Meta', exact: true })).toBeVisible();
    expect(await f.campaign(draft.id)).toEqual(baseline);
    expect(reading.writes).toEqual([]);
  } finally {
    reading.stop();
  }
});
