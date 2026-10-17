import { expect } from '@playwright/test';
import { adminAreas, adminSections } from '../../lib/admin-view.mjs';

export async function login(page){
 await page.goto('/admin/login');
 await page.getByLabel('Correo de administrador').fill('e2e@example.test');
 await page.getByLabel('Contraseña',{exact:true}).fill('clave-e2e-solo-pruebas');
 const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/auth/login'&&response.request().method()==='POST');
 await page.getByRole('button',{name:'Entrar al panel'}).click();
 expect((await responsePromise).status()).toBe(200);
 await expect(page).toHaveURL(url=>url.pathname==='/admin');
 expect((await page.request.get('/api/admin/orders')).status()).toBe(200);
}

export async function navigate(page,destination){
 const section=adminSections.find(section=>section.label===destination);
 if(!section)throw new Error(`Destino de administración desconocido: ${destination}`);
 const area=adminAreas.find(area=>area.id===section.area);
 const nav=page.getByRole('navigation',{name:'Administración',exact:true}).and(page.locator(':visible'));
 await expect(nav).toBeVisible();
 const button=nav.getByRole('button',{name:area.label,exact:true});
 if(await button.count()){
  await button.click();
 }else{
  await nav.getByRole('button',{name:'Más',exact:true}).click();
  const menu=page.getByRole('dialog',{name:'Todas tus secciones',exact:true});
  await menu.getByRole('navigation',{name:'Administración',exact:true}).getByRole('button',{name:area.label,exact:true}).click();
  await expect(menu).toHaveCount(0);
 }
 if(section.id!==area.id){
  const subnav=page.getByRole('navigation',{name:section.area==='products'?'Vistas de productos':'Vistas de configuración',exact:true});
  if(section.area==='business')await subnav.locator(`[data-configuration-task="${section.id}"]`).click();
  else await subnav.getByRole('button',{name:destination,exact:true}).click();
 }
 await expect(page).toHaveURL(url=>(url.searchParams.get('section')||'home')===section.id);
}

export async function signOut(page){
 const button=page.getByRole('button',{name:'Cerrar sesión',exact:true}).and(page.locator(':visible'));
 if(await button.count()){
  await button.click();
 }else{
  const nav=page.getByRole('navigation',{name:'Administración',exact:true}).and(page.locator(':visible'));
  await nav.getByRole('button',{name:'Más',exact:true}).click();
  await page.getByRole('dialog',{name:'Todas tus secciones',exact:true}).getByRole('button',{name:'Cerrar sesión',exact:true}).click();
 }
}

export function visibleRecord(page,text){
 return page.getByRole('row').or(page.getByRole('listitem')).and(page.locator(':visible')).filter({hasText:text});
}
