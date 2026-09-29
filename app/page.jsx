import { db, session } from '@/lib/server.mjs';
import Storefront from '@/components/Storefront';
import ComingSoon from '@/components/ComingSoon';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function generateMetadata() { const s = await (await db()).settings(); return { title:s.brandName, description:s.tagline, robots:{index:s.launchApproved,follow:s.launchApproved} }; }
export default async function Page({searchParams}) {
 const store=await db(), settings=await store.settings(), query=await searchParams;
 const preview=query?.preview==='1'&&await session();
 if(!settings.launchApproved&&!preview)return <ComingSoon settings={{brandName:settings.brandName,logo:settings.logo,tagline:settings.tagline,whatsapp:settings.whatsapp,whatsappTemplate:settings.whatsappTemplate}}/>;
 return <Storefront data={await store.publicData()}/>;
}
