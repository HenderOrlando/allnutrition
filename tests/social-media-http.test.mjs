import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSocialMediaUrl, verifySocialMediaUrl, socialMediaResponse } from '../lib/social/media-http.mjs';

const NOW = Date.parse('2030-01-01T14:00:00.000Z');
const env = { APP_URL: 'https://social.example.test', SOCIAL_MEDIA_SIGNING_KEY: Buffer.alloc(32, 83).toString('base64') };
const asset = { id: '308c8e75-9609-48e2-b5f2-fecb2aab1947', state: 'ready', kind: 'image', sha256: '4'.repeat(64) };

// Independent protocol fixture: its MAC is built from the documented fields,
// not by the URL producer under test. Expired/overlong links retain a valid MAC.
function signed(expires) {
  const signature = createHmac('sha256', Buffer.from(env.SOCIAL_MEDIA_SIGNING_KEY, 'base64')).update(`${asset.id}\n${asset.sha256}\nderivative\n${expires}`).digest('hex');
  return `${env.APP_URL}/api/social/media/${asset.id}?variant=derivative&expires=${expires}&signature=${signature}`;
}

test('signed derivative binds identity, hash, expiry and key; original or extra query never authorizes', () => {
  const url = signed(NOW / 1000 + 60), check = (candidate, record = asset, at = NOW, settings = env) => verifySocialMediaUrl(record, candidate, { env: settings, now: at });
  assert.equal(check(url), true);
  assert.equal(check(url, { ...asset, id: 'ab6bb49f-0b23-4b02-ab82-80e76936d1ed' }), false);
  assert.equal(check(url, { ...asset, sha256: '5'.repeat(64) }), false);
  assert.equal(check(url, { ...asset, state: 'missing_file' }), false);
  assert.equal(check(url, { ...asset, kind: 'video' }), false);
  assert.equal(check(url, asset, NOW, { ...env, SOCIAL_MEDIA_SIGNING_KEY: Buffer.alloc(32, 84).toString('base64') }), false);
  assert.equal(check(url, asset, NOW, {}), false);
  assert.equal(check(url.replace('variant=derivative', 'variant=original')), false);
  assert.equal(check(`${url}&variant=derivative`), false);
  assert.equal(check(`${url}&download=original`), false);
  assert.equal(check(url.replace('signature=', 'signature=0')), false);
  assert.equal(check(url, asset, NOW + 60000), false);
  assert.equal(check(signed(NOW / 1000 - 1)), false);
  assert.equal(check(signed(NOW / 1000 + 86401)), false);
  assert.equal(check(signed(NOW / 1000 + 86400)), true);
});

test('URL issuer accepts only ready images, bounded lifetime and an exact configured origin', () => {
  const url = createSocialMediaUrl(asset, { env, now: NOW, expiresInSeconds: 90 });
  assert.equal(verifySocialMediaUrl(asset, url, { env, now: NOW + 89000 }), true);
  assert.equal(verifySocialMediaUrl(asset, url, { env, now: NOW + 90000 }), false);
  for (const expiresInSeconds of [0, -1, 86401, 1.5]) assert.throws(() => createSocialMediaUrl(asset, { env, now: NOW, expiresInSeconds }), error => error.status === 400);
  for (const record of [{ ...asset, state: 'processing' }, { ...asset, kind: 'video' }]) assert.throws(() => createSocialMediaUrl(record, { env, now: NOW }), error => error.status === 409);
  for (const APP_URL of ['https://user:password@social.example.test', 'https://social.example.test/path', 'http://social.example.test', 'https://social.example.test?leak=1']) assert.throws(() => createSocialMediaUrl(asset, { env: { ...env, APP_URL }, now: NOW }), error => error.status === 409);
});

async function fileFixture(t, bytes = Buffer.from('0123456789abcdef')) {
  const directory = await mkdtemp(join(tmpdir(), 'social-media-http-'));
  const path = join(directory, 'representation.bin');
  await writeFile(path, bytes);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    bytes,
    async descriptor() {
      return { handle: await open(path, 'r'), size: bytes.length, contentType: 'video/mp4', sha256: createHash('sha256').update(bytes).digest('hex') };
    },
  };
}
const request = (headers = {}, method = 'GET') => new Request('https://social.example.test/preview', { headers, method });

test('Range returns exact file bytes for closed, open, suffix and clamped boundaries', async t => {
  const f = await fileFixture(t);
  for (const [range, start, end] of [['bytes=0-3', 0, 3], ['bytes=12-', 12, 15], ['bytes=-3', 13, 15], ['bytes=14-100', 14, 15], ['bytes=-999999999999999999999', 0, 15]]) {
    const response = await socialMediaResponse(await f.descriptor(), request({ range }));
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), `bytes ${start}-${end}/${f.bytes.length}`);
    assert.equal(Number(response.headers.get('content-length')), end - start + 1);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes.subarray(start, end + 1));
  }
});

test('invalid or multiple ranges return 416 and release the file descriptor', async t => {
  const f = await fileFixture(t);
  for (const range of ['bytes=16-', 'bytes=4-2', 'bytes=-0', 'bytes=-', 'bytes=0-1,4-5', 'items=0-1']) {
    const descriptor = await f.descriptor(), response = await socialMediaResponse(descriptor, request({ range }));
    assert.equal(response.status, 416);
    assert.equal(response.headers.get('content-range'), `bytes */${f.bytes.length}`);
    assert.equal(descriptor.handle.fd, -1);
    assert.equal((await response.arrayBuffer()).byteLength, 0);
  }
});

test('HEAD has no body; If-Range mismatch returns the complete immutable representation', async t => {
  const f = await fileFixture(t), descriptor = await f.descriptor();
  const head = await socialMediaResponse(descriptor, request({ range: 'bytes=0-3' }, 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), String(f.bytes.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(descriptor.handle.fd, -1);
  const response = await socialMediaResponse(await f.descriptor(), request({ range: 'bytes=0-3', 'if-range': '"old-derivative"' }));
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), f.bytes);
  assert.equal(response.headers.get('cache-control'), 'private,no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('canceling a response closes its pinned file rather than retaining a video descriptor', { timeout: 3000 }, async t => {
  const f = await fileFixture(t, Buffer.alloc(2 * 1024 * 1024, 77)), descriptor = await f.descriptor();
  const closed = once(descriptor.handle, 'close');
  const response = await socialMediaResponse(descriptor, request());
  await response.body.cancel();
  await closed;
  assert.equal(descriptor.handle.fd, -1);
});
