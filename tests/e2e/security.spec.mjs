import { test, expect } from '@playwright/test';
import { login } from './helpers.mjs';

test('sesión HTTPS, CSRF, origen, concurrencia y cierre de sesión', async ({ page, context }, info) => {
  await login(page);
  const session = (await context.cookies()).find(cookie => cookie.name === 'allnutrition_session');
  // Assert only metadata: failure output must not include the session value.
  expect(Boolean(session)).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');

  await page.getByRole('navigation', { name: 'Administración' }).getByRole('button', { name: 'Productos', exact: false }).click();
  await page.getByRole('button', { name: 'Crear producto', exact: true }).click();
  const drawer = page.getByRole('dialog');
  const slug = `seguridad-e2e-${info.project.name}-${info.retry}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  await drawer.getByLabel('Nombre', { exact: false }).fill(`Producto ${slug}`);
  await drawer.getByLabel('Dirección corta (sin espacios)', { exact: false }).fill(slug);
  await drawer.getByLabel('Enlace de la fotografía', { exact: true }).fill('/brand/creatina-vital-force.jpg');
  await drawer.getByLabel('Presentación / contenido').fill('Presentación de seguridad');
  await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
  const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/products' && response.request().method() === 'POST');
  await drawer.getByRole('button', { name: 'Guardar cambios' }).click();
  const createdResponse = await savedResponse;
  expect(createdResponse.status()).toBe(201);
  const csrf = await createdResponse.request().headerValue('x-csrf-token');
  expect(Boolean(csrf)).toBe(true);
  const created = await createdResponse.json();
  await expect(drawer).toHaveCount(0);

  const endpoint = `/api/admin/products/${created.id}`;
  const origin = new URL(page.url()).origin;
  const currentResponse = await context.request.get(endpoint);
  expect(currentResponse.status()).toBe(200);
  const current = await currentResponse.json();
  const rejectedData = { ...current, price: 27000 };
  const missingCSRF = await context.request.put(endpoint, { headers: { Origin: origin }, data: rejectedData });
  expect(missingCSRF.status()).toBe(403);
  const evilOrigin = await context.request.put(endpoint, {
    headers: { Origin: 'https://evil.example.test', 'x-csrf-token': csrf }, data: rejectedData,
  });
  expect(evilOrigin.status()).toBe(403);
  const unchangedResponse = await context.request.get(endpoint);
  expect(unchangedResponse.status()).toBe(200);
  expect(await unchangedResponse.json()).toEqual(current);

  const headers = { Origin: origin, 'x-csrf-token': csrf };
  const firstSave = await context.request.put(endpoint, { headers, data: { ...current, price: 26000 } });
  expect(firstSave.status()).toBe(200);
  const accepted = await firstSave.json();
  expect(accepted.price).toBe(26000);
  expect(accepted.version).toBe(current.version + 1);
  const staleSave = await context.request.put(endpoint, { headers, data: { ...current, price: 28000 } });
  expect(staleSave.status()).toBe(409);
  const finalResponse = await context.request.get(endpoint);
  expect(finalResponse.status()).toBe(200);
  expect(await finalResponse.json()).toEqual(accepted);

  await page.locator('header').getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
  await expect(page).toHaveURL(url => url.pathname === '/admin/login');
  expect((await context.request.get('/api/admin/orders')).status()).toBe(401);
});

async function savePublication(page, approved) {
  await page.getByLabel('Publicar la vitrina (contenido revisado y aprobado)', { exact: true }).setChecked(approved);
  const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/settings' && response.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
  const response = await savedResponse;
  expect(response.status()).toBe(200);
  expect((await response.json()).launchApproved).toBe(approved);
  await expect(page.getByRole('button', { name: 'Guardar configuración', exact: true })).toBeEnabled();
}

test('publicar habilita la ficha anónima y despublicar vuelve a protegerla', async ({ page, browser, baseURL }, info) => {
  await login(page);
  const productsResponse = await page.request.get('/api/admin/products');
  expect(productsResponse.status()).toBe(200);
  const { records } = await productsResponse.json();
  const product = records.find(record => record.slug === 'creatina-vital-force-70-servicios');
  expect(Boolean(product)).toBe(true);
  expect(product.status).toBe('published');
  const detailPath = `/productos/${product.slug}`;
  const anonymous = await browser.newContext({ baseURL, ignoreHTTPSErrors: info.project.use.ignoreHTTPSErrors === true });
  try {
    const publicPage = await anonymous.newPage();
    expect((await publicPage.goto(detailPath)).status()).toBe(404);
    await page.getByRole('navigation', { name: 'Administración' }).getByRole('button', { name: 'Contacto y redes', exact: true }).click();
    await expect(page.getByLabel('Publicar la vitrina (contenido revisado y aprobado)', { exact: true })).not.toBeChecked();
    await savePublication(page, true);
    expect((await publicPage.goto(detailPath)).status()).toBe(200);
    await expect(publicPage.getByRole('heading', { level: 1, name: product.title, exact: true })).toBeVisible();
    await expect(publicPage.getByRole('img', { name: product.title, exact: true }).first()).toBeVisible();
  } finally {
    try {
      // Reload settings to use the persisted version even if an assertion failed after saving.
      await page.goto('/admin');
      await page.getByRole('navigation', { name: 'Administración' }).getByRole('button', { name: 'Contacto y redes', exact: true }).click();
      await savePublication(page, false);
      expect((await anonymous.request.get(detailPath)).status()).toBe(404);
    } finally {
      await anonymous.close();
    }
  }
});
