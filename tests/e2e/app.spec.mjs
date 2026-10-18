import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { test,expect } from '@playwright/test';
import { login,navigate,signOut,visibleRecord,selectWorkspace,openDisclosure,openCashOperation,openConfigurationTask } from './helpers.mjs';
import { emptyRecord, money } from '../../lib/schema.mjs';
import { writeExcelSheets } from '../../lib/business/excel.mjs';
import { bogotaDate } from '../../lib/business/dates.mjs';

test('privacidad: sin login no se ven panel, pedidos ni catálogo no aprobado',async({page,request},info)=>{
 expect((await page.goto('/')).status()).toBe(200);await expect(page.locator('article.product-card')).toHaveCount(0);
 await page.screenshot({path:info.outputPath('preparation.png'),fullPage:true});
 expect((await request.get('/api/admin/orders')).status()).toBe(401);
 expect((await request.get('/api/admin/settings')).status()).toBe(401);
 expect((await request.get('/api/admin/upload')).status()).toBe(401);
 expect((await request.post('/api/admin/upload',{data:'not-an-image'})).status()).toBe(401);
 for(const path of ['/api/admin/business/settings','/api/admin/business/people','/api/admin/finance/overview','/api/admin/imports','/api/admin/imports/unknown/file','/api/admin/imports/unknown/errors'])expect((await request.get(path)).status()).toBe(401);
 expect((await request.put('/api/admin/imports/unknown/file',{data:'not-an-excel'})).status()).toBe(401);
 expect((await request.get('/productos/creatina-vital-force-70-servicios')).status()).toBe(404);
 await page.goto('/admin/login');
 await expect(page.getByLabel('Correo de administrador')).toBeVisible();
 await page.screenshot({path:info.outputPath('login.png'),fullPage:true});
});

test('panel permite vista previa y conserva WhatsApp principal',async({page},info)=>{
 await login(page);
 await expect(page.getByRole('navigation',{name:'Administración',exact:true}).and(page.locator(':visible'))).toBeVisible();
 await page.screenshot({path:info.outputPath('panel.png'),fullPage:true});
 await page.goto('/?preview=1');
 const product=page.locator('article.product-card').first();
 await expect(product).toBeVisible();
 const title=(await product.getByRole('heading',{level:3}).textContent()).trim();
 const link=product.locator('a[href^="https://wa.me/"]');
 await expect(link).toBeVisible();
 const destination=new URL(await link.getAttribute('href'));
 expect(destination.protocol).toBe('https:');
 expect(destination.hostname).toBe('wa.me');
 expect(destination.pathname).toBe('/573043440035');
 expect(destination.searchParams.get('text')).toContain(title);
 await page.screenshot({path:info.outputPath('catalog-preview.png'),fullPage:true});
});

test('crea y edita un producto: búsqueda, precio, existencias y publicación',async({page},info)=>{
 await login(page);await navigate(page,'Productos');
 await page.getByRole('button',{name:'Crear producto',exact:true}).click();
 const drawer=page.getByRole('dialog');
 const name=`Producto E2E ${info.project.name}`;
 await drawer.getByLabel('Nombre',{exact:false}).fill(name);
 await drawer.getByRole('button',{name:'Ingresar URL HTTPS'}).click();
 await drawer.getByLabel('URL pública de la fotografía',{exact:true}).fill('https://images.example.com/test.jpg');
 await drawer.getByLabel('Presentación / contenido').fill(`Presentación de prueba ${info.project.name}`);
 await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
 await drawer.getByLabel('Existencias físicas (unidades)').fill('10');
 await drawer.getByRole('button',{name:'Crear producto'}).click();await expect(drawer).toHaveCount(0);
 await page.getByRole('textbox',{name:/Buscar por nombre, presentación o referencia/}).fill(info.project.name);
 const edit=page.getByRole('button',{name:`Editar ${name}`,exact:true});
 await expect(edit).toHaveCount(1);
 await edit.click();
 await drawer.getByLabel('Precio en pesos colombianos').fill('26000');
 await drawer.getByLabel('Existencias físicas (unidades)').fill('12');
 await drawer.getByRole('combobox',{name:'Publicación',exact:true}).selectOption('published');
 await drawer.getByRole('button',{name:'Guardar cambios'}).click();await expect(drawer).toHaveCount(0);
 await expect(visibleRecord(page,name).getByText('12 físicas · 0 reservadas · 12 disponibles',{exact:true})).toBeVisible();
 await page.getByLabel('Filtrar por publicación').selectOption('published');
 await expect(edit).toHaveCount(1);
 await page.getByLabel('Filtrar por publicación').selectOption('draft');
 await expect(edit).toHaveCount(0);
 await page.getByLabel('Filtrar por publicación').selectOption('');
 await edit.click();
 await expect(drawer.getByLabel('Precio en pesos colombianos')).toHaveValue('26000');
 await expect(drawer.getByLabel('Existencias físicas (unidades)')).toHaveValue('12');
 await drawer.getByRole('button',{name:'Cerrar editor'}).click();
 await expect(drawer).toHaveCount(0);
});
test('sube una imagen local optimizada y la muestra en la vitrina pública',async({page,request},info)=>{
 await login(page);await navigate(page,'Productos');
 await page.getByRole('button',{name:'Crear producto',exact:true}).click();
 const drawer=page.getByRole('dialog'),name=`Producto imagen local ${info.project.name}`;
 await drawer.getByLabel('Nombre',{exact:false}).fill(name);
 await expect(drawer.getByLabel('URL pública de la fotografía',{exact:true})).toHaveCount(0);
 await drawer.getByLabel('Presentación / contenido').fill('Presentación de prueba');
 await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
 await drawer.getByRole('combobox',{name:'Publicación',exact:true}).selectOption('published');
 const temp=mkdtempSync(join(tmpdir(),'allnutrition-e2e-media-')),file=join(temp,'product-upload.png');
 writeFileSync(file,await sharp({create:{width:3200,height:1600,channels:3,background:{r:38,g:112,b:83}}}).png().toBuffer());
 try{await drawer.getByLabel('Archivo de imagen del producto').setInputFiles(file);}finally{rmSync(temp,{recursive:true,force:true});}
 await expect(drawer.getByLabel('URL pública de la fotografía',{exact:true})).toHaveCount(0);
 const preview=drawer.locator('.image-picker img'),slug=await drawer.getByLabel('Dirección corta (sin espacios)').inputValue();
 const imageUrl=await preview.getAttribute('src');
 expect(imageUrl).toMatch(/^\/api\/media\/[0-9a-f-]{36}$/);await expect(preview).toBeVisible();
 await expect.poll(()=>preview.evaluate(image=>image.naturalWidth)).toBe(2400);
 await drawer.getByRole('button',{name:'Crear producto'}).click();await expect(drawer).toHaveCount(0);
 await page.goto(`/productos/${slug}`);
 const productImage=page.locator('.detail-photo img');
 await expect(page.getByRole('heading',{level:1,name,exact:true})).toBeVisible();
 await expect(productImage).toHaveAttribute('src',imageUrl);
 await expect.poll(()=>productImage.evaluate(image=>image.naturalWidth)).toBe(2400);
 await page.screenshot({path:info.outputPath('product-local-image.png'),fullPage:true});
 await page.goto('/?preview=1');
 const card=page.locator('article.product-card').filter({hasText:name});
 await expect(card).toHaveCount(1);await expect(card.locator('img')).toHaveAttribute('src',imageUrl);
 const response=await request.get(imageUrl);expect(response.status()).toBe(200);expect(response.headers()['content-type']).toContain('image/webp');
 const metadata=await sharp(await response.body()).metadata();
 expect(metadata.width).toBe(2400);expect(metadata.height).toBe(1200);
 if(process.env.PLAYWRIGHT_MEDIA_SMOKE_FILE){const manifest=process.env.PLAYWRIGHT_MEDIA_SMOKE_FILE;mkdirSync(dirname(manifest),{recursive:true});writeFileSync(manifest,JSON.stringify({url:imageUrl})+'\n',{mode:0o600});}
});

