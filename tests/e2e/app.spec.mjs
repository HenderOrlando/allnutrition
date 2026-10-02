import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import { test,expect } from '@playwright/test';
import { login } from './helpers.mjs';

test('privacidad: sin login no se ven panel, pedidos ni catálogo no aprobado',async({page,request},info)=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:/Estamos preparando/})).toBeVisible();
 await page.screenshot({path:info.outputPath('preparation.png'),fullPage:true});
 expect((await request.get('/api/admin/orders')).status()).toBe(401);
 expect((await request.get('/api/admin/settings')).status()).toBe(401);
 expect((await request.get('/api/admin/upload')).status()).toBe(401);
 expect((await request.post('/api/admin/upload',{data:'not-an-image'})).status()).toBe(401);
 expect((await request.get('/productos/creatina-vital-force-70-servicios')).status()).toBe(404);
 await page.goto('/admin/login');
 await expect(page.getByLabel('Correo de administrador')).toBeVisible();
 await page.screenshot({path:info.outputPath('login.png'),fullPage:true});
});

test('panel permite vista previa y conserva WhatsApp principal',async({page},info)=>{
 await login(page);
 await expect(page.getByRole('navigation',{name:'Administración'})).toBeVisible();
 await page.screenshot({path:info.outputPath('panel.png'),fullPage:true});
 await page.goto('/?preview=1');
 await expect(page.getByRole('heading',{name:/Explora el catálogo/})).toBeVisible();
 const product=page.locator('article.product-card').first();
 await expect(product).toBeVisible();
 const title=await product.getByRole('heading',{level:3}).innerText();
 const link=product.locator('a[href^="https://wa.me/"]');
 await expect(link).toBeVisible();
 const destination=new URL(await link.getAttribute('href'));
 expect(destination.protocol).toBe('https:');
 expect(destination.hostname).toBe('wa.me');
 expect(destination.pathname).toBe('/573043440035');
 expect(destination.searchParams.get('text')).toContain(title);
 await page.screenshot({path:info.outputPath('catalog-preview.png'),fullPage:true});
});

test('crea y edita un producto conservando un enlace HTTPS externo',async({page},info)=>{
 await login(page);await page.getByRole('navigation',{name:'Administración'}).getByRole('button',{name:'Productos',exact:false}).click();
 await page.getByRole('button',{name:'Crear producto',exact:true}).click();
 const drawer=page.getByRole('dialog');
 const name=`Producto E2E ${info.project.name}`;
 await drawer.getByLabel('Nombre',{exact:false}).fill(name);
 await drawer.getByRole('button',{name:'Ingresar URL HTTPS'}).click();
 await drawer.getByLabel('URL pública de la fotografía',{exact:true}).fill('https://images.example.com/test.jpg');
 await drawer.getByLabel('Presentación / contenido').fill('Presentación de prueba');
 await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
 await drawer.getByRole('button',{name:'Crear producto'}).click();await expect(drawer).toHaveCount(0);
 const row=page.getByRole('row').filter({hasText:name});
 await expect(row).toHaveCount(1);
 await row.getByRole('button',{name:'Editar'}).click();
 await drawer.getByLabel('Precio en pesos colombianos').fill('26000');
 await drawer.getByRole('button',{name:'Guardar cambios'}).click();await expect(drawer).toHaveCount(0);
 await row.getByRole('button',{name:'Editar'}).click();
 await expect(drawer.getByLabel('Precio en pesos colombianos')).toHaveValue('26000');
 await drawer.getByRole('button',{name:'Cerrar editor'}).click();
 await expect(drawer).toHaveCount(0);
});
test('sube una imagen local optimizada y la muestra en la vitrina pública',async({page,request},info)=>{
 await login(page);await page.getByRole('navigation',{name:'Administración'}).getByRole('button',{name:'Productos',exact:false}).click();
 await page.getByRole('button',{name:'Crear producto',exact:true}).click();
 const drawer=page.getByRole('dialog'),name=`Producto imagen local ${info.project.name}`;
 await drawer.getByLabel('Nombre',{exact:false}).fill(name);
 await expect(drawer.getByRole('heading',{name:'Información básica'})).toBeVisible();
 await expect(drawer.getByRole('heading',{name:'Imagen del producto'})).toBeVisible();
 await expect(drawer.getByLabel('URL pública de la fotografía',{exact:true})).toHaveCount(0);
 await drawer.getByLabel('Presentación / contenido').fill('Presentación de prueba');
 await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
 await drawer.getByLabel('Publicación').selectOption('published');
 const temp=mkdtempSync(join(tmpdir(),'allnutrition-e2e-media-')),file=join(temp,'product-upload.png');
 writeFileSync(file,await sharp({create:{width:3200,height:1600,channels:3,background:{r:38,g:112,b:83}}}).png().toBuffer());
 try{await drawer.getByLabel('Archivo de imagen del producto').setInputFiles(file);}finally{rmSync(temp,{recursive:true,force:true});}
 await expect(drawer.getByLabel('URL pública de la fotografía',{exact:true})).toHaveCount(0);
 const preview=drawer.locator('.image-picker img'),slug=await drawer.getByLabel('Dirección corta (sin espacios)').inputValue();
 const imageUrl=await preview.getAttribute('src');
 expect(imageUrl).toMatch(/^\/api\/media\/[0-9a-f-]{36}$/);await expect(preview).toBeVisible();
 await expect.poll(()=>preview.evaluate(image=>image.naturalWidth)).toBe(2400);
 await expect(drawer.getByRole('status').filter({hasText:'Almacenamiento local de imágenes'})).toContainText('1 GB');
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

test('pedido manual: alta, estado, validación de guía e historial',async({page},info)=>{
 await login(page);await page.getByRole('navigation',{name:'Administración'}).getByRole('button',{name:'Pedidos',exact:true}).click();
 await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();const drawer=page.getByRole('dialog');
 const name=`Comprador E2E ${info.project.name}`;
 await drawer.getByRole('textbox',{name:/Nombre completo/}).fill(name);await drawer.getByRole('textbox',{name:/Celular/}).fill('3001234567');await drawer.getByRole('textbox',{name:/Ciudad/}).fill('Bogotá');await drawer.getByRole('textbox',{name:'Departamento',exact:true}).fill('Cundinamarca');await drawer.getByRole('textbox',{name:'Dirección exacta',exact:true}).fill('Dirección de prueba');
 await drawer.getByRole('button',{name:'Agregar referencia'}).click();
 await drawer.getByRole('combobox',{name:'Producto o combo',exact:true}).selectOption({label:'Creatina Monohidrato Vital Force · 70 servicios'});
 await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer).toHaveCount(0);
 await page.getByRole('textbox',{name:'Buscar pedidos'}).fill(name);const row=page.getByRole('row').filter({hasText:name});await expect(row).toHaveCount(1);await row.getByRole('button',{name:'Abrir'}).click();
 await drawer.getByRole('combobox',{name:'Estado del pedido',exact:true}).selectOption('preparing');await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer).toHaveCount(0);
 await row.getByRole('button',{name:'Abrir'}).click();await drawer.getByRole('combobox',{name:'Estado del pedido',exact:true}).selectOption('sent');await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer.getByRole('alert')).toContainText('transportadora y guía');
 await drawer.getByRole('textbox',{name:'Transportadora',exact:true}).fill('Transportadora prueba');await drawer.getByRole('textbox',{name:'Número de guía',exact:true}).fill(`E2E-${info.project.name}`);await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer).toHaveCount(0);await row.getByRole('button',{name:'Abrir'}).click();await expect(drawer.getByRole('heading',{name:'Historial de cambios'})).toBeVisible();
});

