import { redirect } from 'next/navigation';
import { session } from '@/lib/server.mjs';
import Login from '@/components/Login';
import { adminReturnTo } from '@/lib/admin-view.mjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export const metadata={title:'Ingreso al panel',robots:{index:false,follow:false}};
export default async function Page({searchParams}){
 const params=await searchParams;
 const next=Array.isArray(params?.next)?params.next[0]:params?.next;
 const returnTo=adminReturnTo(next);
 if(await session())redirect(returnTo);
 return <Login returnTo={returnTo}/>;
}
