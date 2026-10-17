import { redirect } from 'next/navigation';
import { session } from '@/lib/server.mjs';
import Admin from '@/components/Admin';
import { adminHref, adminSections, readAdminView } from '@/lib/admin-view.mjs';
import { adminLocationLabel } from '@/components/admin-tasks.mjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export async function generateMetadata({searchParams}){
 const view=readAdminView(await searchParams),configuration=adminSections.find(section=>section.id===view.section)?.area==='business';
 const home=view.section==='business'&&(!view.tab||view.tab==='setup');
 return {title:configuration?(home?'Configuración':adminLocationLabel(view)+' · Configuración'):'Administración',robots:{index:false,follow:false}};
}
export default async function Page({searchParams}){
 const returnTo=adminHref(readAdminView(await searchParams));
 const s=await session();
 if(!s)redirect(`/admin/login?next=${encodeURIComponent(returnTo)}`);
 return <Admin csrf={s.csrf} user={s.user}/>;
}
