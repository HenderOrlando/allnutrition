import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login, navigate, signOut } from './helpers.mjs';

test('sesión HTTPS, CSRF, origen, concurrencia y cierre de sesión', async ({ page, context }, info) => {
  await login(page);
  const session = (await context.cookies()).find(cookie => cookie.name === 'allnutrition_session');
  // Assert only metadata: failure output must not include the session value.
  expect(Boolean(session)).toBe(true);
  expect(session.secure).toBe(true);
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Strict');

  await navigate(page, 'Productos');
  await page.getByRole('button', { name: 'Crear producto', exact: true }).click();
  const drawer = page.getByRole('dialog');
  const slug = `seguridad-e2e-${info.project.name}-${info.retry}`.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  await drawer.getByLabel('Nombre', { exact: false }).fill(`Producto ${slug}`);
  await drawer.getByLabel('Dirección corta (sin espacios)', { exact: false }).fill(slug);
  await drawer.getByRole('button', { name: 'Ingresar URL HTTPS' }).click();
  await drawer.getByLabel('URL pública de la fotografía', { exact: true }).fill('/brand/creatina-vital-force.jpg');
  await drawer.getByLabel('Presentación / contenido').fill('Presentación de seguridad');
  await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
  const savedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/admin/products' && response.request().method() === 'POST');
  await drawer.getByRole('button', { name: 'Crear producto' }).click();
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

  await signOut(page);
  await expect(page).toHaveURL(url => url.pathname === '/admin/login');
  expect((await context.request.get('/api/admin/orders')).status()).toBe(401);
});

test('APIs operativas exactas conservan sesión, origen, CSRF y lecturas privadas',async({page,context})=>{
  const reads=[
    '/api/admin/dashboard','/api/admin/reports','/api/admin/reports/export','/api/admin/reports/unknown',
    '/api/admin/alerts','/api/admin/alerts/unknown','/api/admin/alert-rules','/api/admin/alert-rules/unknown',
    ...['settings','people','platforms','sources','profiles','accounts'].map(resource=>'/api/admin/business/'+resource),
    '/api/admin/business/people/unknown','/api/admin/business/shipments','/api/admin/business/shipments/unknown',
    ...['overview','movements','settlements','expenses','payroll','closings'].map(resource=>'/api/admin/finance/'+resource),
    '/api/admin/imports','/api/admin/imports/unknown','/api/admin/imports/unknown/file','/api/admin/imports/unknown/errors',
  ];
  const writes=[
    ...['people','platforms','sources','profiles','accounts'].flatMap(resource=>[['POST','/api/admin/business/'+resource],['PUT','/api/admin/business/'+resource+'/unknown']]),
    ['PUT','/api/admin/business/settings'],['POST','/api/admin/business/shipments'],['PUT','/api/admin/business/shipments/unknown'],
    ['POST','/api/admin/business/shipments/unknown/events'],['POST','/api/admin/reports'],
    ['PUT','/api/admin/alerts/unknown'],['PUT','/api/admin/alert-rules/unknown'],
    ['POST','/api/admin/imports'],['PUT','/api/admin/imports/unknown'],['PUT','/api/admin/imports/unknown/file'],
    ['POST','/api/admin/imports/unknown/preview'],['POST','/api/admin/imports/unknown/commit'],
    ...['collection','refund','expense','expense-recovery','pay-expense','settlement-save','settlement-confirm','transfer','cash-close','cash-reopen','cash-reverse','document-reverse','resolve-legacy-payment','return','payroll-prepare','payroll-confirm','payroll-pay','advance','income','complete-costs','link-shipment'].map(action=>['POST','/api/admin/business/actions/'+action]),
  ];
  for(const path of reads)expect((await context.request.get(path)).status(),path).toBe(401);
  for(const [method,path] of writes)expect((await context.request.fetch(path,{method,data:{}})).status(),method+' '+path).toBe(401);
  await login(page);
  const origin=new URL(page.url()).origin;
  const reading=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/users'&&response.request().method()==='GET');
  await navigate(page,'Usuarios');
  const csrf=await (await reading).request().headerValue('x-csrf-token');
  expect(Boolean(csrf)).toBe(true);
  for(const [method,path] of writes){
    expect((await context.request.fetch(path,{method,headers:{Origin:origin},data:{}})).status(),method+' '+path).toBe(403);
    expect((await context.request.fetch(path,{method,headers:{Origin:'https://evil.example.test','x-csrf-token':csrf},data:{}})).status(),method+' '+path).toBe(403);
  }
  for(const path of reads.filter(path=>!path.includes('unknown')&&!path.endsWith('/export'))){
    const response=await context.request.get(path);
    expect(response.status(),path).toBe(200);
    expect(response.headers()['cache-control'],path).toContain('no-store');
  }
  for(const path of ['/api/admin/business/dashboard','/api/admin/business/reports'])expect((await context.request.get(path)).status()).toBe(404);
  const headers={Origin:origin,'x-csrf-token':csrf};
  expect((await context.request.post('/api/admin/upload',{headers,data:Buffer.from('not-an-image')})).status()).toBe(400);
  expect((await context.request.post('/api/admin/upload',{headers,data:Buffer.alloc(10*1024*1024+1)})).status()).toBe(413);
});