test('crea cuentas nuevas únicamente con rol administrador',async({page,context},info)=>{
 const anonymous=await context.request.get('/api/admin/users');
 expect(anonymous.status()).toBe(401);
 await login(page);
 const origin=new URL(page.url()).origin;
 const nav=page.getByRole('navigation',{name:'Administración'});
 const listResponsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/users'&&response.request().method()==='GET');
 await nav.getByRole('button',{name:'Usuarios',exact:true}).click();
 const listResponse=await listResponsePromise;
 expect(listResponse.status()).toBe(200);
 const accounts=await listResponse.json();
 expect(accounts.users).toContainEqual({id:expect.any(String),email:'e2e@example.test',active:true,role:'administrator'});
 expect(accounts.users.every(user=>!Object.hasOwn(user,'password'))).toBe(true);
 expect(JSON.stringify(accounts)).not.toContain('scrypt:');
 const csrf=await listResponse.request().headerValue('x-csrf-token');
 expect(Boolean(csrf)).toBe(true);
 await expect(page.getByRole('heading',{name:'Agregar usuario'})).toBeVisible();
 await expect(page.getByText('Rol único disponible')).toBeVisible();

 const noCsrf=await context.request.post('/api/admin/users',{headers:{Origin:origin},data:{email:'sin-csrf@example.test',password:'clave-nueva-e2e-administrador',role:'administrator'}});
 expect(noCsrf.status()).toBe(403);
 const invalidRole=await context.request.post('/api/admin/users',{headers:{Origin:origin,'x-csrf-token':csrf},data:{email:'rol-invalido@example.test',password:'clave-nueva-e2e-administrador',role:'user'}});
 expect(invalidRole.status()).toBe(400);
 const afterRejection=await context.request.get('/api/admin/users');
 expect((await afterRejection.json()).users.some(user=>['sin-csrf@example.test','rol-invalido@example.test'].includes(user.email))).toBe(false);

 const email=`nuevo-admin-${info.project.name}-${info.retry}@example.test`;
 const password='clave-nueva-e2e-administrador';
 await page.getByLabel('Correo electrónico').fill(email);
 await page.getByLabel('Contraseña inicial').fill(password);
 await page.getByLabel('Confirmar contraseña').fill(`${password}-incorrecta`);
 await page.getByRole('button',{name:'Crear usuario'}).click();
 await expect(page.getByRole('region',{name:'Agregar usuario'}).getByRole('alert')).toContainText('Las contraseñas no coinciden.');
 await page.getByLabel('Confirmar contraseña').fill(password);
 const createResponsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/admin/users'&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Crear usuario'}).click();
 const createResponse=await createResponsePromise;
 expect(createResponse.status()).toBe(201);
 expect(await createResponse.json()).toEqual({user:{email,role:'administrator'}});
 const row=page.getByRole('row').filter({hasText:email});
 await expect(row).toHaveCount(1);
 await expect(row).toContainText('Administrador');

 const duplicate=await context.request.post('/api/admin/users',{headers:{Origin:origin,'x-csrf-token':csrf},data:{email,password,role:'administrator'}});
 expect(duplicate.status()).toBe(409);
 const afterDuplicate=await context.request.get('/api/admin/users');
 expect((await afterDuplicate.json()).users.filter(user=>user.email===email)).toHaveLength(1);

 await page.locator('header').getByRole('button',{name:'Cerrar sesión',exact:true}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/admin/login');
 await page.getByLabel('Correo de administrador').fill(email);
 await page.getByLabel('Contraseña',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Entrar al panel'}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/admin');
 expect((await page.request.get('/api/admin/orders')).status()).toBe(200);
});
