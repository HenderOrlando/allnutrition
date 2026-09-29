import { test,expect } from '@playwright/test';
async function login(page){await page.goto('/admin/login');await page.getByLabel('Correo de administrador').fill('e2e@example.test');await page.getByLabel('Contraseña',{exact:true}).fill('clave-e2e-solo-pruebas');await page.getByRole('button',{name:'Entrar al panel'}).click();await expect(page.getByRole('heading',{name:'Hola, All Nutrition.'})).toBeVisible();}

test('privacidad: sin login no se ven panel, pedidos ni catálogo no aprobado',async({page,request})=>{
 await page.goto('/');await expect(page.getByRole('heading',{name:/Estamos preparando/})).toBeVisible();
 expect((await request.get('/api/admin/orders')).status()).toBe(401);
 expect((await request.get('/api/admin/settings')).status()).toBe(401);
 expect((await request.get('/productos/creatina-vital-force-70-servicios')).status()).toBe(404);
});

test('panel permite vista previa y conserva WhatsApp principal',async({page})=>{
 await login(page);await page.goto('/?preview=1');
 await expect(page.getByRole('heading',{name:/Explora el catálogo/})).toBeVisible();
 const link=page.getByRole('link',{name:'Consultar este producto'}).first();
 await expect(link).toHaveAttribute('href',/wa\.me\/573043440035/);
 await expect(page.locator('body')).not.toContainText('service_role');
});

test('crea y edita un producto usando únicamente un enlace',async({page},info)=>{
 await login(page);await page.getByRole('navigation',{name:'Administración'}).getByRole('button',{name:'Productos',exact:false}).click();
 await page.getByRole('button',{name:'Crear producto',exact:true}).click();
 const drawer=page.getByRole('dialog');
 const name=`Producto E2E ${info.project.name}`;
 await drawer.getByLabel('Nombre',{exact:false}).fill(name);
 await drawer.getByLabel('Enlace de la fotografía',{exact:true}).fill('https://images.example.com/test.jpg');
 await drawer.getByLabel('Presentación / contenido').fill('Presentación de prueba');
 await drawer.getByLabel('Precio en pesos colombianos').fill('25000');
 await expect(drawer.locator('input[type=file]')).toHaveCount(0);
 await drawer.getByRole('button',{name:'Guardar cambios'}).click();await expect(drawer).toHaveCount(0);
 await expect(page.getByText(name,{exact:true})).toBeVisible();
});

test('pedido manual: alta, estado, validación de guía e historial',async({page},info)=>{
 await login(page);await page.getByRole('navigation',{name:'Administración'}).getByRole('button',{name:'Pedidos',exact:true}).click();
 await page.getByRole('button',{name:'Nuevo pedido',exact:true}).click();const drawer=page.getByRole('dialog');
 const name=`Comprador E2E ${info.project.name}`;
 await drawer.getByLabel('Nombre completo').fill(name);await drawer.getByLabel('Celular').fill('3001234567');await drawer.getByLabel('Ciudad',{exact:false}).fill('Bogotá');await drawer.getByLabel('Departamento').fill('Cundinamarca');await drawer.getByLabel('Dirección exacta').fill('Dirección de prueba');
 await drawer.getByRole('button',{name:'Agregar referencia'}).click();
 await drawer.getByLabel('Producto o combo',{exact:true}).selectOption({label:'Creatina Monohidrato Vital Force · 70 servicios'});
 await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer).toHaveCount(0);
 await page.getByLabel('Buscar pedidos').fill(name);const row=page.getByRole('row').filter({hasText:name});await expect(row).toHaveCount(1);await row.getByRole('button',{name:'Abrir'}).click();
 await drawer.getByLabel('Estado del pedido',{exact:true}).selectOption('preparing');await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer).toHaveCount(0);
 await row.getByRole('button',{name:'Abrir'}).click();await drawer.getByLabel('Estado del pedido',{exact:true}).selectOption('sent');await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer.getByRole('alert')).toContainText('transportadora y guía');
 await drawer.getByLabel('Transportadora',{exact:true}).fill('Transportadora prueba');await drawer.getByLabel('Número de guía').fill(`E2E-${info.project.name}`);await drawer.getByRole('button',{name:'Guardar pedido'}).click();await expect(drawer).toHaveCount(0);await row.getByRole('button',{name:'Abrir'}).click();await expect(drawer.getByRole('heading',{name:'Historial de cambios'})).toBeVisible();
});
