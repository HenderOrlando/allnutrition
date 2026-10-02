import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { fail } from './validation.mjs';

export const MAX_PRODUCT_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const PRODUCT_IMAGE_QUOTA_BYTES = 1_000_000_000;
const defaultDirectory = process.env.MEDIA_DIR || join(process.cwd(), 'data', 'product-images');
const imageName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
let writes = Promise.resolve();

async function ensureDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

function serializeWrite(task) {
  const result = writes.then(task);
  writes = result.catch(() => {});
  return result;
}

export async function productImageUsage({ directory = defaultDirectory, quotaBytes = PRODUCT_IMAGE_QUOTA_BYTES } = {}) {
  await ensureDirectory(directory);
  let used = 0;
  for (const entry of await readdir(/*turbopackIgnore: true*/ directory, { withFileTypes: true })) {
    if (!entry.isFile() || !imageName.test(entry.name)) continue;
    try {
      const file = await lstat(join(/*turbopackIgnore: true*/ directory, entry.name));
      if (file.isFile()) used += file.size;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { used, limit: quotaBytes };
}

async function optimizedWebp(input, maxInputBytes) {
  if (!Buffer.isBuffer(input) || input.length === 0) fail('Selecciona un archivo de imagen.');
  if (input.length > maxInputBytes) fail('La imagen supera el límite de 10 MiB.', 413);

  let metadata;
  try { metadata = await sharp(input, { failOn: 'error' }).metadata(); }
  catch { fail('El archivo no es una imagen válida.'); }
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) fail('Solo se aceptan imágenes JPEG, PNG o WebP.');
  if (!metadata.width || !metadata.height) fail('La imagen no tiene dimensiones válidas.');

  try {
    const { data, info } = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    if (info.width > 2400 || info.height > 2400) fail('No se pudo optimizar la imagen dentro de 2400 px.');
    return data;
  } catch (error) {
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) throw error;
    fail('No se pudo procesar la imagen.');
  }
}

export async function saveProductImage(input, {
  directory = defaultDirectory,
  quotaBytes = PRODUCT_IMAGE_QUOTA_BYTES,
  maxInputBytes = MAX_PRODUCT_IMAGE_UPLOAD_BYTES,
} = {}) {
  const image = await optimizedWebp(input, maxInputBytes);
  return serializeWrite(async () => {
    await ensureDirectory(directory);
    const current = await productImageUsage({ directory, quotaBytes });
    if (current.used + image.length > quotaBytes) fail('Se alcanzó el límite de 1 GB de imágenes. Quita una imagen anterior y guarda el producto antes de subir otra.', 413);

    const id = randomUUID();
    const temporary = join(directory, `${id}.part`);
    const destination = join(directory, `${id}.webp`);
    try {
      await writeFile(temporary, image, { flag: 'wx', mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
    return { url: `/api/media/${id}`, bytes: image.length, usage: { used: current.used + image.length, limit: quotaBytes } };
  });
}

export async function productImagePath(id, { directory = defaultDirectory } = {}) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id || '')) return null;
  const path = join(directory, `${id}.webp`);
  try {
    const file = await lstat(path);
    return file.isFile() ? path : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function removeUnusedProductImage(store, url, { directory = defaultDirectory } = {}) {
  const match = /^\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(url || '');
  if (!match) return false;
  return store.transaction(async tx => {
    await tx.lockWrites();
    if ((await tx.list('products')).some(product => product.image === url)) return false;
    const path = await productImagePath(match[1], { directory });
    if (!path) return false;
    await unlink(path);
    return true;
  });
}
