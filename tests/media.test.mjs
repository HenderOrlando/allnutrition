import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  MAX_PRODUCT_IMAGE_UPLOAD_BYTES,
  PRODUCT_IMAGE_QUOTA_BYTES,
  productImagePath,
  productImageUsage,
  removeUnusedProductImage,
  saveProductImage,
} from '../lib/media.mjs';
import { openStore } from '../lib/db/index.mjs';
import { productData } from './contract.mjs';

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'allnutrition-media-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

async function image(format = 'png', width = 80, height = 40) {
  const source = sharp({ create: { width, height, channels: 3, background: { r: 46, g: 126, b: 92 } } });
  if (format === 'jpeg') return source.jpeg().toBuffer();
  if (format === 'webp') return source.webp().toBuffer();
  return source.png().toBuffer();
}

test('acepta JPEG, PNG y WebP y persiste la salida optimizada como WebP', async t => {
  const storage = directory(t);
  let expected = 0;
  for (const format of ['jpeg', 'png', 'webp']) {
    const saved = await saveProductImage(await image(format), { directory: storage });
    expected += saved.bytes;
    assert.match(saved.url, /^\/api\/media\/[0-9a-f-]{36}$/);
    const id = saved.url.split('/').at(-1);
    const path = await productImagePath(id, { directory: storage });
    assert.ok(path);
    const metadata = await sharp(readFileSync(path)).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 80);
    assert.equal(metadata.height, 40);
    assert.equal(saved.bytes, readFileSync(path).length);
  }
  assert.equal((await productImageUsage({ directory: storage })).used, expected);
});

test('rechaza archivos no rasterizados o con contenido distinto a JPEG, PNG y WebP', async t => {
  const storage = directory(t);
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
  for (const invalid of [Buffer.from('no es una imagen'), gif, svg]) {
    await assert.rejects(() => saveProductImage(invalid, { directory: storage }), { status: 400 });
  }
  assert.equal((await productImageUsage({ directory: storage })).used, 0);
});

test('limita la carga a 10 MiB y permite el valor exacto del límite', async t => {
  const bytes = await image();
  assert.equal(MAX_PRODUCT_IMAGE_UPLOAD_BYTES, 10 * 1024 * 1024);
  await saveProductImage(bytes, { directory: directory(t), maxInputBytes: bytes.length });
  await assert.rejects(
    () => saveProductImage(bytes, { directory: directory(t), maxInputBytes: bytes.length - 1 }),
    { status: 413 },
  );
});

test('redimensiona el lado mayor a 2400 px y conserva la proporción sin ampliar imágenes pequeñas', async t => {
  const storage = directory(t);
  const large = await saveProductImage(await image('png', 4800, 2400), { directory: storage });
  const largePath = await productImagePath(large.url.split('/').at(-1), { directory: storage });
  const largeMetadata = await sharp(readFileSync(largePath)).metadata();
  assert.deepEqual([largeMetadata.width, largeMetadata.height], [2400, 1200]);

  const small = await saveProductImage(await image('png', 90, 45), { directory: storage });
  const smallPath = await productImagePath(small.url.split('/').at(-1), { directory: storage });
  const smallMetadata = await sharp(readFileSync(smallPath)).metadata();
  assert.deepEqual([smallMetadata.width, smallMetadata.height], [90, 45]);
});

test('admite exactamente la cuota, bloquea el byte siguiente y conserva su uso', async t => {
  const bytes = await image();
  const reference = await saveProductImage(bytes, { directory: directory(t) });
  const storage = directory(t);
  const saved = await saveProductImage(bytes, { directory: storage, quotaBytes: reference.bytes });
  assert.equal(saved.usage.used, reference.bytes);
  assert.equal(saved.usage.limit, reference.bytes);
  await assert.rejects(
    () => saveProductImage(bytes, { directory: storage, quotaBytes: reference.bytes }),
    { status: 413 },
  );
  assert.deepEqual(await productImageUsage({ directory: storage, quotaBytes: reference.bytes }), { used: reference.bytes, limit: reference.bytes });
  assert.equal(PRODUCT_IMAGE_QUOTA_BYTES, 1_000_000_000);
});

test('serializa cargas simultáneas para no superar la cuota', async t => {
  const bytes = await image();
  const reference = await saveProductImage(bytes, { directory: directory(t) });
  const storage = directory(t);
  const results = await Promise.allSettled([
    saveProductImage(bytes, { directory: storage, quotaBytes: reference.bytes }),
    saveProductImage(bytes, { directory: storage, quotaBytes: reference.bytes }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && result.reason.status === 413).length, 1);
  assert.equal((await productImageUsage({ directory: storage })).used, reference.bytes);
});

test('persiste archivos y cuota entre lecturas independientes y no acepta rutas manipuladas', async t => {
  const storage = directory(t);
  const saved = await saveProductImage(await image(), { directory: storage });
  const id = saved.url.split('/').at(-1);
  assert.equal((await productImagePath(id, { directory: storage })) !== null, true);
  assert.deepEqual(await productImageUsage({ directory: storage }), { used: saved.bytes, limit: PRODUCT_IMAGE_QUOTA_BYTES });
  assert.equal(await productImagePath('../escape', { directory: storage }), null);
  writeFileSync(join(storage, 'not-an-image.txt'), 'ignored');
  writeFileSync(join(storage, 'temporary.part'), 'ignored');
  assert.equal((await productImageUsage({ directory: storage })).used, saved.bytes);
});
test('libera una imagen reemplazada solo cuando ningún producto la referencia', async t => {
  const storage = directory(t), store = await openStore({ DB_DRIVER: 'sqlite', SQLITE_PATH: ':memory:' });
  t.after(() => store.close());
  const uploaded = await saveProductImage(await image(), { directory: storage });
  const first = await store.save('products', productData({ slug: 'imagen-compartida-uno', image: uploaded.url }));
  const second = await store.save('products', productData({ slug: 'imagen-compartida-dos', image: uploaded.url }));

  await store.save('products', { ...first, status: 'draft', image: '' }, first.id, first.version);
  assert.equal(await removeUnusedProductImage(store, uploaded.url, { directory: storage }), false);
  assert.ok(await productImagePath(uploaded.url.split('/').at(-1), { directory: storage }));

  await store.save('products', { ...second, status: 'draft', image: '' }, second.id, second.version);
  assert.equal(await removeUnusedProductImage(store, uploaded.url, { directory: storage }), true);
  assert.equal(await productImagePath(uploaded.url.split('/').at(-1), { directory: storage }), null);
  assert.equal((await productImageUsage({ directory: storage })).used, 0);
});
