import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { emptyRecord } from '../../lib/schema.mjs';
import { login } from './helpers.mjs';

const controlURL = process.env.ALI_FIXTURE_CONTROL_URL;
const baseURL = process.env.ALI_FIXTURE_BASE_URL;
async function control(request, body) {
  if (!controlURL || !baseURL) throw new Error('Set ALI_FIXTURE_CONTROL_URL and ALI_FIXTURE_BASE_URL to the private synthetic fixture');
  const response = await request.post(`${controlURL}/__control`, { headers: { Authorization: 'Bearer assistant-fixture-only' }, data: body });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function screenshot(page, info, name) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: false });
}

test('Ali: partial → explicit acceptance → durable stop → reload', async ({ page, request }, info) => {
  test.setTimeout(180000);
  await control(request, { action: 'reset' });
  expect((await request.get(`${controlURL}/__control`)).status()).toBe(401);
  const firstAdmin = page.waitForRequest(req => new URL(req.url()).pathname.startsWith('/api/admin/') && Boolean(req.headers()['x-csrf-token']));
  await login(page);
  const initial = await firstAdmin;
  const headers = { Origin: new URL(page.url()).origin, 'x-csrf-token': await initial.headerValue('x-csrf-token') };
  const marker = `ali-review-${randomUUID()}`;
  for (let index = 1; index <= 65; index++) {
    const response = await page.request.post('/api/admin/products', { headers, data: {
      ...emptyRecord('products'), title: `${marker} ${String(index).padStart(2, '0')}`, slug: `${marker}-${index}`,
      description: `${index === 65 ? 'ÚLTIMO-FRAGMENTO ' : ''}${'Texto multibyte café 營養 🥑 '.repeat(90)}`,
      presentation: 'Unidad', status: 'draft', price: 12000,
    } });
    expect(response.ok(), await response.text()).toBe(true);
  }
  await page.goto('/admin?section=business&tab=assistant');
  await page.locator('select[name=provider]').selectOption('gemini');
  await page.locator('select[name=authMethod]').selectOption('oauth');
  // Clipped grids can hide overflow from document.scrollWidth.
  for (const name of ['provider', 'authMethod', 'model', 'projectId']) {
    const control = page.locator(`[name=${name}]`);
    await expect(control).toBeVisible();
    const bounds = await control.evaluate(element => {
      const field = element.getBoundingClientRect(), grid = element.closest('.product-form-grid').getBoundingClientRect();
      return { left: field.left, right: field.right, min: grid.left, max: Math.min(grid.right, innerWidth) };
    });
    expect(bounds.left, `${name} left edge`).toBeGreaterThanOrEqual(bounds.min - 1);
    expect(bounds.right, `${name} right edge`).toBeLessThanOrEqual(bounds.max + 1);
  }
  await page.locator('select[name=authMethod]').scrollIntoViewIfNeeded();
  await screenshot(page, info, 'assistant-oauth-controls');
  await page.locator('select[name=provider]').selectOption('openai-compatible');
  await page.locator('input[name=baseUrl]').fill(baseURL);
  await page.locator('input[name=model]').fill('fixture-a');
  await page.locator('input[name=apiKey]').fill('assistant-fixture-only');
  await page.locator('input[name=allowPrivateNetwork]').check();
  await page.locator('input[name=enabled]').check();
  const saved = page.waitForResponse(response => response.url().endsWith('/api/admin/assistant/settings') && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Guardar y verificar', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.ok(), await savedResponse.text()).toBe(true);
  await control(request, { action: 'configure', behavior: { scenario: 'review', query: { kind: 'products', q: marker } } });
  await page.goto('/admin?section=products');
  await page.getByRole('banner').getByRole('button', { name: 'Ali', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Ali, asistente del negocio' });
  const composer = dialog.getByLabel('Mensaje para Ali');
  await expect(composer).toBeFocused();
  await composer.fill(`${marker}: revisa todos los textos de estos productos.`);
  await dialog.getByRole('button', { name: 'Enviar', exact: true }).click();
  await expect(dialog.getByText('Respuesta parcial', { exact: true }).last()).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Completar análisis', exact: true }).last()).toBeVisible();
  await screenshot(page, info, 'assistant-partial');
  const before = await request.get(`${controlURL}/__control`, { headers: { Authorization: 'Bearer assistant-fixture-only' } });
  const records = (await before.json()).requests.filter(item => !item.connectionCheck);
  expect(records.length).toBeLessThanOrEqual(2);
  expect(records.every(item => item.bytes <= 96 * 1024)).toBe(true);
  const gate = await control(request, { action: 'hold', afterReads: 1 });
  try {
    await dialog.getByRole('button', { name: 'Completar análisis', exact: true }).last().click();
    await control(request, { action: 'wait', id: gate.id });
    await expect(dialog.getByTestId('assistant-progress')).toBeVisible();
    await screenshot(page, info, 'assistant-progress');
    await dialog.getByRole('button', { name: 'Detener', exact: true }).click();
    await expect(dialog.getByTestId('assistant-progress')).toHaveCount(0);
    await expect(dialog.getByTestId('assistant-result').last()).toContainText(/parcial|revisado/i);
    await screenshot(page, info, 'assistant-stopped');
  } finally { await control(request, { action: 'release', id: gate.id }); }
  await dialog.getByText(/^Fuentes \(/).last().click();
  await expect(dialog.locator('details[open]').last()).toBeVisible();
  await dialog.getByRole('button', { name: 'Ver registros consultados', exact: true }).last().click();
  await expect(dialog.getByTestId('assistant-read-page')).toContainText(marker);
  await page.reload();
  await page.getByRole('banner').getByRole('button', { name: 'Ali', exact: true }).click();
  await page.getByRole('dialog', { name: 'Ali, asistente del negocio' }).getByRole('button').filter({ hasText: marker }).first().click();
  await expect(page.getByRole('dialog', { name: 'Ali, asistente del negocio' })).toContainText(/parcial|revisado/i);
  await screenshot(page, info, 'assistant-reloaded');
});
