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
 if(section.area==='products'){
  await selectWorkspace(page,'Vistas de productos',destination);
 }else if(section.id!==area.id){
  const subnav=page.getByRole('navigation',{name:'Vistas de configuración',exact:true});
  const selector=subnav.getByRole('combobox',{name:'Cambiar de tarea',exact:true});
  if(await selector.isVisible())await selector.selectOption(section.id);
  else await openConfigurationTask(page,section.id);
 }
 await expect(page).toHaveURL(url=>(url.searchParams.get('section')||'home')===section.id);
}

export async function openConfigurationTask(page,id){
 const task=page.locator(`[data-configuration-task="${id}"]`);
 if(!await task.isVisible())await page.locator('[data-configuration-advanced] > summary').click();
 await task.click();
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

export async function selectWorkspace(scope,label,destination){
 const nav=scope.getByRole('navigation',{name:label,exact:true});
 const selector=nav.getByRole('combobox');
 if(await selector.isVisible()){
  await selector.selectOption({label:destination});
  await expect(selector.locator('option:checked')).toHaveText(destination);
 }else{
  const button=nav.getByRole('button',{name:destination,exact:true});
  await button.click();
  await expect(button).toHaveAttribute('aria-current','page');
 }
}

export async function openDisclosure(scope,label){
 const summary=scope.locator('summary').filter({hasText:label});
 await expect(summary).toHaveCount(1);
 if(!await summary.evaluate(element=>element.parentElement.open))await summary.click();
}

export async function openCashOperation(page,label){
 const action=page.getByRole('button',{name:label,exact:true});
 if(!await action.isVisible())await openDisclosure(page,/^(Registrar operación|Otras operaciones)$/);
 await action.click();
}

export function visibleRecord(page,text){
 return page.getByRole('row').or(page.getByRole('listitem')).and(page.locator(':visible')).filter({hasText:text});
}
