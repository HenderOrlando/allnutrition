import sharp from 'sharp';

export const runtime = 'nodejs';
export const dynamic = 'force-static';
export const dynamicParams = false;
export const generateStaticParams = () => [{ size:'192' }, { size:'512' }];

const icon = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><rect width="192" height="192" fill="#18231a"/><path fill="#b7ef70" d="M96 46 50 69v53l46 24 46-24V69z"/><path fill="none" stroke="#18231a" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" d="m52 70 44 23 44-23m-44 23v49M75 58l44 23v18"/></svg>');

export async function GET(_request, { params }) {
  const { size } = await params;
  if (size !== '192' && size !== '512') return new Response(null, { status:404 });
  const image = await sharp(icon, { density:192 }).resize(Number(size), Number(size)).png().toBuffer();
  return new Response(image, { headers:{ 'Content-Type':'image/png', 'Cache-Control':'public, max-age=86400' } });
}
