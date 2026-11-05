import { createHash } from 'node:crypto';
import { META_PERMISSIONS } from '../lib/social/config.mjs';

const reply = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const invalid = () => reply({ error: { code: 100, message: 'Synthetic invalid request' } }, 400);
const clone = value => structuredClone(value);

// A stateful Graph-shaped provider: it owns IDs, relationships, uploads and delivery.
// No spec endpoint, connector import, input echo, or real network access.
export function createMetaPublishingProvider({ now = Date.now(), appId = '42', userId = '100', businessId = '500', pageId = '200', instagramId = '300', adAccountId: selectedAccount = 'act_400', currency = 'COP', timeZone = 'America/Bogota', pageToken = 'synthetic-page-200', whatsappNumber = '+573001234567' } = {}) {
  const adAccountNumeric = String(selectedAccount).replace(/^act_/, ''), adAccountId = `act_${adAccountNumeric}`;
  const objects = new Map(), uploads = new Map(), requests = [];
  const state = { loseResponse: null, rateLimit: null, rejectAds: false, partialUploadBytes: null, processingReads: 0, tokenRevoked: false, activationCount: 0, pageToken, currency, timeZone, whatsappNumber, pageSize: 100, effectivePlacements: null, permissions: [...META_PERMISSIONS], hidePages: false, accountStatus: 1, chunkSize: 65536 };
  let counter = 1000;
  const nextId = () => String(++counter);
  const clock = () => typeof now === 'function' ? now() : now;
  function effective(object) {
    if (object.type === 'ad' && state.rejectAds) return 'DISAPPROVED';
    if (object.status === 'PAUSED') return 'PAUSED';
    const campaign = object.type === 'campaign' ? object : objects.get(object.campaign_id);
    if (campaign?.status === 'PAUSED') return 'CAMPAIGN_PAUSED';
    const set = object.type === 'ad' ? objects.get(object.adset_id) : object.type === 'adset' ? object : null;
    if (set?.status === 'PAUSED') return 'ADSET_PAUSED';
    return 'ACTIVE';
  }
  function visible(object) {
    const result = clone(object);
    delete result.type;
    if (['campaign', 'adset', 'ad'].includes(object.type)) result.effective_status = effective(object);
    if (object.type === 'adset') result.budget_remaining = Object.hasOwn(object, 'budget_remaining') ? object.budget_remaining : String(object.lifetime_budget);
    if (object.type === 'adset') {
      const allowed = { facebook: ['feed', 'facebook_reels'], instagram: ['stream', 'reels'] };
      const platforms = object.targeting.publisher_platforms.filter(platform => Object.hasOwn(allowed, platform));
      result.targeting.effective_publisher_platforms = state.effectivePlacements?.publisher_platforms || platforms;
      for (const platform of ['facebook', 'instagram', 'audience_network', 'messenger', 'threads', 'whatsapp']) {
        const field = `${platform}_positions`;
        result.targeting[`effective_${field}`] = state.effectivePlacements?.[field] || (platforms.includes(platform) ? (object.targeting[field] || allowed[platform]).filter(position => allowed[platform].includes(position)) : []);
      }
    }
    if (object.type === 'video') {
      const upload = uploads.get(object.id);
      const busy = state.processingReads > 0;
      if (busy) state.processingReads--;
      result.status = { video_status: upload.complete && !busy ? 'ready' : 'processing', uploading_phase: { status: upload.complete ? 'completed' : 'in_progress', ...(upload.sessionId ? {} : { bytes_transferred: upload.offset }), source_file_size: upload.size }, processing_phase: { status: upload.complete && !busy ? 'completed' : 'in_progress' }, publishing_phase: { status: object.finished ? 'completed' : 'not_started', publish_status: object.published ? 'published' : object.finished ? 'publish' : 'draft' } };
    }
    if (object.type === 'container') result.status_code = object.published ? 'PUBLISHED' : object.kind === 'image' || uploads.get(object.id)?.complete ? 'FINISHED' : 'IN_PROGRESS';
    return result;
  }
  function hookMatches(hook, path) { return hook && hook.times > 0 && (hook.path === path || hook.path === '*'); }
  async function fetchImpl(rawUrl, options = {}) {
    const url = new URL(rawUrl), method = options.method || 'GET';
    if (!['graph.facebook.com', 'graph-video.facebook.com', 'rupload.facebook.com'].includes(url.hostname) || url.protocol !== 'https:') throw new Error('Synthetic provider forbids network');
    const path = url.pathname.replace(/^\//, '').replace(/^v26\.0\//, '');
    const list = items => {
      const start = Number(url.searchParams.get('after') || 0), end = start + state.pageSize;
      const next = new URL(url); next.searchParams.delete('appsecret_proof'); next.searchParams.delete('access_token'); next.searchParams.set('after', String(end));
      return { data: items.slice(start, end).map(visible), ...(items.length > end ? { paging: { next: next.href } } : {}) };
    };
    if (options.signal?.aborted) throw options.signal.reason;
    const headers = new Headers(options.headers);
    const resource = objects.get(path) || objects.get(path.split('/').at(-1));
    const pageRequest = path.startsWith(`${pageId}/`) || path.startsWith(`${instagramId}/`) || resource?.from?.id === pageId || resource?.type === 'container' || resource?.owner === instagramId;
    if (pageRequest && headers.get('authorization') !== `Bearer ${state.pageToken}` && headers.get('authorization') !== `OAuth ${state.pageToken}`) return reply({ error: { code: 190 } }, 401);
    if (!/^(?:Bearer|OAuth) /.test(headers.get('authorization') || '')) return reply({ error: { code: 190 } }, 401);
    if (state.tokenRevoked) return reply({ error: { code: 190 } }, 401);
    if (hookMatches(state.rateLimit, path)) { state.rateLimit.times--; return reply({ error: { code: 4 } }, 429, { 'retry-after': String(state.rateLimit.retryAfter || 60) }); }
    const body = {};
    let file = null;
    if (method !== 'GET' && url.hostname !== 'rupload.facebook.com') {
      if ((headers.get('content-type') || '').startsWith('multipart/form-data;')) {
        const request = new Request(url, { method: 'POST', headers, body: options.body, duplex: 'half' });
        const form = await request.formData();
        for (const [key, value] of form) { if (typeof value === 'string') body[key] = value; else file = { key, value }; }
      } else {
        for (const [key, value] of new URLSearchParams(options.body || '')) { try { body[key] = /_id$/.test(key) ? value : JSON.parse(value); } catch { body[key] = value; } }
      }
      delete body.appsecret_proof;
    }
    const safeBody = Object.fromEntries(Object.entries(body).filter(([key]) => !/token|proof|url|welcome|caption|message/i.test(key)));
    if (safeBody.object_story_spec) safeBody.object_story_spec = { page_id: safeBody.object_story_spec.page_id, instagram_user_id: safeBody.object_story_spec.instagram_user_id };
    requests.push({ method, path, body: clone(safeBody), ...(headers.has('offset') ? { offset: Number(headers.get('offset')) } : {}) });
    const lost = hookMatches(state.loseResponse, path);
    function finish(data) { if (lost) { state.loseResponse.times--; throw new TypeError('Synthetic response lost after effect'); } return reply(data); }
    if (path === 'debug_token') return reply({ data: { is_valid: true, app_id: appId, user_id: userId, type: 'USER', expires_at: Math.floor(clock() / 1000) + 86400, data_access_expires_at: Math.floor(clock() / 1000) + 86400, scopes: [...state.permissions] } });
    if (path === 'me' && method === 'GET') return reply({ id: userId, name: 'Synthetic administrator' });
    if (path === 'me/permissions') return method === 'DELETE' ? finish({ success: true }) : reply({ data: state.permissions.map(permission => ({ permission, status: 'granted' })) });
    if (path === 'me/accounts') return reply({ data: state.hidePages ? [] : [{ id: pageId, name: 'Synthetic Page', access_token: state.pageToken, tasks: ['CREATE_CONTENT', 'ANALYZE', 'ADVERTISE', 'MANAGE'], business: { id: businessId, name: 'Synthetic business' }, instagram_business_account: { id: instagramId, username: 'synthetic' }, whatsapp_number: state.whatsappNumber }] });
    const account = { id: adAccountId, name: 'Synthetic ad account', currency: state.currency, timezone_name: state.timeZone, account_status: state.accountStatus, user_tasks: ['ADVERTISE', 'ANALYZE', 'MANAGE', 'CREATE_CONTENT'], business: { id: businessId, name: 'Synthetic business' } };
    if (path === 'me/adaccounts') return reply({ data: [account] });
    if (path === adAccountId && method === 'GET') return reply(account);
    if (path === 'search') return reply({ data: [] });
    if (path === `${adAccountId}/reachestimate`) return reply({ data: [{ users_lower_bound: 10000, users_upper_bound: 20000, estimate_ready: true }] });
    if (path === `${instagramId}/content_publishing_limit`) return reply({ data: [{ quota_usage: [...objects.values()].filter(object => object.type === 'media').length, config: { quota_total: 100, quota_duration: 86400 } }] });
    if (url.hostname === 'rupload.facebook.com') {
      const id = path.split('/').at(-1), upload = uploads.get(id);
      if (method !== 'POST' || !upload || Number(headers.get('offset')) !== upload.offset) return invalid();
      const size = Number(headers.get('file_size'));
      if (!Number.isSafeInteger(size) || size <= 0 || upload.size && upload.size !== size) return invalid();
      upload.size = size;
      const before = upload.offset;
      let received = 0;
      for await (const chunk of options.body) {
        const bytes = Buffer.from(chunk);
        const permitted = state.partialUploadBytes == null ? bytes.length : Math.max(0, Math.min(bytes.length, state.partialUploadBytes - received));
        if (permitted) upload.digest.update(bytes.subarray(0, permitted));
        received += permitted; upload.offset += permitted;
        if (state.partialUploadBytes != null && received >= state.partialUploadBytes) { state.partialUploadBytes = null; throw new TypeError('Synthetic upload disconnected'); }
      }
      if (upload.offset > size || received !== size - before) return invalid();
      upload.complete = upload.offset === size;
      if (upload.complete) upload.sha256 = upload.digest.copy().digest('hex');
      return finish({ success: true });
    }
    const [owner, edge] = path.split('/');
    if (method === 'POST' && owner === pageId && edge === 'video_reels') {
      if (body.upload_phase === 'start') {
        const id = nextId(); objects.set(id, { id, type: 'video', from: { id: owner }, published: false, finished: false, permalink_url: `https://www.facebook.com/reel/${id}` });
        uploads.set(id, { offset: 0, size: 0, complete: false, digest: createHash('sha256') });
        return finish({ video_id: id, upload_url: `https://rupload.facebook.com/video-upload/v26.0/${id}` });
      }
      const video = objects.get(String(body.video_id));
      if (body.upload_phase !== 'finish' || !video || video.from.id !== owner || !uploads.get(video.id)?.complete) return invalid();
      video.finished = true; video.published = body.video_state === 'PUBLISHED'; video.description = body.description || '';
      return finish({ success: true });
    }
    if (method === 'POST' && owner === adAccountId && edge === 'advideos') {
      if (body.upload_phase === 'start') {
        const size = Number(body.file_size);
        if (!Number.isSafeInteger(size) || size <= 0 || !/^social:[\da-f-]{36}:video$/.test(body.title || '')) return invalid();
        const id = nextId(), sessionId = nextId(), endOffset = Math.min(size, state.chunkSize);
        objects.set(id, { id, type: 'video', from: { id: adAccountId }, title: body.title, published: false, finished: false });
        uploads.set(id, { sessionId, videoId: id, offset: 0, endOffset, size, complete: false, digest: createHash('sha256') });
        return finish({ upload_session_id: sessionId, video_id: id, start_offset: '0', end_offset: String(endOffset) });
      }
      const upload = [...uploads.values()].find(item => item.sessionId === String(body.upload_session_id));
      if (!upload) return invalid();
      if (body.upload_phase === 'transfer') {
        if (!file || file.key !== 'video_file_chunk' || Number(body.start_offset) !== upload.offset || Number(body.end_offset) !== upload.endOffset || upload.complete) return invalid();
        const bytes = Buffer.from(await file.value.arrayBuffer());
        if (bytes.length !== upload.endOffset - upload.offset) return invalid();
        upload.digest.update(bytes); upload.offset = upload.endOffset; upload.endOffset = Math.min(upload.size, upload.offset + state.chunkSize); upload.complete = upload.offset === upload.size;
        if (upload.complete) upload.sha256 = upload.digest.copy().digest('hex');
        return finish({ start_offset: String(upload.offset), end_offset: String(upload.endOffset) });
      }
      if (body.upload_phase !== 'finish' || !upload.complete) return invalid();
      objects.get(upload.videoId).finished = true;
      return finish({ success: true });
    }
    if (method === 'POST' && owner === adAccountId && edge === 'adimages') {
      if (!file || file.key !== 'filename' || !/^social:[\da-f-]{36}:image$/.test(body.name || '')) return invalid();
      const bytes = Buffer.from(await file.value.arrayBuffer()), imageHash = createHash('md5').update(bytes).digest('hex');
      objects.set(imageHash, { id: imageHash, hash: imageHash, name: body.name, type: 'image', account_id: adAccountNumeric });
      return finish({ images: { 'derivative.jpg': { hash: imageHash, name: body.name } } });
    }
    if (method === 'POST' && owner === pageId && edge === 'photos') {
      if (!file || file.key !== 'source' || String(body.published) !== 'false') return invalid();
      const id = nextId(); objects.set(id, { id, type: 'photo', from: { id: pageId }, sha256: createHash('sha256').update(Buffer.from(await file.value.arrayBuffer())).digest('hex') });
      return finish({ id });
    }
    if (method === 'POST' && owner === pageId && edge === 'feed') {
      const photoId = String(body.attached_media?.[0]?.media_fbid || '');
      if (body.attached_media?.length !== 1 || objects.get(photoId)?.type !== 'photo' || body.published !== true) return invalid();
      const id = `${pageId}_${nextId()}`; objects.set(id, { id, type: 'post', from: { id: pageId }, message: body.message, is_published: true, permalink_url: `https://www.facebook.com/${id}`, attachments: { data: [{ target: { id: photoId } }] } });
      return finish({ id });
    }
    if (method === 'POST' && owner === instagramId && edge === 'media') {
      const kind = body.media_type === 'REELS' ? 'video' : 'image';
      if (kind === 'image' && !String(body.image_url || '').includes('/api/social/media/') || kind === 'video' && (body.upload_type !== 'resumable' || body.share_to_feed !== true)) return invalid();
      const id = nextId(); objects.set(id, { id, type: 'container', kind, caption: body.caption || '', published: false });
      if (kind === 'video') uploads.set(id, { offset: 0, size: 0, complete: false, digest: createHash('sha256') });
      return finish({ id });
    }
    if (method === 'POST' && owner === instagramId && edge === 'media_publish') {
      const container = objects.get(String(body.creation_id));
      if (container?.type !== 'container' || visible(container).status_code !== 'FINISHED' || container.published) return invalid();
      const id = nextId(); objects.set(id, { id, type: 'media', owner: instagramId, caption: container.caption, media_type: container.kind === 'video' ? 'VIDEO' : 'IMAGE', media_product_type: container.kind === 'video' ? 'REELS' : 'FEED', permalink: `https://www.instagram.com/p/${id}/` }); container.published = true;
      return finish({ id });
    }
    if (method === 'POST' && owner === adAccountId && ['campaigns', 'adsets', 'adcreatives', 'ads'].includes(edge)) {
      if (!/^social:[\da-f-]{36}:(?:campaign|adset|creative|ad)$/.test(body.name || '') || [...objects.values()].some(object => object.name === body.name)) return invalid();
      const id = nextId();
      if (edge === 'campaigns') {
        if (body.status !== 'PAUSED' || !['OUTCOME_ENGAGEMENT', 'OUTCOME_TRAFFIC', 'OUTCOME_AWARENESS'].includes(body.objective) || body.special_ad_categories?.length !== 0) return invalid();
        objects.set(id, { ...clone(body), id, type: 'campaign', account_id: adAccountNumeric, daily_budget: '0', lifetime_budget: '0' });
      } else if (edge === 'adsets') {
        const parent = objects.get(String(body.campaign_id));
        if (parent?.type !== 'campaign' || body.status !== 'PAUSED' || body.daily_budget || !Number.isSafeInteger(body.lifetime_budget) || body.lifetime_budget <= 0 || Date.parse(body.end_time) <= Date.parse(body.start_time) || body.billing_event !== 'IMPRESSIONS' || body.bid_strategy !== 'LOWEST_COST_WITHOUT_CAP' || body.promoted_object?.page_id !== pageId || !body.targeting?.publisher_platforms?.length || !body.placement_soft_opt_out) return invalid();
        if ([...objects.values()].some(object => object.type === 'adset' && object.campaign_id === parent.id)) return invalid();
        if (body.destination_type === 'WHATSAPP' && (body.optimization_goal !== 'CONVERSATIONS' || body.promoted_object.whatsapp_phone_number !== state.whatsappNumber)) return invalid();
        objects.set(id, { ...clone(body), id, type: 'adset', account_id: adAccountNumeric, daily_budget: '0' });
      } else if (edge === 'adcreatives') {
        const story = body.object_story_spec, data = story?.link_data || story?.video_data;
        const features = body.degrees_of_freedom_spec?.creative_features_spec;
        const requiredFeatures = ['inline_comment', 'text_optimizations', story?.video_data ? 'video_auto_crop' : 'adapt_to_placement'];
        if (story?.page_id !== pageId || story.instagram_user_id && story.instagram_user_id !== instagramId || !data || story.link_data && objects.get(data.image_hash)?.type !== 'image' || story.video_data && !objects.get(data.video_id)?.finished || !features || requiredFeatures.some(key => features[key]?.enroll_status !== 'OPT_OUT') || Object.values(features).some(feature => feature.enroll_status === 'OPT_IN') || !Array.isArray(body.asset_feed_spec?.audios) || body.asset_feed_spec.audios.length) return invalid();
        if (data.call_to_action?.type === 'WHATSAPP_MESSAGE') { let welcome; try { welcome = JSON.parse(data.page_welcome_message); } catch {} if (!welcome?.text_format?.message?.text || data.call_to_action.value?.app_destination !== 'WHATSAPP') return invalid(); }
        objects.set(id, { ...clone(body), id, type: 'creative', account_id: adAccountNumeric });
      } else {
        const set = objects.get(String(body.adset_id)), creative = objects.get(String(body.creative?.creative_id));
        if (set?.type !== 'adset' || creative?.type !== 'creative' || body.status !== 'PAUSED' || [...objects.values()].some(object => object.type === 'ad' && object.adset_id === set.id)) return invalid();
        objects.set(id, { ...clone(body), creative: { id: creative.id }, id, type: 'ad', campaign_id: set.campaign_id, account_id: adAccountNumeric });
      }
      return finish({ id });
    }
    if (method === 'POST' && !edge && objects.has(owner)) {
      const object = objects.get(owner);
      if (!['campaign', 'adset', 'ad'].includes(object.type) || !['ACTIVE', 'PAUSED'].includes(body.status) || Object.keys(body).length !== 1) return invalid();
      if (object.type === 'campaign' && body.status === 'ACTIVE') {
        const children = [...objects.values()].filter(item => item.campaign_id === object.id);
        if (!children.some(item => item.type === 'adset') || !children.some(item => item.type === 'ad') || children.some(item => item.status !== 'ACTIVE')) return invalid();
        if (object.status !== 'ACTIVE') state.activationCount++;
      }
      object.status = body.status; return finish({ success: true });
    }
    if (method === 'GET' && owner === pageId && edge === 'published_posts') return reply(list([...objects.values()].filter(object => object.type === 'post' && object.from?.id === pageId)));
    if (method === 'GET' && owner === pageId && edge === 'video_reels') return reply(list([...objects.values()].filter(object => object.type === 'video' && object.published && object.from?.id === pageId)));
    if (method === 'GET' && owner === instagramId && edge === 'media') return reply(list([...objects.values()].filter(object => object.type === 'media' && object.owner === instagramId)));
    if (method === 'GET' && owner === adAccountId && ['campaigns', 'adsets', 'adcreatives', 'ads', 'adimages', 'advideos'].includes(edge)) {
      const type = { campaigns: 'campaign', adsets: 'adset', adcreatives: 'creative', ads: 'ad', adimages: 'image', advideos: 'video' }[edge];
      return reply(list([...objects.values()].filter(object => object.type === type && (type === 'video' ? object.from?.id === adAccountId : object.account_id === adAccountNumeric))));
    }
    if (method === 'GET' && objects.get(owner)?.type === 'campaign' && ['ads', 'adsets'].includes(edge)) return reply(list([...objects.values()].filter(object => object.campaign_id === owner && object.type === (edge === 'ads' ? 'ad' : 'adset'))));
    if (method === 'GET' && !edge && objects.has(owner)) return reply(visible(objects.get(owner)));
    return invalid();
  }
  return { fetchImpl, state, objects, uploads, requests };
}
