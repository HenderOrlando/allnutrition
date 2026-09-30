import { expect } from '@playwright/test';

export async function login(page){
 await page.goto('/admin/login');
 await page.getByLabel('Correo de administrador').fill('e2e@example.test');
 await page.getByLabel('Contraseña',{exact:true}).fill('clave-e2e-solo-pruebas');
 await page.getByRole('button',{name:'Entrar al panel'}).click();
 await expect(page).toHaveURL(url=>url.pathname==='/admin');
 expect((await page.request.get('/api/admin/orders')).status()).toBe(200);
}