test('descargar informe usa bytes privados y una sesión vencida no descarga JSON como Excel',async({page,context})=>{
  await login(page);await navigate(page,'Informes');
  const exportButton=page.getByRole('button',{name:'Exportar XLSX',exact:true});
  await expect(exportButton).toBeEnabled();
  const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/reports/export');
  const downloadPromise=page.waitForEvent('download');
  await exportButton.click();
  const response=await responsePromise,download=await downloadPromise;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(response.headers()['content-type']).toContain('spreadsheetml');
  expect(new URL(response.url()).searchParams.has('token')).toBe(false);
  expect((await readFile(await download.path())).subarray(0,2).toString()).toBe('PK');
  expect(await download.failure()).toBeNull();
  await expect(exportButton).toBeEnabled();
  await context.clearCookies();
  let unexpectedDownload=false;
  page.on('download',()=>{unexpectedDownload=true;});
  const expired=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/reports/export');
  await exportButton.click();expect((await expired).status()).toBe(401);
  await expect(page).toHaveURL(url=>url.pathname==='/admin/login'&&new URL(url.searchParams.get('next'),url.origin).pathname==='/admin');
  expect(unexpectedDownload).toBe(false);
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
  const privateSku=`interno-no-publicar-${info.project.name}`;
  const origin=new URL(page.url()).origin;
  const listing=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/products'&&response.request().method()==='GET');
  await navigate(page,'Productos');
  const csrf=await (await listing).request().headerValue('x-csrf-token');
  const privateProduct=await page.request.put('/api/admin/products/'+product.id,{headers:{Origin:origin,'x-csrf-token':csrf},data:{...product,sku:privateSku,unitCostMinor:1234567,costEffectiveOn:new Intl.DateTimeFormat('en-CA',{timeZone:'America/Bogota'}).format(new Date())}});
  expect(privateProduct.status()).toBe(200);
  const detailPath = `/productos/${product.slug}`;
  const anonymous = await browser.newContext({ baseURL, ignoreHTTPSErrors: info.project.use.ignoreHTTPSErrors === true });
  try {
    const publicPage = await anonymous.newPage();
    expect((await publicPage.goto(detailPath)).status()).toBe(404);
    await navigate(page, 'Contacto y redes');
    await expect(page.getByLabel('Publicar la vitrina (contenido revisado y aprobado)', { exact: true })).not.toBeChecked();
    await savePublication(page, true);
    expect((await publicPage.goto(detailPath)).status()).toBe(200);
    await expect(publicPage.getByRole('heading', { level: 1, name: product.title, exact: true })).toBeVisible();
    await expect(publicPage.getByRole('img', { name: product.title, exact: true }).first()).toBeVisible();
    for(const path of [detailPath,'/']){
      const publicResponse=await anonymous.request.get(path);expect(publicResponse.status()).toBe(200);
      const html=await publicResponse.text();
      expect(html).not.toContain(privateSku);
      for(const field of ['unitCostMinor','costEffectiveOn','openingBalanceMinor','salaryAgreements'])expect(html).not.toContain(field);
    }
  } finally {
    try {
      // Reload settings to use the persisted version even if an assertion failed after saving.
      await page.goto('/admin');
      await navigate(page, 'Contacto y redes');
      await savePublication(page, false);
      expect((await anonymous.request.get(detailPath)).status()).toBe(404);
    } finally {
      await anonymous.close();
    }
  }
});
