import { redirect } from 'next/navigation';
import { session } from '@/lib/server.mjs';
import Admin from '@/components/Admin';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const metadata={title:'Administración',robots:{index:false,follow:false}};
export default async function Page(){const s=await session();if(!s)redirect('/admin/login');return <Admin csrf={s.csrf} user={s.user}/>;}
