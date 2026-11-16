import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const SOCIAL_IMAGE_MODEL = 'gpt-image-2.6-flare';
const MAX_BYTES = 20 * 1024 * 1024;
const problem = (code, message) => Object.assign(new Error(message), { code });

// The origin and model are deliberately not configurable: assistant-compatible
// providers and OAuth credentials must never receive image-generation traffic.
export async function generateOpenAIImage({ apiKey, prompt, format, frameCount, frameDurationMs, inputs = [], actorId, signal, beforePost }, { transport = globalThis.fetch } = {}) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 || inputs.length > 4 || format === 'gif' && (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 16 || !Number.isInteger(frameDurationMs) || frameDurationMs < 20 || frameDurationMs > 2000 || frameDurationMs % 10 || frameCount * frameDurationMs < 3000 || frameCount * frameDurationMs > 32000)) throw problem('GENERATION_INPUT', 'Los parámetros de generación exceden los límites permitidos.');
  if (typeof apiKey !== 'string' || !apiKey || !['png', 'gif'].includes(format) || typeof beforePost !== 'function') throw problem('GENERATION_CONFIG', 'La generación requiere una API Key oficial de OpenAI.');
  const fields = { model: SOCIAL_IMAGE_MODEL, prompt, n: 1, size: format === 'gif' ? '576x1024' : '1024x1024', quality: 'low', complexity: 'low', output_format: format, safety_identifier: createHash('sha256').update(`social-generation:${actorId}`).digest('hex') };
  if (format === 'gif') Object.assign(fields, { frame_count: frameCount, frame_duration_ms: frameDurationMs });
  let body, headers = { Authorization: `Bearer ${apiKey}` };
  if (inputs.length) {
    body = new FormData();
    for (const [key, value] of Object.entries(fields)) body.set(key, String(value));
    for (const [index, input] of inputs.entries()) body.append('image[]', new Blob([input.bytes], { type: input.contentType }), `reference-${index}.${input.contentType.split('/')[1]}`);
  } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(fields); }
  await beforePost();
  const response = await transport(`https://api.openai.com/v1/images/${inputs.length ? 'edits' : 'generations'}`, { method: 'POST', headers, body, signal, redirect: 'error' });
  if (!response.ok) throw problem('GENERATION_REJECTED', 'OpenAI no completó la solicitud. No se reintentará automáticamente; revisa consumo y permisos en OpenAI.');
  const parts = []; let length = 0;
  if (!response.body) throw problem('GENERATION_RESPONSE', 'OpenAI no devolvió una imagen verificable.');
  for await (const part of response.body) {
    length += part.byteLength;
    if (length > Math.ceil(MAX_BYTES * 4 / 3) + 65536) throw problem('GENERATION_RESPONSE', 'El resultado supera el límite seguro de almacenamiento.');
    parts.push(part);
  }
  let encoded;
  try { const result = JSON.parse(Buffer.concat(parts).toString('utf8')); if (result.data?.length !== 1) throw new Error(); encoded = result.data[0].b64_json; } catch { throw problem('GENERATION_RESPONSE', 'OpenAI no devolvió una imagen verificable.'); }
  if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(MAX_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw problem('GENERATION_RESPONSE', 'OpenAI no devolvió bytes de imagen válidos.');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > (format === 'png' ? 10 * 1024 * 1024 : MAX_BYTES) || bytes.toString('base64') !== encoded) throw problem('GENERATION_RESPONSE', 'El resultado no tiene un tamaño o codificación válidos.');
  try {
    const image = sharp(bytes, { animated: true, limitInputPixels: 40000000, failOn: 'error' });
    const metadata = await image.metadata(), frames = metadata.pages || 1, height = metadata.pageHeight || metadata.height;
    if (metadata.format !== format || !metadata.width || !height || metadata.width * height * frames > 40000000) throw new Error();
    if (format === 'gif' ? frames !== frameCount || frames < 2 || frames > 16 || metadata.delay?.length !== frames || metadata.delay.some(delay => delay < 20 || delay > 2000 || delay % 10) : frames !== 1) throw new Error();
    // Decode every frame, not merely the header, before trusting provider bytes.
    await image.stats();
  } catch { throw problem('GENERATION_RESPONSE', 'El resultado no es una imagen completa o un GIF animado válido.'); }
  return { bytes, contentType: format === 'gif' ? 'image/gif' : 'image/png', model: SOCIAL_IMAGE_MODEL };
}
