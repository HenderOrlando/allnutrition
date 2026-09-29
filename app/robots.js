import { db } from '@/lib/server.mjs';
export const dynamic='force-dynamic';
export const runtime='nodejs';
export default async function robots(){const approved=(await (await db()).settings()).launchApproved;return {rules:{userAgent:'*',allow:approved?'/':undefined,disallow:approved?['/admin','/api']:['/']}};}
