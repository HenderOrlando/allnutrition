import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { hash } from '../business/commands.mjs';
import { SOCIAL_OBJECTIVE_CONFIG } from '../business/social-spec.mjs';
import { metaBudgetUnits, META_CURRENCY_OFFSETS, MetaApiError } from './meta.mjs';
import { createSocialMediaUrl } from './media-http.mjs';
import { socialPermalink } from './evidence.mjs';

// https://developers.facebook.com/documentation/pages-api/posts.md
// https://developers.facebook.com/documentation/video-api/guides/reels-publishing.md
// https://developers.facebook.com/documentation/instagram-platform/content-publishing
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account/advideos
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/ad-creative/messaging-ads/click-to-whatsapp.md
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-campaign-group
const ID = /^\d+$/;
const POST_ID = /^\d+(?:_\d+)?$/;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const HEX = /^[\da-f]{32,64}$/;
const failSpec = () => { throw Object.assign(new MetaApiError('rejected'), { errorCode: 'SPEC_MISMATCH' }); };
const remoteId = value => { if (typeof value !== 'string' || !ID.test(value)) throw new MetaApiError('invalid_response'); return value; };
const same = (a, b) => hash(canonical(a)) === hash(canonical(b));
function specCurrencyOffset(currency) { const offset = META_CURRENCY_OFFSETS[currency]; if (!offset) failSpec(); return offset; }
function readBudgetUnits(value) {
  if (!(typeof value === 'string' && /^\d+$/.test(value) || typeof value === 'number')) return null;
  const units = Number(value);
  return Number.isSafeInteger(units) && units >= 0 ? units : null;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
function assertFields(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const observed = actual[key];
    if (['start_time', 'end_time'].includes(key)) { if (Date.parse(observed) !== Date.parse(value)) failSpec(); }
    else if (typeof value === 'number') { if (Number(observed) !== value) failSpec(); }
    else if (!same(observed ?? null, value)) failSpec();
  }
}
const EFFECTIVE_PLACEMENTS = ['publisher_platforms', 'facebook_positions', 'instagram_positions', 'audience_network_positions', 'messenger_positions', 'threads_positions', 'whatsapp_positions'];
function verifyTargeting(actual, expected) {
  const configured = structuredClone(actual);
  if (!configured || !expected) failSpec();
  // https://developers.facebook.com/docs/graph-api/reference/targeting/
  // Effective fields are not default fields: request and compare them explicitly.
  for (const field of EFFECTIVE_PLACEMENTS) {
    const key = `effective_${field}`, approved = expected[field] || [];
    if (configured[key] == null ? approved.length > 0 : !same(configured[key], approved)) failSpec();
    delete configured[key];
  }
  if (!same(configured, expected)) failSpec();
}
export function initialMetaPublishingStep({ spec, kind, channel }) {
  if (!['image', 'video'].includes(kind) || !['facebook', 'instagram', 'meta_ads'].includes(channel)) failSpec();
  if (spec.mode === 'paid') { if (channel !== 'meta_ads') failSpec(); return kind === 'image' ? 'upload_image' : 'start_video'; }
  if (channel === 'meta_ads') failSpec();
  return channel === 'instagram' ? 'create_container' : kind === 'image' ? 'upload_photo' : 'start_video';
}
export function initialMetaControlStep(action, requestId) {
  if (!['activate', 'pause', 'resume'].includes(action) || typeof requestId !== 'string' || !/^[\w:-]{8,100}$/.test(requestId)) failSpec();
  return `${action}:${requestId}`;
}
function technicalName(operation, type) {
  if (!UUID.test(operation.deliveryId || '')) failSpec();
  return `social:${operation.deliveryId}:${type}`;
}
function campaignPayload(spec, operation) {
  const config = SOCIAL_OBJECTIVE_CONFIG[spec.objective];
  if (!config) failSpec();
  return { name: technicalName(operation, 'campaign'), objective: config.campaignObjective, status: 'PAUSED', special_ad_categories: [], buying_type: 'AUCTION', is_adset_budget_sharing_enabled: false };
}
function adsetPayload(spec, operation, refs) {
  const config = SOCIAL_OBJECTIVE_CONFIG[spec.objective];
  return { name: technicalName(operation, 'adset'), campaign_id: remoteId(refs.campaignId), status: 'PAUSED', lifetime_budget: metaBudgetUnits(spec.budgetMinor, spec.currency), start_time: spec.startAt, end_time: spec.endAt,
    billing_event: config.billingEvent, bid_strategy: config.bidStrategy, optimization_goal: config.optimizationGoal, ...(config.destinationType ? { destination_type: config.destinationType } : {}),
    promoted_object: { page_id: remoteId(spec.identities.pageId), ...(spec.objective === 'whatsapp' ? { whatsapp_phone_number: spec.whatsappNumber } : {}) }, targeting: spec.targeting, placement_soft_opt_out: {}, is_dynamic_creative: false };
}
function storyPayload(spec, refs) {
  const whatsapp = spec.objective === 'whatsapp';
  const link = whatsapp ? 'https://api.whatsapp.com/send' : spec.destinationUrl || `https://www.facebook.com/${spec.identities.pageId}`;
  const callToAction = whatsapp ? { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP' } } : spec.objective === 'traffic' ? { type: 'LEARN_MORE', value: { link } } : { type: 'NO_BUTTON' };
  const welcome = whatsapp ? { page_welcome_message: JSON.stringify({ type: 'VISUAL_EDITOR', version: 2, landing_screen_type: 'welcome_message', media_type: 'text', text_format: { customer_action_type: 'autofill_message', message: { text: spec.whatsappGreeting, autofill_message: { content: spec.whatsappGreeting } } } }) } : {};
  const story = { page_id: spec.identities.pageId, ...(spec.platforms.includes('instagram') ? { instagram_user_id: spec.identities.instagramId } : {}) };
  if (refs.videoId) story.video_data = { video_id: refs.videoId, message: spec.caption, title: spec.headline, call_to_action: callToAction, ...welcome };
  else story.link_data = { image_hash: refs.imageHash, link, message: spec.caption, name: spec.headline, call_to_action: callToAction, ...welcome };
  return story;
}
// v22+ removed the standard_enhancements bundle. Each transformation must opt out.
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/creative/advantage-creative/get-started
function enhancements(refs) {
  const common = ['inline_comment', 'text_optimizations', 'text_translation', 'description_automation', 'enhance_cta', 'creative_stickers', 'pac_relaxation', 'reveal_details_over_time'];
  const media = refs.videoId ? ['video_auto_crop', 'video_filtering', 'video_uncrop', 'translate_voiceover'] : ['adapt_to_placement', 'image_touchups', 'image_templates', 'image_brightness_and_contrast', 'image_uncrop', 'image_background_gen', 'image_animation', 'image_text_translation'];
  return { creative_features_spec: Object.fromEntries([...common, ...media].map(feature => [feature, { enroll_status: 'OPT_OUT' }])) };
}
function verifyEnhancements(actual, refs) {
  const features = actual?.creative_features_spec, expected = enhancements(refs).creative_features_spec;
  if (!features || Object.keys(expected).some(key => features[key]?.enroll_status !== 'OPT_OUT') || Object.values(features).some(feature => feature?.enroll_status === 'OPT_IN')) failSpec();
}
function checkedMedia(media, spec) {
  if (!media?.handle?.read || !Number.isSafeInteger(media.size) || media.size <= 0 || media.sha256 !== spec.assetHash || media.assetId !== spec.assetId || !['image', 'video'].includes(media.kind) || media.contentType !== (media.kind === 'image' ? 'image/jpeg' : 'video/mp4')) failSpec();
  return media;
}
function mediaStream(media, start, stop) {
  // The caller owns the pinned FD across chunks. Destroying a FileHandle
  // ReadStream closes that FD even with autoClose:false; this iterator does not.
  return Readable.from((async function* () {
    for (let position = start; position < stop;) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, stop - position));
      const { bytesRead } = await media.handle.read(chunk, 0, chunk.length, position);
      if (!bytesRead) throw new MetaApiError('invalid_response');
      position += bytesRead;
      yield bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead);
    }
  })(), { objectMode: false });
}
function multipart(media, fields, field = 'filename', start = 0, stop = media.size) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop) || start < 0 || stop > media.size || stop <= start) failSpec();
  const boundary = `social-${randomBytes(18).toString('hex')}`;
  const parts = Object.entries(fields).map(([key, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${typeof value === 'object' ? JSON.stringify(value) : value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="derivative.${media.kind === 'video' ? 'mp4' : 'jpg'}"\r\nContent-Type: ${media.contentType}\r\n\r\n`));
  const end = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Readable.from((async function* () { yield* parts; yield* mediaStream(media, start, stop); yield end; })(), { objectMode: false });
  return { body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(parts.reduce((sum, part) => sum + part.length, stop - start + end.length)) } };
}
function videoOffset(status) {
  const phase = status?.uploading_phase;
  const value = phase?.bytes_transferred ?? phase?.bytes_transfered;
  if (!Number.isSafeInteger(value) || value < 0) throw new MetaApiError('invalid_response');
  return value;
}
function adVideoCursor(result, size) {
  if (!/^\d+$/.test(String(result.start_offset ?? '')) || !/^\d+$/.test(String(result.end_offset ?? ''))) throw new MetaApiError('invalid_response', { uncertain: true });
  const offset = Number(result.start_offset), endOffset = Number(result.end_offset);
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(endOffset) || offset < 0 || endOffset < offset || endOffset > size) throw new MetaApiError('invalid_response', { uncertain: true });
  return { offset, endOffset };
}
function evidence(phase, fields = {}) { return { apiVersion: 'v26.0', adapterVersion: 'meta-api-v1', phase, ...fields }; }
const pending = (phase, refs, progress = {}) => ({ status: 'pending', operationComplete: false, remoteRefs: refs, progress, retryAfter: 60, evidence: evidence(phase) });
const uncertain = phase => ({ status: 'uncertain', evidence: evidence(phase) });
function confirmed(phase, refs, nextStep = null, fields = {}) { return { status: 'confirmed', remoteRefs: refs, nextStep, evidence: evidence(phase), ...fields }; }
const CREATION_STEPS = {
  create_campaign: ['campaigns', 'campaignId', 'create_adset', 'campaign'],
  create_adset: ['adsets', 'adSetId', 'create_creative', 'adset'],
  create_creative: ['adcreatives', 'creativeId', 'create_ad', 'creative'],
  create_ad: ['ads', 'adId', 'verify_prepared', 'ad']
};
const preparedRefs = refs => Object.fromEntries(['campaignId', 'adSetId', 'creativeId', 'adId', 'imageHash', 'videoId'].filter(key => refs[key]).map(key => [key, refs[key]]));

export function createMetaPublishingAdapter({ client, selected, validateConnection, pageToken, env, clock }) {
  async function context(spec, channel, signal, pause = false) {
    const status = await validateConnection({ signal, purpose: pause ? 'pause' : 'publish' });
    for (const key of pause ? ['userId', 'adAccountId'] : ['userId', 'businessId', 'pageId', ...(channel === 'meta_ads' ? ['adAccountId'] : []), ...(channel === 'instagram' || spec.platforms?.includes('instagram') ? ['instagramId'] : [])]) {
      if (!spec.identities?.[key] || spec.identities[key] !== status.identities[key] || selected[key] !== status.identities[key]) throw new MetaApiError('account_mismatch');
    }
    const capability = channel === 'meta_ads' ? 'adsPublish' : channel === 'instagram' ? 'instagramPublish' : 'facebookPublish';
    if (!status.capabilities[capability]) throw new MetaApiError('permission');
    if (channel === 'meta_ads' && !pause && (status.currency !== spec.currency || status.timeZone !== spec.timeZone)) failSpec();
    if (spec.objective === 'whatsapp' && !pause && (!status.capabilities.whatsappAds || status.resources.pages.find(page => page.id === spec.identities.pageId)?.whatsappNumber !== spec.whatsappNumber)) failSpec();
    return { signal, ...(channel === 'meta_ads' ? {} : { accessToken: pageToken(spec.identities.pageId) }) };
  }
  async function readVideo(id, options) { return (await client.get(remoteId(id), { fields: 'id,status,from,description,permalink_url' }, options)); }
  async function verifyPaid(spec, operation, refs, options, { partial = false, pause = false } = {}) {
    const account = await client.get(spec.identities.adAccountId, { fields: 'id,currency,timezone_name,account_status,business' }, options);
    if (!pause && (account.currency !== spec.currency || account.business?.id !== spec.identities.businessId) || account.id !== spec.identities.adAccountId) failSpec();
    const campaign = await client.get(remoteId(refs.campaignId), { fields: 'id,account_id,name,status,effective_status,objective,special_ad_categories,buying_type,lifetime_budget,daily_budget,is_adset_budget_sharing_enabled' }, options);
    if (campaign.id !== refs.campaignId) throw new MetaApiError('invalid_response');
    if (String(campaign.account_id) !== spec.identities.adAccountId.replace(/^act_/, '')) throw new MetaApiError('account_mismatch');
    if (pause) return { campaign };
    const expectedCampaign = campaignPayload(spec, operation); delete expectedCampaign.status;
    assertFields(campaign, expectedCampaign);
    if (Number(campaign.daily_budget || 0) !== 0 || Number(campaign.lifetime_budget || 0) !== 0) failSpec();
    if (refs.imageHash) {
      const images = await client.pages(`${spec.identities.adAccountId}/adimages`, { fields: 'hash' }, options);
      if (!images.some(image => image.hash === refs.imageHash)) failSpec();
    }
    if (refs.videoId) {
      const videos = await client.pages(`${spec.identities.adAccountId}/advideos`, { fields: 'id' }, options);
      if (!videos.some(video => video.id === refs.videoId)) throw new MetaApiError('account_mismatch');
    }
    if (!refs.adSetId) { if (!partial) failSpec(); return { campaign }; }
    const adsets = await client.pages(`${refs.campaignId}/adsets`, { fields: 'id' }, options);
    if (adsets.length !== 1 || adsets[0].id !== refs.adSetId) failSpec();
    const targetingFields = [...Object.keys(spec.targeting), ...EFFECTIVE_PLACEMENTS.map(field => `effective_${field}`)].join(',');
    const adset = await client.get(remoteId(refs.adSetId), { fields: `id,name,account_id,campaign_id,status,effective_status,lifetime_budget,daily_budget,start_time,end_time,targeting{${targetingFields}},targeting_optimization_types,placement_soft_opt_out,optimization_goal,billing_event,bid_strategy,destination_type,promoted_object,is_dynamic_creative,budget_remaining` }, options);
    if (adset.id !== refs.adSetId) throw new MetaApiError('invalid_response');
    const expectedAdset = adsetPayload(spec, operation, refs); delete expectedAdset.status; delete expectedAdset.targeting;
    assertFields(adset, { ...expectedAdset, account_id: spec.identities.adAccountId.replace(/^act_/, '') });
    verifyTargeting(adset.targeting, spec.targeting);
    if (Number(adset.daily_budget || 0) !== 0) failSpec();
    if (adset.targeting_optimization_types?.some(setting => Number(setting.value) !== 0)) failSpec();
    if (!refs.creativeId) { if (!partial) failSpec(); return { campaign, adset }; }
    const creative = await client.get(remoteId(refs.creativeId), { fields: 'id,name,account_id,object_story_spec,degrees_of_freedom_spec,asset_feed_spec' }, options);
    if (creative.id !== refs.creativeId) throw new MetaApiError('invalid_response');
    const story = structuredClone(creative.object_story_spec);
    if (story?.video_data) delete story.video_data.image_url;
    assertFields(creative, { name: technicalName(operation, 'creative'), account_id: spec.identities.adAccountId.replace(/^act_/, '') });
    verifyEnhancements(creative.degrees_of_freedom_spec, refs);
    if (!same(story, storyPayload(spec, refs)) || !same(creative.asset_feed_spec, { audios: [] })) failSpec();
    if (!refs.adId) { if (!partial) failSpec(); return { campaign, adset, creative }; }
    const ads = await client.pages(`${refs.campaignId}/ads`, { fields: 'id' }, options);
    if (ads.length !== 1 || ads[0].id !== refs.adId) failSpec();
    const ad = await client.get(remoteId(refs.adId), { fields: 'id,name,account_id,campaign_id,adset_id,creative,status,effective_status,ad_review_feedback,issues_info' }, options);
    if (ad.id !== refs.adId) throw new MetaApiError('invalid_response');
    assertFields(ad, { name: technicalName(operation, 'ad'), account_id: spec.identities.adAccountId.replace(/^act_/, ''), campaign_id: refs.campaignId, adset_id: refs.adSetId });
    if (ad.creative?.id !== refs.creativeId) failSpec();
    return { campaign, adset, creative, ad, currency: account.currency };
  }
  function paidState(observed, everActivated = false) {
    const { campaign, adset, ad } = observed;
    const budgetMinor = adset ? Number(adset.lifetime_budget) * 100 / (specCurrencyOffset(observed.currency)) : null;
    const remainingUnits = readBudgetUnits(adset?.budget_remaining);
    if (remainingUnits != null && remainingUnits > Number(adset.lifetime_budget)) throw new MetaApiError('invalid_response');
    const remainingMinor = Number.isSafeInteger(remainingUnits) && remainingUnits >= 0 ? remainingUnits * 100 / specCurrencyOffset(observed.currency) : null;
    const facts = { remoteRead: true, everActivated: everActivated || campaign.status === 'ACTIVE', ...(adset ? { budget: { budgetMinor, remainingMinor: Number.isSafeInteger(remainingMinor) ? remainingMinor : null, currency: observed.currency, startAt: new Date(adset.start_time).toISOString(), endAt: new Date(adset.end_time).toISOString() } } : {}) };
    const remoteState = ad?.effective_status || campaign.effective_status;
    if (!['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED', 'IN_PROCESS', 'WITH_ISSUES', 'PENDING_REVIEW', 'DISAPPROVED', 'PENDING_BILLING_INFO', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PREAPPROVED', 'PENDING_PROCESSING', 'COMPLETED'].includes(remoteState)) throw new MetaApiError('invalid_response');
    const result = state => ({ state, evidence: evidence('inspect', { ...facts, remoteState }) });
    if (ad?.effective_status === 'DISAPPROVED') return { state: 'failed', evidence: evidence('review', { ...facts, remoteState: 'DISAPPROVED', reason: 'Meta rechazó el anuncio. Consulta la revisión en el administrador de anuncios.', managerUrl: `https://adsmanager.facebook.com/adsmanager/manage/ads?selected_ad_ids=${ad.id}` }) };
    if (adset && Date.parse(adset.end_time) <= clock() && ['COMPLETED', 'ADSET_PAUSED'].includes(ad?.effective_status) && adset.effective_status !== 'ACTIVE') return result('completed');
    if (campaign.status === 'PAUSED') return result(everActivated ? 'paused' : 'ready');
    if (ad?.effective_status === 'PENDING_REVIEW' || ['IN_PROCESS', 'PENDING_BILLING_INFO'].includes(ad?.effective_status)) return result('in_review');
    if (campaign.effective_status === 'ACTIVE' && adset?.effective_status === 'ACTIVE' && ad?.effective_status === 'ACTIVE') return result(Date.parse(adset.start_time) > clock() ? 'scheduled' : 'active');
    return result('in_review');
  }
  async function published(spec, operation, refs, options) {
    if (operation.channel === 'instagram') {
      if (!refs.mediaId) return uncertain('publish');
      const owned = await client.pages(`${spec.identities.instagramId}/media`, { fields: 'id', limit: 100 }, options);
      if (!owned.some(row => row.id === refs.mediaId)) throw new MetaApiError('account_mismatch');
      const media = await client.get(remoteId(refs.mediaId), { fields: 'id,caption,media_type,media_product_type,permalink' }, options);
      if (media.id !== refs.mediaId) throw new MetaApiError('invalid_response');
      const reel = spec.placements?.includes('instagram_reels');
      if (media.caption !== spec.caption || (reel ? media.media_product_type !== 'REELS' || media.media_type !== 'VIDEO' : media.media_type !== 'IMAGE')) failSpec();
      return confirmed('confirm_publication', { ...refs, remoteId: media.id, permalink: socialPermalink(media.permalink) }, null, { state: 'published', evidence: evidence('confirm_publication', { remoteRead: true }) });
    }
    if (refs.videoId) {
      const video = await readVideo(refs.videoId, options);
      const owned = await client.pages(`${spec.identities.pageId}/video_reels`, { fields: 'id' }, options);
      if (video.from?.id !== spec.identities.pageId || video.description !== spec.caption) failSpec();
      if (!owned.some(row => row.id === refs.videoId)) return pending('confirm_publication', refs);
      if (video.status?.publishing_phase?.publish_status !== 'published' || video.status?.publishing_phase?.status !== 'completed') return pending('confirm_publication', refs);
      return confirmed('confirm_publication', { ...refs, remoteId: video.id, permalink: socialPermalink(video.permalink_url) }, null, { state: 'published', evidence: evidence('confirm_publication', { remoteRead: true }) });
    }
    if (!refs.postId) {
      if (!refs.photoId) return uncertain('publish');
      const posts = await client.pages(`${spec.identities.pageId}/published_posts`, { fields: 'id,attachments{target{id}}', limit: 100 }, options);
      const matches = posts.filter(post => post.attachments?.data?.some(attachment => attachment.target?.id === refs.photoId));
      if (matches.length !== 1) return uncertain('publish');
      refs = { ...refs, postId: matches[0].id };
    }
    if (!POST_ID.test(refs.postId)) failSpec();
    const post = await client.get(refs.postId, { fields: 'id,from,is_published,message,permalink_url,attachments{target{id}}' }, options);
    if (post.from?.id !== spec.identities.pageId || post.message !== spec.caption || !post.attachments?.data?.some(attachment => attachment.target?.id === refs.photoId)) failSpec();
    if (post.is_published !== true) return pending('confirm_publication', refs);
    return confirmed('confirm_publication', { ...refs, remoteId: post.id, permalink: socialPermalink(post.permalink_url) }, null, { state: 'published', evidence: evidence('confirm_publication', { remoteRead: true }) });
  }
  async function control(spec, operation, refs, options, send, reconcile = false) {
    const separator = operation.step.indexOf(':'), action = operation.step.slice(0, separator), requestId = operation.step.slice(separator + 1);
    if (initialMetaControlStep(action, requestId) !== operation.step || operation.controlId !== requestId) failSpec();
    if (action !== 'pause' && (!operation.investmentAccepted || !same(operation.preparedRefs, preparedRefs(refs)))) failSpec();
    const observed = await verifyPaid(spec, operation, refs, options, { pause: action === 'pause' });
    if (action === 'pause') {
      if (!reconcile) await send(refs.campaignId, { status: 'PAUSED' }, 'campaign');
      const result = await verifyPaid(spec, operation, refs, options, { pause: true });
      return result.campaign.status === 'PAUSED' && result.campaign.effective_status === 'PAUSED' ? confirmed('pause', refs, null, { state: 'paused', evidence: evidence('pause', { remoteRead: true, remoteState: 'PAUSED' }) }) : reconcile ? uncertain('pause') : pending('pause', refs);
    }
    if (action === 'resume' && !reconcile && operation.progress?.controlStage !== 'confirm') {
      const budget = operation.budgetConfirmation;
      const remaining = readBudgetUnits(observed.adset.budget_remaining);
      if (!budget || !Number.isSafeInteger(remaining) || remaining < 0 || metaBudgetUnits(budget.remainingMinor, spec.currency) !== remaining || budget.originalBudgetMinor !== spec.budgetMinor || budget.currency !== spec.currency || budget.startAt !== spec.startAt || budget.endAt !== spec.endAt || Date.parse(spec.endAt) <= clock()) failSpec();
    }
    const stage = operation.progress?.controlStage || 'ad';
    const stages = ['ad', 'adset', 'campaign', 'confirm'];
    const index = stages.indexOf(stage);
    if (index < 0) failSpec();
    if (stage === 'confirm') return confirmed(action, refs, null, paidState(observed, true));
    const target = refs[stage === 'adset' ? 'adSetId' : `${stage}Id`];
    if (!reconcile) await send(target, { status: 'ACTIVE' }, stage);
    const current = await client.get(target, { fields: 'id,status' }, options);
    if (current.id !== target) throw new MetaApiError('invalid_response');
    if (current.status !== 'ACTIVE') return reconcile ? uncertain(`${action}:${stage}`) : pending(action, refs, { controlStage: stage });
    return confirmed(action, refs, null, { operationComplete: false, progress: { controlStage: stages[index + 1] } });
  }
  async function executeStep({ operation, spec, media = null, signal, beforeSend }) {
    if (typeof beforeSend !== 'function') failSpec();
    const refs = { ...(operation.remoteRefs || {}) }, step = operation.step;
    if (['sent', 'uncertain'].includes(operation.state)) return inspectDelivery({ delivery: { ...operation, remoteRefs: refs }, operation, spec, signal });
    if (!step.startsWith('pause:') && spec.aiDisclosure === true && (spec.mode === 'paid' || operation.channel === 'facebook' && !spec.placements?.includes('facebook_reels'))) {
      throw Object.assign(new MetaApiError('permission'), { errorCode: 'PERMISSION_REQUIRED', message: 'La API Meta v26 no ofrece una etiqueta de IA verificada para este formato. No se publicará sin la divulgación aceptada.' });
    }
    const options = await context(spec, operation.channel, signal, step.startsWith('pause:'));
    if (!step.startsWith('pause:') && operation.specHash !== hash(spec)) failSpec();
    const send = async (path, payload, phase = step, intent = payload) => {
      await beforeSend({ payloadHash: hash({ specHash: operation.specHash, deliveryId: operation.deliveryId, step, phase, path, intent }), phase });
      return client.post(path, payload, options);
    };
    const upload = async (path, stream, headers, intent) => {
      try {
        await beforeSend({ payloadHash: hash({ specHash: operation.specHash, deliveryId: operation.deliveryId, step, path, intent }), phase: step });
        return await client.upload(path, { body: stream, headers, ...options });
      } finally { stream.destroy(); }
    };
    if (/^(activate|pause|resume):/.test(step)) return control(spec, operation, refs, options, send);
    const account = spec.identities.adAccountId, paid = spec.mode === 'paid';
    if (step === 'upload_image' || step === 'upload_photo') {
      checkedMedia(media, spec);
      if (media.kind !== 'image') failSpec();
      const path = step === 'upload_image' ? `${account}/adimages` : `${spec.identities.pageId}/photos`;
      const fields = step === 'upload_image' ? { name: technicalName(operation, 'image') } : { published: false };
      const form = multipart(media, fields, step === 'upload_image' ? 'filename' : 'source');
      const result = await upload(path, form.body, form.headers, { ...fields, assetHash: media.sha256, size: media.size });
      if (paid) {
        const images = Object.values(result.images || {});
        if (images.length !== 1 || !HEX.test(images[0]?.hash || '')) throw new MetaApiError('invalid_response', { uncertain: true });
        const owned = await client.pages(`${account}/adimages`, { fields: 'hash' }, options);
        if (!owned.some(image => image.hash === images[0].hash)) throw new MetaApiError('invalid_response', { uncertain: true });
        return confirmed(step, { ...refs, imageHash: images[0].hash }, 'create_campaign');
      }
      const photoId = remoteId(result.id), photo = await client.get(photoId, { fields: 'id,from' }, options);
      if (photo.id !== photoId || photo.from?.id !== spec.identities.pageId) throw new MetaApiError('account_mismatch', { uncertain: true });
      return confirmed(step, { ...refs, photoId }, 'publish');
    }
    if (step === 'create_container') {
      checkedMedia(media, spec);
      const quota = await client.get(`${spec.identities.instagramId}/content_publishing_limit`, { fields: 'config,quota_usage' }, options);
      const limit = quota.data?.[0];
      if (!limit || !Number.isSafeInteger(limit.quota_usage) || !Number.isSafeInteger(limit.config?.quota_total)) throw new MetaApiError('invalid_response');
      if (limit.quota_usage >= limit.config.quota_total) throw new MetaApiError('rate_limit', { retryAfter: 3600 });
      const body = { caption: spec.caption, is_ai_generated: spec.aiDisclosure, ...(media.kind === 'video' ? { media_type: 'REELS', share_to_feed: true, upload_type: 'resumable' } : { image_url: createSocialMediaUrl({ id: media.assetId, sha256: media.sha256, state: 'ready', kind: 'image' }, { env, now: clock() }) }) };
      const result = await send(`${spec.identities.instagramId}/media`, body, step, { caption: spec.caption, aiDisclosure: spec.aiDisclosure, kind: media.kind, assetHash: media.sha256 });
      const container = await client.get(remoteId(result.id), { fields: 'id,status_code' }, options);
      if (container.id !== result.id || !['FINISHED', 'IN_PROGRESS'].includes(container.status_code)) throw new MetaApiError('invalid_response', { uncertain: true });
      return confirmed(step, { ...refs, containerId: remoteId(result.id) }, media.kind === 'video' ? 'upload_video' : 'wait_container');
    }
    if (step === 'start_video') {
      checkedMedia(media, spec);
      if (media.kind !== 'video') failSpec();
      const result = await send(paid ? `${account}/advideos` : `${spec.identities.pageId}/video_reels`, { upload_phase: 'start', ...(paid ? { file_size: media.size, title: technicalName(operation, 'video') } : {}) });
      const videoId = remoteId(result.video_id);
      if (paid) {
        const uploadSessionId = remoteId(result.upload_session_id), progress = adVideoCursor(result, media.size);
        if (progress.offset !== 0 || progress.endOffset === 0) throw new MetaApiError('invalid_response', { uncertain: true });
        const created = await readVideo(videoId, options);
        if (created.id !== videoId || !created.status) throw new MetaApiError('invalid_response', { uncertain: true });
        return confirmed(step, { ...refs, videoId, uploadSessionId }, 'upload_video', { progress });
      }
      const expected = `https://rupload.facebook.com/video-upload/v26.0/${videoId}`;
      if (result.upload_url !== expected && result.upload_url !== `https://rupload.facebook.com/video-upload/${videoId}`) throw new MetaApiError('unsafe_url', { uncertain: true });
      const created = await readVideo(videoId, options);
      if (created.id !== videoId || !created.status) throw new MetaApiError('invalid_response', { uncertain: true });
      return confirmed(step, { ...refs, videoId }, 'upload_video');
    }
    if (step === 'upload_video') {
      checkedMedia(media, spec);
      if (media.kind !== 'video') failSpec();
      if (paid) {
        const progress = adVideoCursor({ start_offset: operation.progress?.offset, end_offset: operation.progress?.endOffset }, media.size);
        if (progress.offset === media.size && progress.endOffset === media.size) return confirmed(step, refs, 'finish_video', { progress });
        if (progress.offset === progress.endOffset) failSpec();
        const fields = { upload_phase: 'transfer', upload_session_id: remoteId(refs.uploadSessionId), start_offset: progress.offset, end_offset: progress.endOffset };
        const form = multipart(media, fields, 'video_file_chunk', progress.offset, progress.endOffset);
        const result = await upload(`${account}/advideos`, form.body, form.headers, { ...fields, assetHash: media.sha256, size: media.size, videoId: refs.videoId });
        const next = adVideoCursor(result, media.size);
        if (next.offset !== progress.endOffset) throw new MetaApiError('invalid_response', { uncertain: true });
        const video = await readVideo(refs.videoId, options);
        if (video.id !== refs.videoId) throw new MetaApiError('invalid_response', { uncertain: true });
        const complete = next.offset === media.size && next.endOffset === media.size;
        return confirmed(step, refs, complete ? 'finish_video' : null, { operationComplete: complete, progress: next });
      }
      let offset = operation.progress?.offset ?? 0;
      if (refs.videoId) offset = videoOffset((await readVideo(refs.videoId, options)).status);
      else if (offset !== 0) return uncertain(step); // IG exposes status_code, not a documented byte offset. Never guess it.
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > media.size) failSpec();
      const next = refs.containerId ? 'wait_container' : 'wait_video';
      if (offset === media.size) return confirmed(step, refs, next, { progress: { offset } });
      const path = `https://rupload.facebook.com/${refs.containerId ? 'ig-api-upload' : 'video-upload'}/v26.0/${remoteId(refs.containerId || refs.videoId)}`;
      const stream = mediaStream(media, offset, media.size);
      const result = await upload(path, stream, { offset: String(offset), file_size: String(media.size), 'content-length': String(media.size - offset) }, { offset, size: media.size, assetHash: media.sha256, videoId: refs.videoId || refs.containerId });
      if (result.success !== true) throw new MetaApiError('invalid_response', { uncertain: true });
      if (refs.videoId) {
        const remoteOffset = videoOffset((await readVideo(refs.videoId, options)).status);
        if (remoteOffset < offset || remoteOffset > media.size) throw new MetaApiError('invalid_response', { uncertain: true });
        return confirmed(step, refs, remoteOffset === media.size ? next : null, { operationComplete: remoteOffset === media.size, progress: { offset: remoteOffset } });
      }
      const container = await client.get(remoteId(refs.containerId), { fields: 'id,status_code' }, options);
      if (!['FINISHED', 'IN_PROGRESS'].includes(container.status_code)) throw new MetaApiError('invalid_response', { uncertain: true });
      return confirmed(step, refs, next);
    }
    if (step === 'finish_video') {
      const result = await send(`${account}/advideos`, { upload_phase: 'finish', upload_session_id: remoteId(refs.uploadSessionId), title: technicalName(operation, 'video') });
      if (result.success !== true) throw new MetaApiError('invalid_response', { uncertain: true });
      const finished = await readVideo(refs.videoId, options);
      if (finished.id !== refs.videoId || !['ready', 'processing'].includes(finished.status?.video_status)) throw new MetaApiError('invalid_response', { uncertain: true });
      return confirmed(step, refs, 'wait_video');
    }
    if (step === 'wait_video') {
      const video = await readVideo(refs.videoId, options);
      if (['error', 'expired', 'upload_failed'].includes(video.status?.video_status)) throw new MetaApiError('rejected');
      if (video.status?.video_status !== 'ready') return pending(step, refs);
      return confirmed(step, refs, paid ? 'create_campaign' : 'publish');
    }
    if (step === 'wait_container') {
      const container = await client.get(remoteId(refs.containerId), { fields: 'id,status_code' }, options);
      if (['ERROR', 'EXPIRED'].includes(container.status_code)) throw new MetaApiError('rejected');
      if (container.status_code !== 'FINISHED') return pending(step, refs);
      return confirmed(step, refs, 'publish');
    }
    if (step === 'publish') {
      if (operation.channel === 'instagram') {
        const result = await send(`${spec.identities.instagramId}/media_publish`, { creation_id: remoteId(refs.containerId) });
        return published(spec, operation, { ...refs, mediaId: remoteId(result.id) }, options);
      }
      if (refs.videoId) {
        const result = await send(`${spec.identities.pageId}/video_reels`, { upload_phase: 'finish', video_state: 'PUBLISHED', video_id: remoteId(refs.videoId), description: spec.caption, is_ai_generated: spec.aiDisclosure });
        if (result.success !== true) throw new MetaApiError('invalid_response', { uncertain: true });
        return published(spec, operation, refs, options);
      }
      const result = await send(`${spec.identities.pageId}/feed`, { message: spec.caption, attached_media: [{ media_fbid: remoteId(refs.photoId) }], published: true });
      if (!POST_ID.test(result.id || '')) throw new MetaApiError('invalid_response', { uncertain: true });
      return published(spec, operation, { ...refs, postId: result.id }, options);
    }
    if (step === 'confirm_publication') return published(spec, operation, refs, options);
    if (step === 'create_campaign') {
      const result = await send(`${account}/campaigns`, campaignPayload(spec, operation));
      const nextRefs = { ...refs, campaignId: remoteId(result.id) };
      const observed = await verifyPaid(spec, operation, nextRefs, options, { partial: true });
      if (observed.campaign.status !== 'PAUSED') failSpec();
      return confirmed(step, nextRefs, 'create_adset');
    }
    if (step === 'create_adset') {
      await verifyPaid(spec, operation, refs, options, { partial: true });
      if ((await client.pages(`${refs.campaignId}/adsets`, { fields: 'id' }, options)).length) failSpec();
      const result = await send(`${account}/adsets`, adsetPayload(spec, operation, refs));
      const nextRefs = { ...refs, adSetId: remoteId(result.id) };
      const observed = await verifyPaid(spec, operation, nextRefs, options, { partial: true });
      if (observed.adset.status !== 'PAUSED') failSpec();
      return confirmed(step, nextRefs, 'create_creative');
    }
    if (step === 'create_creative') {
      await verifyPaid(spec, operation, refs, options, { partial: true });
      // Video Data's optional thumbnail is not copied from a transient FB CDN URL.
      // Use the uploaded video itself, as in the official standalone video example.
      const payload = { name: technicalName(operation, 'creative'), object_story_spec: storyPayload(spec, refs), degrees_of_freedom_spec: enhancements(refs), asset_feed_spec: { audios: [] } };
      const result = await send(`${account}/adcreatives`, payload);
      const nextRefs = { ...refs, creativeId: remoteId(result.id) };
      await verifyPaid(spec, operation, nextRefs, options, { partial: true });
      return confirmed(step, nextRefs, 'create_ad');
    }
    if (step === 'create_ad') {
      if ((await client.pages(`${refs.campaignId}/ads`, { fields: 'id' }, options)).length) failSpec();
      await verifyPaid(spec, operation, refs, options, { partial: true });
      const result = await send(`${account}/ads`, { name: technicalName(operation, 'ad'), adset_id: remoteId(refs.adSetId), creative: { creative_id: remoteId(refs.creativeId) }, status: 'PAUSED' });
      const nextRefs = { ...refs, adId: remoteId(result.id) };
      const observed = await verifyPaid(spec, operation, nextRefs, options);
      if ([observed.campaign, observed.adset, observed.ad].some(object => object.status !== 'PAUSED')) failSpec();
      return confirmed(step, nextRefs, 'verify_prepared');
    }
    if (step === 'verify_prepared') {
      const observed = await verifyPaid(spec, operation, refs, options);
      if ([observed.campaign, observed.adset, observed.ad].some(object => object.status !== 'PAUSED')) failSpec();
      const state = paidState(observed);
      return confirmed(step, { ...refs, remoteId: refs.campaignId }, null, { ...state, preparedRefs: preparedRefs(refs) });
    }
    failSpec();
  }
  async function inspectDelivery({ delivery, operation = null, spec, signal }) {
    const refs = { ...(delivery.remoteRefs || {}), ...(operation?.remoteRefs || {}) };
    const op = operation || { ...delivery, deliveryId: delivery.deliveryId || delivery.id, channel: delivery.channel, step: 'confirm_publication' };
    if (operation && !op.step?.startsWith('pause:') && op.specHash !== hash(spec)) failSpec();
    const options = await context(spec, op.channel || delivery.channel, signal, op.step?.startsWith('pause:'));
    if (operation && /^(activate|pause|resume):/.test(op.step)) return control(spec, op, refs, options, null, true);
    if (!operation) {
      if (spec.mode !== 'paid') return published(spec, op, refs, options);
      const observed = await verifyPaid(spec, op, refs, options);
      return confirmed('inspect', { ...refs, remoteId: refs.campaignId }, null, paidState(observed, Boolean(delivery.everActivated)));
    }
    if (op.step === 'upload_image') {
      const images = await client.pages(`${spec.identities.adAccountId}/adimages`, { fields: 'hash,name' }, options);
      const matches = images.filter(image => image.name === technicalName(op, 'image') && HEX.test(image.hash || ''));
      if (matches.length !== 1) return uncertain(op.step);
      return confirmed(op.step, { ...refs, imageHash: matches[0].hash }, 'create_campaign');
    }
    if (Object.hasOwn(CREATION_STEPS, op.step)) {
      const config = CREATION_STEPS[op.step];
      let recovered;
      if (op.resolution?.kind === 'link' && refs[config[1]]) recovered = { ...refs, [config[1]]: remoteId(refs[config[1]]) };
      else {
        const rows = await client.pages(`${spec.identities.adAccountId}/${config[0]}`, { fields: 'id,name', limit: 100 }, options);
        const matches = rows.filter(row => row.name === technicalName(op, config[3]));
        if (matches.length !== 1) return uncertain(op.step);
        recovered = { ...refs, [config[1]]: remoteId(matches[0].id) };
      }
      await verifyPaid(spec, op, recovered, options, { partial: op.step !== 'create_ad' });
      return confirmed(op.step, recovered, config[2], { evidence: evidence(op.step, { remoteRead: true, ...(op.resolution?.kind === 'link' ? { source: 'operator_verified', operatorVerifiedContent: true, remoteSha256Available: false } : {}) }) });
    }
    if (op.step === 'upload_video' && refs.containerId) {
      const container = await client.get(remoteId(refs.containerId), { fields: 'id,status_code' }, options);
      if (container.status_code === 'FINISHED') return confirmed(op.step, refs, 'wait_container');
      return uncertain(op.step);
    }
    if (op.step === 'upload_video' && spec.mode === 'paid') return uncertain(op.step);
    if (op.step === 'upload_video' && refs.videoId) {
      const video = await readVideo(refs.videoId, options);
      const offset = videoOffset(video.status);
      // A confirmed offset is a receipt for exactly the sent prefix; the next turn resumes that session.
      return confirmed(op.step, refs, null, { operationComplete: false, progress: { offset } });
    }
    if (op.step === 'finish_video' && refs.videoId) {
      const video = await readVideo(refs.videoId, options);
      if (video.status?.video_status === 'ready') return confirmed(op.step, refs, 'wait_video');
      return uncertain(op.step);
    }
    if (['publish', 'confirm_publication'].includes(op.step)) {
      const result = await published(spec, op, refs, options);
      return op.resolution?.kind === 'link' ? { ...result, evidence: { ...result.evidence, source: 'operator_verified', operatorVerifiedContent: true, remoteSha256Available: false } } : result;
    }
    // A lost IG media_publish response cannot be associated using caption/time. A lost
    // container/upload-session creation likewise has no unambiguous identifier.
    return uncertain(op.step);
  }
  async function verifyRemoteLink({ delivery, operation: pendingOperation = null, spec, remoteId: suppliedId = null, permalink = null, acceptContentVerification, signal }) {
    if (acceptContentVerification !== true || !suppliedId && !permalink) failSpec();
    const refs = { ...(delivery.remoteRefs || {}), ...(pendingOperation?.remoteRefs || {}) };
    const operation = { ...delivery, ...(pendingOperation || {}), deliveryId: pendingOperation?.deliveryId || delivery.deliveryId || delivery.id, channel: delivery.channel };
    if (pendingOperation && pendingOperation.specHash !== hash(spec)) failSpec();
    const options = await context(spec, delivery.channel, signal);
    if (permalink) permalink = socialPermalink(permalink);
    if (spec.mode === 'paid' && pendingOperation && Object.hasOwn(CREATION_STEPS, pendingOperation.step)) {
      const config = CREATION_STEPS[pendingOperation.step];
      if (!suppliedId || !ID.test(suppliedId) || refs[config[1]] && refs[config[1]] !== suppliedId) failSpec();
      refs[config[1]] = suppliedId;
      await verifyPaid(spec, operation, refs, options, { partial: pendingOperation.step !== 'create_ad' });
      return confirmed('link_remote', refs, config[2], { evidence: evidence('link_remote', { remoteRead: true, source: 'operator_verified', operatorVerifiedContent: true, remoteSha256Available: false }) });
    }
    if (spec.mode === 'paid') {
      if (!suppliedId || !ID.test(suppliedId) || refs.campaignId && refs.campaignId !== suppliedId) failSpec();
      refs.campaignId = suppliedId;
      const sets = await client.pages(`${suppliedId}/adsets`, { fields: 'id' }, options);
      const ads = await client.pages(`${suppliedId}/ads`, { fields: 'id,creative' }, options);
      if (sets.length !== 1 || ads.length !== 1) failSpec();
      refs.adSetId = remoteId(sets[0].id); refs.adId = remoteId(ads[0].id); refs.creativeId = remoteId(ads[0].creative?.id);
      const creative = await client.get(refs.creativeId, { fields: 'id,object_story_spec' }, options);
      const story = creative.object_story_spec;
      if (story?.video_data?.video_id) refs.videoId = remoteId(story.video_data.video_id);
      else if (HEX.test(story?.link_data?.image_hash || '')) refs.imageHash = story.link_data.image_hash;
      else failSpec();
      const observed = await verifyPaid(spec, operation, refs, options);
      const result = paidState(observed, Boolean(delivery.everActivated));
      return confirmed('link_remote', { ...refs, remoteId: suppliedId }, null, { ...result, evidence: { ...result.evidence, source: 'operator_verified', operatorVerifiedContent: true, remoteSha256Available: false }, preparedRefs: preparedRefs(refs) });
    }
    if (delivery.channel === 'instagram') {
      const media = await client.pages(`${spec.identities.instagramId}/media`, { fields: 'id,permalink,media_type,caption', limit: 100 }, options);
      const matches = media.filter(item => (!suppliedId || item.id === suppliedId) && (!permalink || item.permalink === permalink));
      if (matches.length !== 1) failSpec();
      refs.mediaId = remoteId(matches[0].id);
    } else if (spec.placements?.includes('facebook_reels')) {
      if (suppliedId && !ID.test(suppliedId)) failSpec();
      const videos = await client.pages(`${spec.identities.pageId}/video_reels`, { fields: 'id,permalink_url' }, options);
      const matches = videos.filter(item => (!suppliedId || item.id === suppliedId) && (!permalink || item.permalink_url === permalink));
      if (matches.length !== 1) failSpec();
      refs.videoId = remoteId(matches[0].id);
    } else {
      if (suppliedId && !POST_ID.test(suppliedId)) failSpec();
      const posts = await client.pages(`${spec.identities.pageId}/published_posts`, { fields: 'id,permalink_url,attachments{target{id}}', limit: 100 }, options);
      const matches = posts.filter(item => (!suppliedId || item.id === suppliedId) && (!permalink || item.permalink_url === permalink));
      if (matches.length !== 1) failSpec();
      const post = matches[0];
      const targets = post?.attachments?.data?.map(item => item.target?.id).filter(value => ID.test(value || ''));
      if (!targets || targets.length !== 1 || refs.photoId && refs.photoId !== targets[0]) failSpec();
      refs.postId = post.id; refs.photoId = targets[0];
    }
    const result = await published(spec, operation, refs, options);
    if (result.status !== 'confirmed') failSpec();
    return { ...result, evidence: { ...result.evidence, phase: 'link_remote', source: 'operator_verified', operatorVerifiedContent: true, remoteSha256Available: false } };
  }
  return { executeStep, inspectDelivery, verifyRemoteLink };
}
