import test from 'node:test';
import assert from 'node:assert/strict';
import { socialPermalink } from '../lib/social/evidence.mjs';

test('permalinks públicos de foto e historia conservan sólo identificadores Meta, no autorizaciones', () => {
  const links = [
    'https://www.facebook.com/photo/?fbid=123&set=a.456&type=3',
    'https://www.facebook.com/story.php?story_fbid=123&id=456',
    'https://www.facebook.com/page/photos/a.456/123/?type=3',
    'https://www.instagram.com/p/verifiedShortcode/'
  ];
  assert.deepEqual(links.map(socialPermalink), links);
  for (const link of [
    'https://www.facebook.com/photo/?fbid=123&access_token=private',
    'https://www.facebook.com/photo/?fbid=123&signature=private',
    'https://www.facebook.com/photo/?fbid=123&fbid=456',
    'https://www.facebook.com/story.php?story_fbid=123',
    'https://www.facebook.com/photo/?fbid=123&set=private',
    'https://www.instagram.com/p/verifiedShortcode/?code=private',
    'https://www.facebook.com.evil.test/photo/?fbid=123',
    'https://private@www.facebook.com/photo/?fbid=123',
    'https://www.facebook.com/photo/?fbid=123#private',
    'http://www.facebook.com/photo/?fbid=123'
  ]) assert.throws(() => socialPermalink(link), { errorCode: 'SPEC_MISMATCH' });
});
