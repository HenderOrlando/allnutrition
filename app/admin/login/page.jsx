import { redirect } from 'next/navigation';
import { session } from '@/lib/server.mjs';
import Login from '@/components/Login';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const metadata={title:'Ingreso al panel',robots:{index:false,follow:false}};
export default async function Page(){if(await session())redirect('/admin');return <Login/>;}
