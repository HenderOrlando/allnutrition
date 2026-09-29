import { notFound } from 'next/navigation';
import { db, session } from '@/lib/server.mjs';
import Storefront from '@/components/Storefront';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const kinds = {productos:'products',catalogos:'catalogs',combos:'combos'};
export async function generateMetadata({params}) {
 const {section,slug}=await params, kind=kinds[section];if(!kind)return {};
 const store=await db(), settings=await store.settings();
 if(!settings.launchApproved&&!await session())return {title:settings.brandName,robots:{index:false,follow:false}};
 const record=await store.bySlug(kind,slug);
 return {title:record?.title||'No encontrado',description:record?.description||settings.tagline,robots:{index:settings.launchApproved,follow:settings.launchApproved}};
}
export default async function Page({params}) {
 const {section,slug}=await params,kind=kinds[section];if(!kind)notFound();
 const store=await db(),settings=await store.settings();if(!settings.launchApproved&&!await session())notFound();
 const data=await store.publicData(),record=data[kind].find(r=>r.slug===slug);if(!record)notFound();
 return <Storefront data={data} selected={kind==='catalogs'?null:{...record,kind}} initialCatalog={kind==='catalogs'?record.id:null}/>;
}