test('pedido manual: acuerdo, guía, despacho y conservación del historial',async({page},info)=>{
 test.setTimeout(90000);
 await login(page);await navigate(page,'Pedidos');
 await openDisclosure(page,/^Filtros de pedidos/);
 const shortcuts=page.getByRole('group',{name:'Atajos de pedidos'});
 for(const label of ['Con novedad','Pendiente de liquidar','Faltan datos','Faltan costos','Pago histórico por conciliar']){
  await expect(shortcuts.getByRole('button',{name:label,exact:true})).toBeVisible();
 }
 await shortcuts.getByRole('button',{name:'Faltan datos',exact:true}).click();
 await expect(shortcuts.getByRole('button',{name:'Faltan datos',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Limpiar filtros'}).click();
 await page.locator('.list-toolbar').getByRole('button',{name:'Nuevo pedido',exact:true}).click();
 const drawer=page.getByRole('dialog'),name=`Comprador E2E ${info.project.name}`;
 await drawer.getByLabel('Nombre del destinatario').fill(name);
 await drawer.getByLabel('Celular').fill('3001234567');await drawer.locator('[name="city"]').fill('Bogotá');
 await drawer.getByLabel('Departamento',{exact:true}).fill('Cundinamarca');await drawer.getByLabel('Dirección exacta',{exact:true}).fill('Dirección de prueba');
 await drawer.getByRole('button',{name:'Agregar referencia'}).click();
 const references=await (await page.request.get('/api/admin/products')).json();
 const product=references.records.find(record=>record.slug==='creatina-vital-force-70-servicios');
 await drawer.getByRole('combobox',{name:'Referencia 1',exact:true}).selectOption(`products:${product.id}`);
 const creating=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/orders'&&r.request().method()==='POST');
 await drawer.getByRole('button',{name:'Crear pedido',exact:true}).click();
 const response=await creating;expect(response.status()).toBe(201);const created=await response.json();
 expect(created.totalMinor).toBe(5500000);expect(created.paymentSummary.netCollectedMinor).toBe(0);
 await expect(drawer).toHaveCount(0);
 await page.getByRole('textbox',{name:'Buscar pedidos'}).fill(name);
 const open=page.getByRole('button',{name:`Abrir pedido AN-${String(created.number).padStart(6,'0')}`,exact:true});
 await expect(visibleRecord(page,name)).toHaveCount(1);await open.click();
 const draftURL=page.url(),recipient=drawer.getByLabel('Nombre del destinatario');
 await recipient.fill(`${name} borrador`);
 let discarded=0;const rejectTab=async dialog=>{expect(dialog.message()).toContain('Hay cambios sin guardar');discarded++;await dialog.dismiss();};page.on('dialog',rejectTab);
 for(const [index,width] of [1440,390,1440].entries()){
  await page.setViewportSize({width,height:844});await expect(recipient).toHaveValue(`${name} borrador`);await expect(page).toHaveURL(draftURL);
  const nav=drawer.getByRole('navigation',{name:'Detalle del pedido'});
  if(width<768)await nav.getByRole('combobox').selectOption({label:'Envíos'});
  else await nav.getByRole('button',{name:'Envíos',exact:true}).click();
  await expect.poll(()=>discarded).toBe(index+1);
  await expect(recipient).toHaveValue(`${name} borrador`);
  if(width<768)await expect(nav.getByRole('combobox')).toHaveValue('agreement');
  else await expect(nav.getByRole('button',{name:'Acuerdo',exact:true})).toHaveAttribute('aria-current','page');
 }
 page.off('dialog',rejectTab);await recipient.fill(name);
 await drawer.getByRole('combobox',{name:'Estado comercial',exact:true}).selectOption('preparing');
 await drawer.getByRole('button',{name:'Guardar cambios',exact:true}).click();await expect(drawer).toHaveCount(0);await open.click();
 await selectWorkspace(drawer,'Detalle del pedido','Envíos');
 await drawer.locator('summary').filter({hasText:'Registrar guía o entrega local'}).click();
 await drawer.getByLabel('Transportadora',{exact:true}).fill('Transportadora prueba');
 await drawer.getByLabel('Número de guía',{exact:true}).fill(`E2E-${info.project.name}`);
 const shipping=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/business/shipments'&&r.request().method()==='POST');
 await drawer.getByRole('button',{name:'Registrar envío',exact:true}).click();expect((await shipping).status()).toBe(201);
 await drawer.getByLabel('Estado observado').selectOption('collected');
 const dispatching=page.waitForResponse(r=>/\/shipments\/[^/]+\/events$/.test(new URL(r.url()).pathname)&&r.request().method()==='POST');
 await drawer.getByLabel('Fecha real del evento').fill(created.placedOn);
 await drawer.getByRole('button',{name:'Guardar evento',exact:true}).click();expect((await dispatching).status()).toBe(201);
 await expect.poll(async()=>(await (await page.request.get('/api/admin/orders/'+created.id)).json()).status).toBe('sent');
 const saved=await (await page.request.get('/api/admin/orders/'+created.id)).json();
 expect(saved.shipments[0].tracking).toBe(`E2E-${info.project.name}`);
 expect(saved.paymentSummary.netCollectedMinor).toBe(0);
 expect(saved.history.some(event=>event.actorId&&event.createdAt)).toBe(true);
 expect(saved.shipments[0].events.some(event=>event.status==='collected'&&event.occurredOn)).toBe(true);
 await selectWorkspace(drawer,'Detalle del pedido','Acuerdo');
 await expect(drawer.getByRole('combobox',{name:'Referencia 1',exact:true})).toBeDisabled();
 await expect(drawer.getByLabel('Cantidad 1',{exact:true})).toBeDisabled();
 await expect(drawer.getByLabel('Flete cobrado al cliente (COP)')).toBeDisabled();
 const csrf=await response.request().headerValue('x-csrf-token');
 const locked=await page.request.put('/api/admin/orders/'+created.id,{headers:{Origin:new URL(page.url()).origin,'x-csrf-token':csrf},data:{...saved,items:saved.items.map(line=>({...line,quantity:line.quantity+1}))}});
 expect(locked.status()).toBe(409);
 const afterRejected=await (await page.request.get('/api/admin/orders/'+created.id)).json();
 expect(afterRejected.items).toEqual(saved.items);
 await drawer.locator('summary').filter({hasText:'Más detalles'}).click();
 await drawer.getByLabel('Notas internas').fill('Nota posterior al despacho');
 let releaseSave,saveStarted;
 const held=new Promise(resolve=>{releaseSave=resolve;}),started=new Promise(resolve=>{saveStarted=resolve;});
 const orderPath=`**/api/admin/orders/${created.id}`;
 const hold=async route=>{if(route.request().method()==='PUT'){saveStarted();await held;}await route.continue();};
 await page.route(orderPath,hold);
 const savingNote=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/orders/'+created.id&&r.request().method()==='PUT');
 await drawer.getByRole('button',{name:'Guardar cambios',exact:true}).click();await started;
 try{
  await expect(drawer.getByRole('button',{name:'Cerrar pedido'})).toBeDisabled();
  await expect(page.getByRole('button',{name:/^Ir a…/})).toBeDisabled();
  await expect(drawer.getByRole('navigation',{name:'Detalle del pedido'}).getByRole('button',{name:'Envíos',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(draftURL);
  expect((await (await page.request.get('/api/admin/orders/'+created.id)).json()).notes).toBe(saved.notes);
 }finally{releaseSave();}
 expect((await savingNote).status()).toBe(200);await page.unroute(orderPath,hold);
 await expect(drawer).toHaveCount(0);await open.click();
 expect((await (await page.request.get('/api/admin/orders/'+created.id)).json()).notes).toBe('Nota posterior al despacho');
 const headers={Origin:new URL(page.url()).origin,'x-csrf-token':csrf};
 const personResponse=await page.request.post('/api/admin/business/people',{headers,data:{requestId:crypto.randomUUID(),name:`Responsable cobro ${info.project.name}`,active:true}});
 expect(personResponse.status()).toBe(201);
 const person=await personResponse.json();
 const accountResponse=await page.request.post('/api/admin/business/accounts',{headers,data:{requestId:crypto.randomUUID(),name:`Cuenta cobro ${info.project.name}`,type:'bank',responsibleId:person.id,openingOn:created.placedOn,openingBalanceMinor:0}});
 expect(accountResponse.status()).toBe(201);const account=await accountResponse.json();
 await drawer.getByRole('button',{name:'Registrar cobro',exact:true}).click();
 await expect(page.getByRole('dialog')).toHaveCount(1);
 await drawer.getByLabel('Importe (COP)').fill('100');
 await drawer.getByLabel('Cuenta').selectOption(account.id);
 await drawer.getByLabel('Referencia').fill(`abono-e2e-${info.project.name}`);
 const collecting=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/business/actions/collection'&&r.request().method()==='POST');
 await drawer.getByRole('button',{name:'Registrar cobro',exact:true}).click();expect((await collecting).status()).toBe(200);
 await expect(drawer.getByRole('navigation',{name:'Detalle del pedido'})).toBeVisible();
 const collected=await (await page.request.get('/api/admin/orders/'+created.id)).json();
 expect(collected.totalMinor).toBe(created.totalMinor);
 expect(collected.paymentSummary.netCollectedMinor).toBe(10000);
 expect(collected.paymentSummary.outstandingMinor).toBe(created.totalMinor-10000);
 expect(collected.paymentSummary.status).toBe('partial');
 await page.screenshot({path:info.outputPath('order-shipment.png'),fullPage:true});
});

test('crea cuentas nuevas únicamente con rol administrador',async({page,context},info)=>{
 const anonymous=await context.request.get('/api/admin/users');
 expect(anonymous.status()).toBe(401);
 await login(page);
 const origin=new URL(page.url()).origin;
 const listResponsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/users'&&response.request().method()==='GET');
 await navigate(page,'Usuarios');
 const listResponse=await listResponsePromise;
 expect(listResponse.status()).toBe(200);
 const accounts=await listResponse.json();
 expect(accounts.users).toContainEqual({id:expect.any(String),email:'e2e@example.test',active:true,role:'administrator'});
 expect(accounts.users.every(user=>!Object.hasOwn(user,'password'))).toBe(true);
 expect(JSON.stringify(accounts)).not.toContain('scrypt:');
 const csrf=await listResponse.request().headerValue('x-csrf-token');
 expect(Boolean(csrf)).toBe(true);

 const noCsrf=await context.request.post('/api/admin/users',{headers:{Origin:origin},data:{email:'sin-csrf@example.test',password:'clave-nueva-e2e-administrador',role:'administrator'}});
 expect(noCsrf.status()).toBe(403);
 const invalidRole=await context.request.post('/api/admin/users',{headers:{Origin:origin,'x-csrf-token':csrf},data:{email:'rol-invalido@example.test',password:'clave-nueva-e2e-administrador',role:'user'}});
 expect(invalidRole.status()).toBe(400);
 const afterRejection=await context.request.get('/api/admin/users');
 expect((await afterRejection.json()).users.some(user=>['sin-csrf@example.test','rol-invalido@example.test'].includes(user.email))).toBe(false);

 const email=`nuevo-admin-${info.project.name}-${info.retry}@example.test`;
 const password='clave-nueva-e2e-administrador';
 await page.getByLabel('Correo electrónico').fill(email);
 await page.getByLabel(/^Contraseña inicial(?:\s*\*)?$/).fill(password);
 await page.getByLabel(/^Confirmar contraseña(?:\s*\*)?$/).fill(`${password}-incorrecta`);
 await page.getByRole('button',{name:'Crear usuario'}).click();
 await expect(page.locator('.user-management-form').getByRole('alert')).toBeVisible();
 await page.getByLabel(/^Confirmar contraseña(?:\s*\*)?$/).fill(password);
 const createResponsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/users'&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Crear usuario'}).click();
 const createResponse=await createResponsePromise;
 expect(createResponse.status()).toBe(201);
 expect(await createResponse.json()).toEqual({user:{email,role:'administrator'}});
 const row=visibleRecord(page,email);
 await expect(row).toHaveCount(1);
 await expect(row).toContainText('Administrador');

 const duplicate=await context.request.post('/api/admin/users',{headers:{Origin:origin,'x-csrf-token':csrf},data:{email,password,role:'administrator'}});
 expect(duplicate.status()).toBe(409);
 const afterDuplicate=await context.request.get('/api/admin/users');
 expect((await afterDuplicate.json()).users.filter(user=>user.email===email)).toHaveLength(1);

 await signOut(page);
 await expect(page).toHaveURL(url=>url.pathname==='/admin/login');
 await page.getByLabel('Correo de administrador').fill(email);
 await page.getByLabel('Contraseña',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Entrar al panel'}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/admin');
 expect((await page.request.get('/api/admin/orders')).status()).toBe(200);
});

test('los 31 destinos conservan encabezado, selección local y título en escritorio y móvil',async({page},info)=>{
 test.setTimeout(180000);
 const adminTasks=[
  ['home','Inicio',{section:'home'}],['orders','Gestionar pedidos',{section:'orders',tab:'list'}],
  ['shipments','Seguimiento de envíos',{section:'orders',tab:'shipments'}],['imports','Importar Excel',{section:'orders',tab:'imports'}],
  ['products','Gestionar productos',{section:'products'}],['gifts','Obsequios',{section:'products',productType:'gift'}],
  ['combos','Combos',{section:'combos'}],['catalogs','Catálogos',{section:'catalogs'}],
  ...[['cash','Cuentas y saldos','overview'],['movements','Movimientos de caja','movements'],['settlements','Liquidaciones','settlements'],['expenses','Gastos','expenses'],['payroll','Sueldos y anticipos','payroll']].map(([id,label,tab])=>[id,label,{section:'cash',tab}]),
  ...[['reports','Resumen de informes','overview'],['sales-report','Informe de ventas','sales'],['shipping-report','Informe de envíos','shipping'],['returns-report','Informe de devoluciones','returns'],['costs-report','Informe de costos','costs'],['payroll-report','Informe de sueldos','payroll'],['cash-report','Informe de caja','cash']].map(([id,label,tab])=>[id,label,{section:'reports',tab}]),
  ...[['setup','Primeros pasos'],['people','Personas responsables'],['accounts','Cuentas del negocio'],['platforms','Plataformas y cuentas'],['rules','Reglas del negocio'],['alerts','Alertas y avisos']].map(([id,label])=>[id,label,{section:'business',tab:id}]),
  ...[['users','Usuarios del panel'],['settings','Datos y publicación'],['faqs','Preguntas frecuentes'],['messages','Mensajes comerciales'],['shipping','Condiciones de envío']].map(([id,label])=>[id,label,{section:id}])
 ].map(([id,label,view])=>({id,label,view}));
 await login(page);
 const headings={
  home:/^Tu negocio$/,orders:/^Pedidos$/,shipments:/^Seguimiento de envíos$/,imports:/^Importar Excel$/,
  products:/^Productos$/,gifts:/^Obsequios$/,combos:/^Combos$/,catalogs:/^Catálogos$/,
  cash:/Disponible ahora/,movements:/Movimientos de dinero/,settlements:/Liquidaciones de plataforma/,
  expenses:/^Gastos y pagos$/,payroll:/Sueldos, comisiones y anticipos/,
  reports:/Resumen · lectura del período/,'sales-report':/Ventas · lectura del período/,
  'shipping-report':/Envíos · lectura del período/,'returns-report':/Devoluciones · lectura del período/,
  'costs-report':/Costos · lectura del período/,'payroll-report':/Sueldos · lectura del período/,'cash-report':/Caja · lectura del período/,
  people:/Personas responsables y vendedores/,
  accounts:/Cuentas de caja y bancos/,platforms:/Plataformas y cuentas de origen/,rules:/Reglas financieras con vigencia/,
  alerts:/Revisar alertas del negocio/,users:/Usuarios/,settings:/Datos y publicación de la vitrina/,
  faqs:/Preguntas frecuentes/,messages:/Mensajes comerciales/,shipping:/Condiciones de envío/
 };
 const width=info.project.name==='mobile'?390:1440;
 await page.setViewportSize({width,height:width<768?844:900});
  for(const task of adminTasks){
   const section=task.view.section;
   if(section==='orders'){
    await navigate(page,'Pedidos');await selectWorkspace(page,'Vistas de pedidos',{list:'Pedidos',shipments:'Envíos',imports:'Importar Excel'}[task.view.tab]);
   }else if(section==='cash'){
    await navigate(page,'Caja');await selectWorkspace(page,'Vistas de caja',{overview:'Resumen y cuentas',movements:'Movimientos',settlements:'Liquidaciones',expenses:'Gastos y pagos',payroll:'Sueldos y anticipos'}[task.view.tab]);
   }else if(section==='reports'){
    await navigate(page,'Informes');await selectWorkspace(page,'Áreas del informe',{overview:'Resumen',sales:'Ventas',shipping:'Envíos',returns:'Devoluciones',costs:'Costos',payroll:'Sueldos',cash:'Caja'}[task.view.tab]);
   }else if(section==='business'){
    await navigate(page,'Configuración');if(task.id!=='setup')await openConfigurationTask(page,task.id);
   }else if(task.id==='gifts'){
    await navigate(page,'Productos');await selectWorkspace(page,'Vistas de productos','Obsequios');
   }else{
    await navigate(page,{home:'Inicio',products:'Productos',combos:'Combos',catalogs:'Catálogos',users:'Usuarios',settings:'Datos y publicación',faqs:'Preguntas frecuentes',messages:'Mensajes comerciales',shipping:'Condiciones de envío'}[task.id]);
   }
   await expect(page).toHaveURL(url=>Object.entries(task.view).every(([key,value])=>(url.searchParams.get(key)||(key==='section'?'home':key==='tab'?{orders:'list',cash:'overview',reports:'overview',business:'setup'}[section]:''))===value));
   if(task.id==='setup')await expect(page.locator('#configuration-setup')).toBeVisible();
   else await expect(page.getByRole('heading',{name:headings[task.id]}).first()).toBeVisible();
   if(task.id!=='setup')await expect(page).toHaveTitle(new RegExp(task.label.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
   const navName=task.view.section==='orders'?'Vistas de pedidos':task.view.section==='cash'?'Vistas de caja':task.view.section==='reports'?'Áreas del informe':['products','combos','catalogs'].includes(task.view.section)?'Vistas de productos':null;
   if(navName){
    const nav=page.getByRole('navigation',{name:navName,exact:true});
    if(width<768){
     await expect(nav.getByRole('combobox')).toBeVisible();
     await expect(nav.getByRole('button')).toHaveCount(0);
     expect(await nav.getByRole('combobox').inputValue()).toBe(task.view.productType==='gift'?'gifts':task.view.tab||task.view.section);
    }else{
     await expect(nav.getByRole('combobox')).toHaveCount(0);
     await expect(nav.locator('button[aria-current="page"]')).toHaveCount(1);
    }
   }else if(task.id!=='home'){
    const config=page.getByRole('navigation',{name:'Vistas de configuración'});
    await expect(config).toBeVisible();
    if(task.id!=='setup')await expect(config.getByLabel('Cambiar de tarea')).toHaveValue(task.id);
   }
  }
 await page.reload();
 await expect(page.getByRole('heading',{level:1,name:'Condiciones de envío',exact:true})).toBeVisible();
});

test('lanzador y guía se usan con foco real, sin abrirse sobre campos o diálogos',async({page},info)=>{
 await login(page);
 const trigger=page.getByRole('button',{name:/^Ir a…/});
 await trigger.focus();await page.keyboard.press('Control+k');
 const launcher=page.getByRole('dialog',{name:'Ir a…',exact:true}),input=launcher.getByLabel('Buscar sección o acción');
 await expect(input).toBeFocused();await input.fill('gastos');
 const composingURL=page.url();
 for(const key of ['ArrowDown','Enter']){
  await input.dispatchEvent('keydown',{key,code:key,isComposing:true});await expect(input).toBeFocused();await expect(launcher).toBeVisible();await expect(page).toHaveURL(composingURL);
 }
 await input.press('ArrowDown');
 const gastos=launcher.getByRole('button',{name:'Gastos',exact:true});
 await expect(gastos).toBeFocused();await page.keyboard.press('ArrowUp');await expect(input).toBeFocused();
 await page.screenshot({path:info.outputPath('launcher-keyboard.png')});
 await input.press('ArrowDown');await page.keyboard.press('Enter');
 await expect(launcher).toHaveCount(0);await expect(page).toHaveURL(/section=cash.*tab=expenses/);
 await expect(page.locator('[data-admin-section-heading]')).toBeFocused();
 await trigger.click();await input.fill('');await input.press('Enter');await expect(launcher).toBeVisible();await input.press('ArrowDown');
 const results=launcher.locator('.launcher-results button:enabled');
 await expect(results.first()).toBeFocused();await page.keyboard.press('End');await expect(results.last()).toBeFocused();
 await expect.poll(()=>results.last().evaluate(element=>{const rect=element.getBoundingClientRect();return rect.top>=0&&rect.bottom<=window.innerHeight;})).toBe(true);
 await page.keyboard.press('ArrowDown');await expect(results.last()).toBeFocused();
 await page.keyboard.press('Home');await expect(results.first()).toBeFocused();await page.keyboard.press('ArrowUp');await expect(input).toBeFocused();
 await input.press('ArrowUp');await expect(results.last()).toBeFocused();await page.keyboard.press('Home');await page.keyboard.press('ArrowUp');await expect(input).toBeFocused();
 await input.fill('sin-destino-e2e-98217');await input.press('Enter');await expect(launcher).toBeVisible();
 await expect(launcher.getByRole('status')).toContainText('0 resultados');
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await page.getByRole('button',{name:'Atajos',exact:true}).click();
 const guide=page.getByRole('dialog',{name:'Atajos de teclado',exact:true});
 await expect(guide).toBeVisible();await expect(guide.locator('kbd').filter({hasText:'Tab'}).first()).toBeVisible();
 await page.keyboard.press('Control+k');await expect(page.getByRole('dialog')).toHaveCount(1);await expect(guide).toBeVisible();
 await page.screenshot({path:info.outputPath('keyboard-shortcuts.png')});
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Atajos',exact:true})).toBeFocused();
 await trigger.focus();await page.keyboard.press('Meta+k');await expect(input).toBeFocused();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await navigate(page,'Pedidos');const search=page.getByRole('textbox',{name:'Buscar pedidos'});
 await search.focus();
 for(const shortcut of ['Control+k','Meta+k']){await page.keyboard.press(shortcut);await expect(launcher).toHaveCount(0);}
 await page.locator('[data-admin-section-heading]').focus();await page.keyboard.press('Control+Shift+k');await expect(launcher).toHaveCount(0);
});

test('rechazar Atrás conserva el borrador y su destino; aceptar permite Atrás y Adelante sin reutilizarlo',async({page})=>{
 await login(page);await navigate(page,'Caja');
 const operations=page.locator('summary').filter({hasText:/^Registrar operación$/});
 await openCashOperation(page,'Registrar ingreso');
 const drawer=page.getByRole('dialog');
 await expect(drawer.getByRole('heading',{level:2})).toBeFocused();
 await page.keyboard.press('Control+k');
 await expect(page.getByRole('dialog')).toHaveCount(1);
 const description=drawer.locator('[name="description"]');
 await description.fill('Borrador que no debe perderse');
 let confirmations=0,accept=false;
 page.on('dialog',async dialog=>{expect(dialog.type()).toBe('confirm');confirmations++;if(accept)await dialog.accept();else await dialog.dismiss();});
 await page.evaluate(()=>history.back());
 await expect.poll(()=>confirmations).toBe(1);
 await expect(page).toHaveURL(url=>url.searchParams.get('section')==='cash');
 await expect(description).toHaveValue('Borrador que no debe perderse');
 await page.keyboard.press('Escape');
 await expect.poll(()=>confirmations).toBe(2);
 await expect(description).toHaveValue('Borrador que no debe perderse');
 accept=true;await page.keyboard.press('Escape');
 await expect(drawer).toHaveCount(0);await expect(operations).toBeFocused();
 expect(confirmations).toBe(3);
 await openCashOperation(page,'Registrar ingreso');await drawer.locator('[name="description"]').fill('Otro borrador descartable');
 await page.evaluate(()=>history.back());
 await expect.poll(()=>confirmations).toBe(4);
 await expect(page).toHaveURL(url=>(url.searchParams.get('section')||'home')==='home');
 await expect(drawer).toHaveCount(0);
 await page.evaluate(()=>history.forward());
 await expect(page).toHaveURL(url=>url.searchParams.get('section')==='cash');
 await openCashOperation(page,'Registrar ingreso');
 await expect(drawer.locator('[name="description"]')).toHaveValue('');
 await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);
 expect(confirmations).toBe(4);
});

test('apertura cero con responsable sin credenciales e ingreso no comercial separado de ventas',async({page},info)=>{
 test.setTimeout(60000);
 await login(page);await navigate(page,'Caja');
 await page.getByRole('button',{name:'Crear cuenta',exact:true}).first().click();
 const drawer=page.getByRole('dialog'),name=`Banco E2E ${info.project.name}`,personName=`Responsable E2E ${info.project.name}`;
 await drawer.locator('[name="name"]').fill(name);
 await drawer.getByLabel('Tipo de cuenta').selectOption('bank');
 await drawer.getByLabel('Saldo inicial confirmado (COP)').fill('0');
 await drawer.locator('summary').filter({hasText:'Crear responsable sin acceso al panel'}).click();
 await drawer.getByLabel('Nombre del responsable nuevo').fill(personName);
 await expect(drawer.locator('input[type="password"],input[type="email"]')).toHaveCount(0);
 const creatingPerson=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/business/people'&&r.request().method()==='POST');
 await drawer.getByRole('button',{name:'Crear responsable',exact:true}).click();
 const personResponse=await creatingPerson;expect(personResponse.status()).toBe(201);const person=await personResponse.json();
 await expect(drawer.getByLabel('Persona responsable')).toHaveValue(person.id);
 const creatingAccount=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/business/accounts'&&r.request().method()==='POST');
 await drawer.getByRole('button',{name:'Configurar cuenta',exact:true}).click();
 const accountResponse=await creatingAccount;expect(accountResponse.status()).toBe(201);const account=await accountResponse.json();
 expect(account.balanceMinor).toBe(0);expect(account.responsibleId).toBe(person.id);
 await expect(drawer).toHaveCount(0);
 const reportPath='/api/admin/reports?mode=live&period=month';
 const before=await (await page.request.get(reportPath)).json();
 await openCashOperation(page,'Registrar ingreso');
 await drawer.getByLabel('Concepto').selectOption('owner_funding');
 await drawer.getByLabel('Descripción').fill('Aporte no comercial de prueba');
 await drawer.getByLabel('Importe (COP)').fill('500');
 await drawer.getByLabel('Cuenta').selectOption(account.id);
 await drawer.getByLabel('Referencia').fill(`aporte-e2e-${info.project.name}`);
 const addingIncome=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/admin/business/actions/income'&&r.request().method()==='POST');
 await drawer.getByRole('button',{name:'Registrar ingreso',exact:true}).click();
 const incomeResponse=await addingIncome;expect(incomeResponse.status()).toBe(200);
 const income=await incomeResponse.json();
 expect(income).toMatchObject({accountId:account.id,concept:'owner_funding',kind:'income',amountMinor:50000,reference:`aporte-e2e-${info.project.name}`});
 await expect(drawer).toHaveCount(0);
 const overview=await (await page.request.get('/api/admin/finance/overview')).json();
 expect(overview.accounts.find(row=>row.id===account.id).balanceMinor).toBe(50000);
 const after=await (await page.request.get(reportPath)).json();
 expect(after.metrics.netProductSales).toEqual(before.metrics.netProductSales);
 const accountCard=page.locator('.cash-card').filter({hasText:name}),accountTrigger=accountCard.getByRole('button',{name:'Abrir cuenta'});
 const overviewURL=page.url();await accountTrigger.click();
 const accountHeading=page.locator('.cash-detail').getByRole('heading',{name,exact:true});
 await expect(accountHeading).toBeFocused();const accountURL=page.url();
 await page.getByRole('button',{name:'Configurar cuenta',exact:true}).click();
 await expect(drawer).toBeVisible();await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);
 await expect(accountHeading).toBeVisible();await expect(page).toHaveURL(accountURL);
 await accountHeading.focus();await page.keyboard.press('Escape');await expect(page).toHaveURL(overviewURL);await expect(accountTrigger).toBeFocused();
 await selectWorkspace(page,'Vistas de caja','Movimientos');await openDisclosure(page,/^Filtros(?: \(\d+ activos\))?$/);await page.getByRole('combobox',{name:'Cuenta',exact:true}).selectOption(account.id);
 const movementsURL=page.url(),incomeRow=page.locator('.cash-records .cash-row').filter({has:page.getByRole('heading',{name:'owner_funding',exact:true})});
 const detailTrigger=incomeRow.getByRole('button',{name:'Ver detalle',exact:true});
 await expect(detailTrigger).toHaveCount(1);await detailTrigger.click();
 const detailHeading=page.locator('.cash-detail').getByRole('heading',{level:2});await expect(detailHeading).toBeFocused();
 await expect(page).toHaveURL(url=>url.searchParams.get('record')===income.id&&url.searchParams.get('account')===account.id);
 await expect(page.locator('.cash-detail').getByText('Importe',{exact:true}).locator('..')).toContainText(money(500));
 await expect(page.locator('.cash-detail')).toContainText(`aporte-e2e-${info.project.name}`);
 const detailURL=page.url();await page.locator('.cash-detail').getByRole('button',{name:'Revertir movimiento completo',exact:true}).click();
 await expect(drawer).toBeVisible();await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);await expect(page).toHaveURL(detailURL);
 await page.getByLabel('Buscar',{exact:true}).focus();await page.keyboard.press('Escape');await expect(page).toHaveURL(detailURL);
 await detailHeading.focus();await page.keyboard.press('Escape');await expect(page).toHaveURL(movementsURL);await expect(detailTrigger).toBeFocused();
});

test('quitar un chip conserva el otro filtro, reinicia página y mantiene historial y recuperación',async({page},info)=>{
 test.setTimeout(90000);
 await login(page);await navigate(page,'Pedidos');
 await openDisclosure(page,/^Filtros de pedidos/);
 await page.getByRole('group',{name:'Atajos de pedidos'}).getByRole('button',{name:'Con novedad',exact:true}).click();
 const search=page.getByRole('textbox',{name:'Buscar pedidos'});
 await search.fill('sin-coincidencias-e2e');await expect(search).toBeFocused();
 await expect(page).toHaveURL(url=>url.searchParams.get('q')==='sin-coincidencias-e2e'&&url.searchParams.get('issue')==='incident');
 const withBoth=page.url();
 await page.locator('summary').filter({hasText:/^Filtros de pedidos/}).click();
 await page.getByRole('button',{name:'Quitar filtro: Búsqueda: sin-coincidencias-e2e',exact:true}).click();
 await expect(page).toHaveURL(url=>!url.searchParams.has('q')&&url.searchParams.get('issue')==='incident'&&!url.searchParams.has('page'));
 await expect(page.getByRole('button',{name:/^Quitar filtro: Atención:/})).toBeVisible();
 await page.goBack();await expect(page).toHaveURL(withBoth);await expect(search).toHaveValue('sin-coincidencias-e2e');
 await page.goForward();await expect(search).toHaveValue('');
 await page.getByRole('button',{name:/^Quitar filtro: Atención:/}).click();
 await expect(page).toHaveURL(url=>!url.searchParams.has('issue'));
 await expect(page.getByRole('button',{name:/^Quitar filtro:/})).toHaveCount(0);
 const reading=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/orders'&&response.request().method()==='GET');
 await page.reload();const read=await reading;
 const headers={Origin:new URL(page.url()).origin,'x-csrf-token':await read.request().headerValue('x-csrf-token')};
 const products=(await (await page.request.get('/api/admin/products')).json()).records;
 const product=products.find(record=>record.slug==='creatina-vital-force-70-servicios');
 const marker=`Paginación chip ${info.project.name} ${info.retry}`;
 for(let index=0;index<21;index++){
  const response=await page.request.post('/api/admin/orders',{headers,data:{requestId:crypto.randomUUID(),placedOn:bogotaDate(),customerName:`${marker} ${index}`,phone:'3001234567',city:'Bogotá',department:'Cundinamarca',address:'Dirección sintética de prueba',status:'new',deliveryMethod:'carrier',shippingChargeMinor:0,items:[{lineId:crypto.randomUUID(),kind:'products',itemId:product.id,quantity:1,unitPriceMinor:Math.round(product.price*100),discountMinor:0}]}});
  expect(response.status()).toBe(201);
 }
 await search.fill(marker);await openDisclosure(page,/^Filtros de pedidos/);await page.getByRole('combobox',{name:'Estado del pedido',exact:true}).selectOption('new');
 await expect(page.getByRole('button',{name:'Siguiente',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Siguiente',exact:true}).click();await expect(page).toHaveURL(url=>url.searchParams.get('page')==='2');
 await page.getByRole('button',{name:'Quitar filtro: Pedido: Nuevo',exact:true}).click();
 await expect(page).toHaveURL(url=>url.searchParams.get('q')===marker&&!url.searchParams.has('status')&&!url.searchParams.has('page'));
 await expect(page.getByText('Página 1 de 2',{exact:true})).toBeVisible();
 const fail=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Lectura temporalmente no disponible (prueba de recuperación)'})});
 await page.route('**/api/admin/orders?*',fail);
 await search.fill(`${marker} 0`);
 const retry=page.getByRole('alert').filter({hasText:'Lectura temporalmente no disponible'}).getByRole('button',{name:'Reintentar',exact:true});
 await expect(retry).toBeVisible();await page.unroute('**/api/admin/orders?*',fail);await retry.click();
 await expect(visibleRecord(page,`${marker} 0`)).toHaveCount(1);await expect(retry).toHaveCount(0);
});

test('comisiones porcentuales conservan centésimas, invalidez, guardas y versiones históricas',async({page},info)=>{
 test.setTimeout(90000);
 await login(page);await navigate(page,'Configuración');
 await openConfigurationTask(page,'rules');
 const before=await (await page.request.get('/api/admin/business/settings')).json();
 const storedBefore={...before};delete storedBefore.automation;
 const nextDate=new Date(`${before.rulesVersions.at(-1).effectiveOn}T12:00:00Z`);nextDate.setUTCDate(nextDate.getUTCDate()+1);
 await page.getByRole('button',{name:'Agregar nueva vigencia',exact:true}).click();
 const drawer=page.getByRole('dialog'),rate=drawer.getByLabel('Comisión (%)',{exact:true}),save=drawer.getByRole('button',{name:'Agregar vigencia',exact:true});
 await drawer.getByLabel('Vigente desde (Bogotá)',{exact:true}).fill(nextDate.toISOString().slice(0,10));
 await drawer.getByLabel('Generar comisión para ventas con vendedor').check();
 await drawer.getByLabel('Motivo del cambio').fill('Regresión de comisión porcentual exacta');
 await drawer.getByLabel('Revisé la fecha de vigencia y entiendo que no cambia los pedidos anteriores.').check();
 for(const value of ['0','100']){
  await rate.fill(value);await rate.blur();await expect(rate).not.toHaveAttribute('aria-invalid','true');await expect(save).toBeEnabled();
 }
 for(const value of ['','-1','100,01','5,2.5','5.255']){
  await rate.fill(value);await rate.blur();await expect(rate).toHaveAttribute('aria-invalid','true');
  await expect(save).toBeDisabled();
  const storedCurrent=await (await page.request.get('/api/admin/business/settings')).json();delete storedCurrent.automation;
  expect(storedCurrent).toEqual(storedBefore);
 }
 const url=page.url();let rejected=0;
 const reject=async dialog=>{expect(dialog.type()).toBe('confirm');rejected++;await dialog.dismiss();};
 page.on('dialog',reject);
 await page.setViewportSize({width:390,height:844});await expect(rate).toHaveValue('5.255');await expect(page).toHaveURL(url);
 await page.evaluate(()=>history.back());await expect.poll(()=>rejected).toBe(1);
 await expect(rate).toHaveValue('5.255');await expect(page).toHaveURL(url);
 await page.setViewportSize({width:1440,height:900});await expect(rate).toHaveValue('5.255');await expect(page).toHaveURL(url);
 await drawer.getByLabel('Forma de comisión').selectOption('fixed');await expect(save).toBeEnabled();
 await drawer.getByLabel('Forma de comisión').selectOption('percent');await rate.fill('incorrecto');
 await drawer.getByLabel('Generar comisión para ventas con vendedor').uncheck();await expect(save).toBeEnabled();
 await drawer.getByLabel('Generar comisión para ventas con vendedor').check();await rate.fill('5,25');await rate.blur();await expect(rate).toHaveValue('5,25');
 page.off('dialog',reject);
 const saving=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/business/settings'&&response.request().method()==='PUT');
 await save.click();expect((await saving).status()).toBe(200);await expect(drawer).toHaveCount(0);
 const after=await (await page.request.get('/api/admin/business/settings')).json();
 expect(after.version).toBe(before.version+1);
 expect(after.rulesVersions.slice(0,-1)).toEqual(before.rulesVersions);
 expect(after.rulesVersions.at(-1).commission.rateBps).toBe(525);
 await page.getByRole('button',{name:'Agregar nueva vigencia',exact:true}).click();
 await expect(rate).toHaveValue('5,25');await drawer.getByRole('button',{name:'Cancelar edición'}).click();
 await page.getByLabel('Cambiar de tarea').selectOption('people');
 await page.getByRole('button',{name:'Crear persona',exact:true}).click();
 const personName=`Comisión exacta ${info.project.name} ${info.retry}`;
 await drawer.getByLabel('Nombre',{exact:true}).fill(personName);
 await openDisclosure(drawer,/^Comisión particular/);
 await drawer.getByRole('button',{name:'Agregar vigencia de comisión'}).click();
 await drawer.getByLabel('Generar comisión para ventas con vendedor').check();await rate.fill('5.25');await rate.blur();await expect(rate).toHaveValue('5,25');
 const creating=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/business/people'&&response.request().method()==='POST');
 await drawer.getByRole('button',{name:'Crear persona',exact:true}).click();
 const response=await creating;expect(response.status()).toBe(201);const person=await response.json();expect(person.commissionOverrides[0].rateBps).toBe(525);
 await expect(drawer).toHaveCount(0);
 await visibleRecord(page,personName).getByRole('button',{name:'Editar persona'}).click();
 await openDisclosure(drawer,/^Comisión particular/);await expect(drawer.getByText(/5,25 %/)).toBeVisible();
 await drawer.getByRole('button',{name:'Agregar vigencia de comisión'}).click();await drawer.getByLabel('Generar comisión para ventas con vendedor').check();
 await rate.fill('5.555');await expect(drawer.getByRole('button',{name:'Guardar persona'})).toBeDisabled();
 const stored=await (await page.request.get(`/api/admin/business/people/${person.id}`)).json();expect(stored).toEqual(person);
 page.once('dialog',dialog=>dialog.accept());await drawer.getByRole('button',{name:'Cancelar edición'}).click();
 await expect(drawer).toHaveCount(0);expect(await (await page.request.get(`/api/admin/business/people/${person.id}`)).json()).toEqual(person);
});

test('importación conserva archivo y resolver: Cancelar y Esc confirman el mismo descarte',async({page},info)=>{
 test.setTimeout(180000);
 await login(page);await navigate(page,'Pedidos');await selectWorkspace(page,'Vistas de pedidos','Importar Excel');
 await openDisclosure(page,'Crear plataforma por nombre');
 await page.getByLabel('Nombre de la plataforma',{exact:true}).fill(`Origen resolver ${info.project.name} ${info.retry}`);
 await page.getByRole('button',{name:'Crear plataforma y cuenta Principal'}).click();
 const bytes=writeExcelSheets([{name:'Seguimiento',rows:[['ID','Guía','Transportadora','Estado'],['RESOLVER-1','000001234','Transportadora E2E','Estado sin equivalencia']]}]);
 await page.getByLabel('Archivo Excel',{exact:true}).setInputFiles({name:`resolver-${info.project.name}.xlsx`,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:bytes});
 await page.getByRole('button',{name:'Guardar archivo y continuar'}).click();
 await expect(page.getByRole('combobox',{name:'Hoja',exact:true})).toBeVisible({timeout:75000});
 await page.getByRole('combobox',{name:'Hoja',exact:true}).selectOption('Seguimiento');
 await page.getByRole('combobox',{name:'Qué contiene el archivo',exact:true}).selectOption('tracking');
 await page.getByLabel('Fecha de corte del reporte, si no existe columna').fill('2026-01-01');
 const samples=page.getByRole('button',{name:'Leer muestras de esta hoja y encabezado',exact:true});
 if(await samples.isEnabled()){
  await samples.click();await expect(samples).toBeDisabled();
 }
 for(const [index,destination] of ['externalShipmentId','tracking','carrier','rawStatus'].entries())await page.getByRole('combobox',{name:`Destino de columna ${index+1}`,exact:true}).selectOption(destination);
 await page.getByRole('button',{name:'Guardar columnas y revisar',exact:true}).click();
 const opener=page.getByRole('button',{name:'Aceptar valores guardados de fórmulas',exact:true});
 await expect(opener).toBeVisible({timeout:75000});await opener.click();
 const resolver=page.getByRole('dialog',{name:'Aceptar valores guardados de fórmulas',exact:true});
 await resolver.getByLabel('Motivo de la resolución').fill('Borrador de resolución que se conserva');
 const messages=[];const reject=async dialog=>{messages.push(dialog.message());await dialog.dismiss();};page.on('dialog',reject);
 await resolver.getByRole('button',{name:'Cancelar resolución'}).click();await expect.poll(()=>messages.length).toBe(1);
 await expect(resolver.getByLabel('Motivo de la resolución')).toHaveValue('Borrador de resolución que se conserva');
 await page.keyboard.press('Escape');await expect.poll(()=>messages.length).toBe(2);expect(messages[0]).toBe(messages[1]);
 await expect(resolver).toBeVisible();page.off('dialog',reject);page.once('dialog',dialog=>dialog.accept());
 await resolver.getByRole('button',{name:'Cancelar resolución'}).click();await expect(resolver).toHaveCount(0);await expect(opener).toBeFocused();
 await expect(page.getByRole('button',{name:'Descargar original privado'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Descargar filas rechazadas XLSX'})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Confirmar e importar',exact:true})).toHaveCount(0);
 const resumeURL=page.url();
 const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'Descargar original privado'}).click();
 const original=await downloading;expect(original.suggestedFilename()).toBe(`resolver-${info.project.name}.xlsx`);expect(await original.failure()).toBeNull();
 await page.reload();await expect(page).toHaveURL(resumeURL);
 await expect(page.getByRole('button',{name:'Aceptar valores guardados de fórmulas',exact:true})).toBeVisible({timeout:30000});
});

test('vitrina móvil: destinos nativos, búsqueda de combos y continuidad de pedido y tema',async({page},info)=>{
 test.setTimeout(120000);
 await login(page);await navigate(page,'Datos y publicación');
 const original=await (await page.request.get('/api/admin/settings')).json();
 const checkbox=page.getByLabel('Publicar la vitrina (contenido revisado y aprobado)',{exact:true});
 await expect(page.getByText(original.launchApproved?'Estado guardado: vitrina publicada':'Estado guardado: modo preparación',{exact:true})).toBeVisible();
 await checkbox.setChecked(!original.launchApproved);
 await expect(page.getByText(original.launchApproved?'Estado guardado: vitrina publicada':'Estado guardado: modo preparación',{exact:true})).toBeVisible();
 await expect(page.getByText(/Selección pendiente:/)).toBeVisible();
 await checkbox.check();
 const saving=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/settings'&&response.request().method()==='PUT');
 await page.getByRole('button',{name:'Guardar configuración',exact:true}).click();
 const savedResponse=await saving;expect(savedResponse.status()).toBe(200);
 const headers={Origin:new URL(page.url()).origin,'x-csrf-token':await savedResponse.request().headerValue('x-csrf-token')};
 const products=(await (await page.request.get('/api/admin/products')).json()).records;
 const product=products.find(record=>record.slug==='creatina-vital-force-70-servicios');
 const catalogs=(await (await page.request.get('/api/admin/catalogs')).json()).records;
 const catalog=catalogs.find(record=>record.id===product.catalogIds[0]);
 const marker=`Zetacombo${info.project.name.replace(/\W/g,'')}${info.retry}`;
 const comboResponse=await page.request.post('/api/admin/combos',{headers,data:{...emptyRecord('combos'),title:marker,slug:marker.toLowerCase(),status:'published',price:110000,items:[{productId:product.id,quantity:1}],catalogIds:[catalog.id]}});
 expect(comboResponse.status()).toBe(201);const combo=await comboResponse.json();
 try{
  await page.emulateMedia({colorScheme:'light'});
  await page.setViewportSize({width:390,height:844});await page.goto('/');
  const menu=page.getByRole('dialog',{name:'Menú de navegación',exact:true});
  async function menuLink(label,id){
   await page.getByRole('button',{name:'Menú',exact:true}).click();
   const link=menu.getByRole('link',{name:label,exact:true});await expect(link).toHaveAttribute('href',`/#${id}`);await link.click();
   await expect(menu).not.toBeVisible();await expect(page).toHaveURL(url=>url.hash===`#${id}`);
   await expect.poll(()=>page.locator(`#${id}`).evaluate(element=>{const rect=element.getBoundingClientRect(),header=document.querySelector('.site-header').getBoundingClientRect();return rect.top>=header.bottom-2&&rect.top<window.innerHeight;})).toBe(true);
  }
  for(const route of ['/',`/productos/${product.slug}`,`/combos/${combo.slug}`,`/catalogos/${catalog.slug}`]){
   await page.goto(route);await menuLink('Catálogo','catalogo');
  }
  for(const [label,id] of [['Combos','combos'],['Cómo comprar','como-comprar'],['Contacto','contacto']])await menuLink(label,id);
  await page.getByRole('button',{name:'Menú',exact:true}).click();await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Menú',exact:true})).toBeFocused();
  await page.getByRole('button',{name:/^Ver pedido, 0 unidades$/}).click();
  const cart=page.getByRole('dialog',{name:/^Mi pedido\b/});
  await expect(cart.getByRole('link',{name:'Elegir productos'})).toHaveAttribute('href','/#catalogo');
  await page.screenshot({path:info.outputPath('empty-public-order.png')});
  await cart.getByRole('link',{name:'Elegir productos'}).click();await expect(cart).not.toBeVisible();
  await expect.poll(()=>page.locator('#catalogo').evaluate(element=>element.getBoundingClientRect().top>=document.querySelector('.site-header').getBoundingClientRect().bottom-2&&element.getBoundingClientRect().top<window.innerHeight)).toBe(true);
  const search=page.getByRole('searchbox',{name:'Buscar productos y combos'});
  await search.fill(marker);await expect(page.locator('.catalog-count[aria-live="polite"]')).toHaveText('0 productos · 1 combo');
  await expect(page.locator('article.product-card')).toHaveCount(0);await expect(page.locator('article.combo-card')).toHaveCount(1);
  await page.getByRole('link',{name:'Ver 1 combo',exact:true}).click();await expect(page).toHaveURL(/#combos$/);
  await search.fill('sin-coincidencia-982177');
  await expect(page.locator('.catalog-count[aria-live="polite"]')).toHaveText('0 productos · 0 combos');
  await expect(page.getByRole('button',{name:'Limpiar búsqueda y filtros',exact:true})).toHaveCount(1);
  await menuLink('Combos','combos');await expect(page.locator('#combos')).toBeVisible();
  await expect(page.locator('#combos').getByRole('heading',{name:'No hay combos que coincidan.',exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'No encontramos productos ni combos.',exact:true})).toHaveCount(1);
  await page.getByRole('button',{name:'Limpiar búsqueda y filtros',exact:true}).click();
  await expect(search).toHaveValue('');await expect(page.locator('article.combo-card').filter({hasText:marker})).toBeVisible();
  const productCard=page.locator('article.product-card').filter({hasText:product.title});
  await productCard.getByRole('button',{name:'Añadir a mi pedido',exact:true}).click();
  await page.locator('article.combo-card').filter({hasText:marker}).getByRole('button',{name:'Añadir a mi pedido',exact:true}).click();
  await page.getByRole('button',{name:'Ver pedido, 2 unidades',exact:true}).click();
  const quantity=cart.getByRole('group',{name:`Cantidad de ${product.title}`,exact:true});
  for(const button of await quantity.getByRole('button').all()){
   const bounds=await button.boundingBox();expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.height).toBeGreaterThanOrEqual(44);
  }
  await quantity.getByRole('button',{name:'Aumentar cantidad'}).click();
  await expect(quantity.locator('output')).toHaveText('2');await expect(cart.getByText('Subtotal · 3 unidades',{exact:true})).toBeVisible();
  await expect(cart.locator('[data-cart-total]')).toContainText(money(product.price*2+combo.price));
  let message=new URL(await cart.getByRole('link',{name:/Continuar por WhatsApp/}).getAttribute('href')).searchParams.get('text');
  expect(message).toContain(`2 × ${product.title}`);expect(message).toContain(`1 × ${combo.title}`);expect(message).toContain(money(product.price*2+combo.price));
  await quantity.getByRole('button',{name:'Reducir cantidad'}).click();await expect(quantity.getByRole('button',{name:'Reducir cantidad'})).toBeDisabled();
  await cart.getByRole('button',{name:`Quitar ${combo.title}`,exact:true}).click();await expect(cart.getByText('Subtotal · 1 unidad',{exact:true})).toBeVisible();
  message=new URL(await cart.getByRole('link',{name:/Continuar por WhatsApp/}).getAttribute('href')).searchParams.get('text');expect(message).not.toContain(combo.title);
  await cart.getByRole('button',{name:'Seguir eligiendo',exact:true}).click();
  await page.getByRole('button',{name:'Menú',exact:true}).click();await menu.getByRole('button',{name:'Cambiar a tema oscuro',exact:true}).click();
  await expect(page.locator('.storefront')).toHaveAttribute('data-theme','dark');await page.keyboard.press('Escape');
  await search.fill('Creatina');await page.getByRole('button',{name:catalog.title,exact:true}).click();
  await productCard.getByRole('heading').getByRole('link').click();await expect(page.getByRole('heading',{level:1,name:product.title,exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Ver pedido, 1 unidad',exact:true})).toBeVisible();
  await page.goBack();await expect(search).toHaveValue('Creatina');
  await expect(page.getByRole('button',{name:catalog.title,exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(productCard).toBeVisible();await expect(page.locator('.storefront')).toHaveAttribute('data-theme','dark');
  const scrollBefore=await page.evaluate(()=>window.scrollY);
  await productCard.getByRole('heading').getByRole('link').click();await page.goBack();
  await expect.poll(()=>page.evaluate(()=>window.scrollY)).toBeCloseTo(scrollBefore,-1);
  await productCard.getByRole('heading').getByRole('link').click();
  const back=page.getByRole('link',{name:'← Volver al catálogo',exact:true});await expect(back).toHaveAttribute('href','/#catalogo');await back.click();
  await expect(page.locator('article.product-card').filter({hasText:product.title})).toBeVisible();
  await page.getByRole('button',{name:'Ver pedido, 1 unidad',exact:true}).click();await expect(cart.locator('[data-cart-total]')).toContainText(money(product.price));
  await cart.getByRole('button',{name:'Cerrar pedido'}).click();
  await page.evaluate(({id})=>sessionStorage.setItem('allnutrition:order',JSON.stringify([{kind:'products',id,quantity:99},{kind:'products',id:'missing-e2e',quantity:1},{kind:'products',id:'invalid-e2e',quantity:100}])),{id:product.id});
  await page.reload();await page.getByRole('button',{name:'Ver pedido, 99 unidades',exact:true}).click();
  await expect(cart.getByRole('button',{name:'Aumentar cantidad'})).toBeDisabled();await expect(cart.locator('[data-cart-total]')).toContainText(money(product.price*99));
  await expect(cart.getByText(/no disponible/i)).toBeVisible();
  await page.screenshot({path:info.outputPath('public-order-continuity.png')});
 }finally{
  const current=await (await page.request.get('/api/admin/settings')).json();
  expect((await page.request.put('/api/admin/settings',{headers,data:{...current,launchApproved:original.launchApproved}})).status()).toBe(200);
 }
});
