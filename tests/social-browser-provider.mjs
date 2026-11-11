import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';

// Independent stateful UI provider: no imports from the runner/adapter, no spec
// endpoint. Its forms, uploads and remote transitions are the source of truth.
export async function createSocialBrowserProvider() {
  const sessions = new Set(), objects = new Map(), uploads = new Map();
  const state = { userId: '101', businessId: '202', pageId: '303', instagramId: '404', adAccountId: '505', challenge: false, locale: 'en', omit: null, forceBudget: null, forceObjective: null, popupUrl: null, publishCount: 0, activationCount: 0, pauseCount: 0, resumeCount: 0, losePublish: false, loseSave: false, loseCreate: false, privateRedirect: false, exportRows: 1, exportAvailable: true, remainingBudget: '50000.00', publishState: 'Active', campaignCount: 1, adSetCount: 1, adCount: 1, forceEnhancements: false, forceAI: null };
  const catalog = [
    { label: 'Colombia', context: { type: 'country', countryCode: 'CO', region: null, scope: 'Countries in South America' } },
    { label: 'Antioquia', context: { type: 'region', countryCode: 'CO', region: 'Antioquia', scope: 'Colombia / departments' } },
    { label: 'Bogotá', context: { type: 'city', countryCode: 'CO', region: 'Bogotá D.C.', scope: 'Colombia / Bogotá D.C. / cities' } },
    { label: 'Medellín', context: { type: 'city', countryCode: 'CO', region: 'Antioquia', scope: 'Colombia / Antioquia / cities' } },
    { label: 'Fitness', context: { type: 'interest', countryCode: null, region: null, scope: 'Interests / Sports and outdoors' } }
  ];
  let next = 9000;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const defaults = () => ({ caption: '', headline: '', destinationUrl: '', whatsappNumber: '', whatsappGreeting: '', objective: 'traffic', cta: 'learn', crop: 'original', contentFormat: 'feed', publishingSchedule: 'now', shareToFeed: false, automaticMusic: false, geoExpansion: false, countries: '', regions: [], cities: [], ageMin: '18', ageMax: '65', genders: '', interests: [], budgetType: 'lifetime', budget: '0.00', startAt: '', endAt: '', expansion: false, automaticPlacements: false, enhancements: false, aiDisclosure: false, placements: [], platforms: [], media: null });
  function chrome(body) {
    // Native autofocus may run after DOMContentLoaded. Establish the fixture's
    // initial keyboard position before the runner acknowledges the document.
    return `<!doctype html><html lang="${esc(state.locale)}"><head><meta charset="utf-8"><title>Business tools</title><style>body{font:16px sans-serif}label{display:block;margin:8px}input,textarea,select{padding:5px}img{width:80px;height:80px}button{padding:8px;margin:5px}</style></head><body><main>${body}</main><script>document.querySelector('input[autofocus]')?.focus();</script></body></html>`;
  }
  function accounts(objectId = '9000') {
    return `<section><h1>Business tools</h1><p>User ID: ${esc(state.userId)}</p><p>Business ID: ${esc(state.businessId)}</p>${state.pageId ? `<p>Page ID: ${esc(state.pageId)}</p>` : ''}${state.instagramId ? `<p>Instagram account ID: ${esc(state.instagramId)}</p>` : ''}<p>Ad account ID: ${esc(state.adAccountId)}</p><p>Currency: ${esc(state.metricCurrency || 'COP')}</p><p>Time zone: ${esc(state.metricTimeZone || 'America/Bogota')}</p><p>Number format: ${esc(state.numberFormat === undefined ? '1,234.56' : state.numberFormat)}</p><p>Linked WhatsApp number: +573001112233</p>
      <p>Ad account status: Active</p><p>Instagram account type: Business</p>
      <label>Business portfolio<select><option value="portfolio-dom">Nutrition (ID: ${esc(state.businessId)})</option></select></label>
      <label>Page<select><option value="page-dom">Nutrition page (ID: ${esc(state.pageId)})</option></select></label>
      <label>Ad account<select><option value="account-dom">Advertising (ID: ${esc(state.adAccountId)})</option></select></label>
      <form action="/create" method="post"><button name="kind" value="paid">Create campaign</button><button name="kind" value="facebook">Create Facebook post</button><button name="kind" value="instagram">Create Instagram post</button></form>
      <button type="button">WhatsApp conversations</button><button type="button" onclick="location.href='/insights/${objectId}'">View insights</button>
      ${state.popupUrl ? `<button type="button" onclick="window.open('${esc(state.popupUrl)}')">Open help</button>` : ''}</section>`;
  }
  function listing() {
    return [...objects.values()].map(object => `<article><a href="/${object.state === 'Draft' ? 'draft' : 'object'}/${object.id}">${object.state === 'Draft' ? 'Draft' : object.kind === 'paid' ? 'Campaign' : 'Content'} ${esc(object.name || 'Untitled')} (ID: ${object.id})</a>${object.state === 'Published' ? `<a href="${esc(object.channel === 'instagram' ? `https://www.instagram.com/p/${object.id}/` : `https://www.facebook.com/${state.pageId}/posts/${object.id}`)}">Open published content</a>` : ''}</article>`).join('');
  }
  function field(name, label, value, type = 'text') {
    if (state.omit === name) return '';
    return `<label>${label}<input name="${name}" type="${type}" value="${esc(value)}"></label>`;
  }
  const typeNames = { country: 'Country', region: 'Region', city: 'City', interest: 'Interest' };
  function referenceText(item) {
    return `<p>Name: ${esc(item.label)}</p><p>Type: ${typeNames[item.context.type]}</p>${item.context.countryCode ? `<p>Country code: ${esc(item.context.countryCode)}</p>` : ''}${item.context.region ? `<p>Region: ${esc(item.context.region)}</p>` : ''}<p>Scope: ${esc(item.context.scope)}</p>`;
  }
  function referenceItem(item) {
    return `<li>${referenceText(item)}${item.context.type === 'city' ? `<label>Radius<input type="number" value="${esc(item.context.radius ?? 17)}"></label><label>Distance unit<select><option value="km" ${item.context.distanceUnit !== 'mile' ? 'selected' : ''}>Kilometers</option><option value="mi" ${item.context.distanceUnit === 'mile' ? 'selected' : ''}>Miles</option></select></label>` : ''}</li>`;
  }
  function editor(object) {
    const config = { ...object.config, ...(state.forceBudget !== null ? { budget: state.forceBudget } : {}), ...(state.forceObjective ? { objective: state.forceObjective } : {}), ...(state.forceAI !== null ? { aiDisclosure: state.forceAI } : {}), ...(state.forceEnhancements ? { enhancements: true } : {}) };
    const checkbox = (name, label, checked) => `<label><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}>${label}</label>`;
    const options = (name, label, pairs, value) => `<label>${label}<select name="${name}">${pairs.map(([id, text]) => `<option value="${id}" ${id === value ? 'selected' : ''}>${text}</option>`).join('')}</select></label>`;
    return `${accounts(object.id)}${listing()}<h2>${object.kind === 'paid' ? 'Campaign editor' : 'Post editor'}</h2>
      <p>${object.state === 'Draft' ? 'Draft ID' : object.kind === 'paid' ? 'Campaign ID' : 'Content ID'}: ${object.id}</p><p>Delivery status: ${object.state}</p>
      ${state.hidePauseMetadata ? '' : `<p>Ever activated: ${object.everActivated ? 'Yes' : 'No'}</p>${object.kind === 'paid' ? `<p>Ad set ID: ${object.adSetId}</p><p>Ad ID: ${object.adId}</p><p>Creative ID: ${object.creativeId}</p><p>Remaining budget: ${esc(state.remainingBudget ?? '—')}</p><p>Delivery ended: ${object.ended ? 'Yes' : 'No'}</p><p>Delivery running: ${object.state === 'Active' ? 'Yes' : 'No'}</p>` : `<p>Published channel: ${esc(object.channel)}</p>`}`}
      ${object.state === 'Published' ? `<p>Permalink: ${esc(state.permalink || (object.channel === 'instagram' ? `https://www.instagram.com/p/${object.id}/` : `https://www.facebook.com/${state.pageId}/posts/${object.id}`))}</p>` : ''}
      ${object.state === 'Rejected' ? '<p>Rejection reason: Creative review rejected this advertisement</p>' : ''}
      <p>Budget allocation: Ad set</p><p>Taxes and fees: Taxes may apply</p><p>Campaign count: ${state.campaignCount}</p><p>Ad set count: ${state.adSetCount}</p><p>Ad count: ${state.adCount}</p><p>Potential audience: 10000 – 20000</p>
      <form id="editor" action="/save/${object.id}" method="post">
      ${field('campaignName', 'Campaign name', object.name)}
      ${field('caption', 'Post text', config.caption)}${field('headline', 'Headline', config.headline)}${field('destinationUrl', 'Website URL', config.destinationUrl)}${field('whatsappNumber', 'WhatsApp number', config.whatsappNumber)}
      ${field('whatsappGreeting', 'WhatsApp welcome message', config.whatsappGreeting)}
      ${checkbox('aiDisclosure', 'AI disclosure', config.aiDisclosure)}${checkbox('enhancements', 'Automatic creative enhancements', config.enhancements)}
      ${checkbox('automaticMusic', 'Automatic music', config.automaticMusic)}
      ${options('crop', 'Media framing', [['original', 'Original'], ['square', 'Square crop']], config.crop)}
      ${options('cta', 'Call to action', [['learn', 'Learn more'], ['whatsapp', 'Send WhatsApp message'], ['none', 'No button']], config.cta)}
      ${checkbox('geoExpansion', 'Geographic expansion', config.geoExpansion)}
      ${options('contentFormat', 'Content format', [['feed', 'Feed post'], ['reel', 'Reel']], config.contentFormat)}
      ${options('publishingSchedule', 'Publishing schedule', [['now', 'Publish now'], ['later', 'Schedule for later']], config.publishingSchedule)}
      <label>Add photos or videos<input type="file" name="media" accept="image/jpeg,video/mp4"></label><div id="preview">${config.media ? `<p>Media ID: ${config.media.id}</p><p>Media format: ${config.media.format}</p>${config.media.format === 'Video' ? `<video controls preload="metadata" width="160" height="280" aria-label="${esc(config.media.name)}" src="/media/${config.media.id}"></video>` : `<img src="/media/${config.media.id}" alt="${esc(config.media.name)}">`}` : ''}</div>
      ${options('objective', 'Campaign objective', [['traffic', 'Website traffic'], ['whatsapp', 'WhatsApp conversations'], ['reach', 'Reach'], ['engagement', 'Post engagement']], config.objective)}
      ${options('budgetType', 'Budget type', [['lifetime', 'Lifetime budget'], ['daily', 'Daily budget']], config.budgetType)}${field('budget', 'Total budget', config.budget)}
      ${field('startAt', 'Start date and time', config.startAt)}${field('endAt', 'End date and time', config.endAt)}
      ${['countries', 'ageMin', 'ageMax', 'genders'].map(name => field(name, ({ countries: 'Countries', ageMin: 'Minimum age', ageMax: 'Maximum age', genders: 'Genders' })[name], config[name])).join('')}
      ${[['regions', 'Selected regions'], ['cities', 'Selected cities'], ['interests', 'Selected interests']].map(([key, label]) => `<fieldset id="${key}"><legend>${label}</legend><input type="hidden" name="${key}" value="${esc(JSON.stringify(config[key]))}"><ul>${config[key].map(referenceItem).join('')}</ul><button type="button" onclick="clearReferences('${key}')">Remove all</button></fieldset>`).join('')}
      ${checkbox('expansion', 'Advantage+ audience', config.expansion)}${checkbox('automaticPlacements', 'Advantage+ placements', config.automaticPlacements)}
      ${[['facebook_feed', 'Facebook Feed'], ['instagram_feed', 'Instagram Feed'], ['facebook_reels', 'Facebook Reels'], ['instagram_reels', 'Instagram Reels']].map(([key, label]) => checkbox(key, label, config.placements.includes(key))).join('')}
      ${checkbox('facebook', 'Facebook destination', config.platforms.includes('facebook'))}${checkbox('instagram', 'Instagram destination', config.platforms.includes('instagram'))}
      ${checkbox('shareToFeed', 'Share Reel to feed', config.shareToFeed)}
      <button name="action" value="save">Save draft</button><button name="action" value="publish">${object.kind === 'paid' ? 'Publish campaign' : 'Publish post'}</button><button name="action" value="pause">Pause campaign</button><button name="action" value="resume">Resume campaign</button>
      </form>
      <label>Search locations<input role="combobox" aria-autocomplete="list" oninput="searchReferences(this.value,false)"></label><label>Search interests<input role="combobox" aria-autocomplete="list" oninput="searchReferences(this.value,true)"></label><ul role="listbox" hidden></ul>
      <script>
      const catalog=${JSON.stringify(catalog)}, selected=${JSON.stringify({ regions: config.regions, cities: config.cities, interests: config.interests })};
      function syncReferences(key){const group=document.getElementById(key);group.querySelector('input[type=hidden]').value=JSON.stringify(selected[key].map((item,index)=>{const copy=JSON.parse(JSON.stringify(item));if(copy.context.type==='city'){const row=group.querySelectorAll('li')[index];copy.context.radius=Number(row.querySelector('input[type=number]').value);copy.context.distanceUnit=row.querySelector('select').value==='km'?'kilometer':'mile'}return copy}))}
      function clearReferences(key){selected[key]=[];document.getElementById(key).querySelector('ul').replaceChildren();syncReferences(key)}
      function searchReferences(query,interest){const list=document.querySelector('[role=listbox]');list.hidden=false;list.replaceChildren();catalog.forEach(item=>{if((item.context.type==='interest')!==interest||!item.label.toLowerCase().includes(query.toLowerCase()))return;const row=document.createElement('li');row.role='option';row.innerHTML=referenceHTML(item);row.onclick=()=>{const key=({city:'cities',region:'regions',interest:'interests'})[item.context.type];if(!key)return;selected[key].push(JSON.parse(JSON.stringify(item)));const entry=document.createElement('li');entry.innerHTML=referenceHTML(item)+(item.context.type==='city'?'<label>Radius<input type="number" value="17"></label><label>Distance unit<select><option value="km">Kilometers</option><option value="mi">Miles</option></select></label>':'');document.getElementById(key).querySelector('ul').append(entry);syncReferences(key);list.hidden=true};list.append(row)})}
      function referenceHTML(item){const types={country:'Country',region:'Region',city:'City',interest:'Interest'};const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));return '<p>Name: '+escape(item.label)+'</p><p>Type: '+types[item.context.type]+'</p>'+(item.context.countryCode?'<p>Country code: '+escape(item.context.countryCode)+'</p>':'')+(item.context.region?'<p>Region: '+escape(item.context.region)+'</p>':'')+'<p>Scope: '+escape(item.context.scope)+'</p>'}
      document.getElementById('editor').addEventListener('submit',()=>{for(const key of ['regions','cities','interests'])syncReferences(key)});
      document.querySelector('input[type=file]').addEventListener('change',async event=>{
        const file=event.target.files[0]; if(!file)return;
        const response=await fetch('/upload/${object.id}?name='+encodeURIComponent(file.name),{method:'POST',body:file});
        const media=await response.json(); const preview=media.format==='Video'?document.createElement('video'):new Image();if(media.format==='Video'){preview.controls=true;preview.preload='metadata';preview.width=160;preview.height=280;preview.setAttribute('aria-label',media.name)}else preview.alt=media.name;preview.src='/media/'+media.id; const identity=document.createElement('p');identity.textContent='Media ID: '+media.id;const format=document.createElement('p');format.textContent='Media format: '+media.format;document.getElementById('preview').replaceChildren(identity,format,preview);
      });
      </script>`;
  }
  const dimensionNames = { none: 'None', day: 'Day', placement: 'Platform and placement', age_gender: 'Age and gender', country: 'Country' };
  function performanceData(object, url) {
    const from = state.metricFrom || url.searchParams.get('from') || '2026-10-01', to = state.metricTo || url.searchParams.get('to') || '2026-10-31', dimension = url.searchParams.get('dimension') || 'none';
    const dimensions = { placement: ['Publisher platform', 'Placement'], age_gender: ['Age', 'Gender'], country: ['Country'] }[dimension] || [];
    const organic = object.kind === 'organic', video = object.config.contentFormat === 'reel';
    const metrics = organic
      ? ['Reach', 'Views', 'Likes', 'Comments', 'Shares', 'Saves', 'Content interactions', ...(video ? ['Plays', 'Average watch time (seconds)', 'Total watch time (seconds)', 'Skip rate (percent)'] : [])]
      : ['Amount spent', 'Impressions', 'Reach', 'Link clicks', 'WhatsApp conversations started'];
    const headers = state.metricHeaders || [organic ? 'Content ID' : 'Campaign ID', 'Reporting starts', 'Reporting ends', ...dimensions, ...metrics];
    const values = { 'Amount spent': '100,000.00', Impressions: '4,000', Reach: '3,000', 'Link clicks': '100', 'WhatsApp conversations started': '10', Views: '4,500', Likes: '50', Comments: '0', Shares: '3', Saves: '7', 'Content interactions': '60', Plays: '4,200', 'Average watch time (seconds)': '2.125', 'Total watch time (seconds)': '8,925.5', 'Skip rate (percent)': '12.5', ...state.metricValues };
    const rows = state.metricRows || Array.from({ length: state.exportRows }, (_, i) => {
      const day = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
      return headers.map(header => ({
        'Campaign ID': state.metricRemoteId || object.id, 'Content ID': state.metricRemoteId || object.id,
        'Reporting starts': dimension === 'day' ? day : from, 'Reporting ends': dimension === 'day' ? day : to,
        'Publisher platform': i % 2 ? 'instagram' : 'facebook', Placement: i % 2 ? 'reels' : 'feed',
        Age: i % 2 ? '35-44' : '25-34', Gender: i % 2 ? 'female' : 'male', Country: i % 2 ? 'US' : 'CO'
      })[header] ?? (i === 0 ? values[header] ?? '' : '0'));
    });
    return { headers, rows, from, to, dimension };
  }
  function insights(object, url) {
    const { headers, rows, from, to, dimension } = performanceData(object, url), page = Number(url.searchParams.get('page') || 1);
    const supported = state.metricDimensions || ['none', 'day'], organic = object.kind === 'organic';
    const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&dimension=${dimension}`;
    const renderRows = batch => batch.map(row => `<tr>${row.map(value => `<td>${esc(value)}</td>`).join('')}</tr>`).join('');
    const firstRows = rows.slice((page - 1) * 2, page * 2);
    return `${accounts(object.id)}<h2>Performance</h2><p>${organic ? 'Content ID' : 'Campaign ID'}: ${object.id}</p><p>Metric scope: ${esc(state.metricScope || (organic ? 'Organic' : 'Paid'))}</p>${state.unknownAttribution ? '' : '<p>Attribution setting: 7-day click</p>'}<p>Reporting starts: ${esc(from)}</p><p>Reporting ends: ${esc(to)}</p><p>Reporting period type: ${state.metricPeriodType || (organic ? 'Lifetime' : 'Range')}</p><p>Breakdown: ${dimensionNames[dimension]}</p><p>Total rows: ${state.declaredRows ?? rows.length}</p><p>Export row count: ${state.declaredRows ?? rows.length}</p>
      <form action="/insights/${object.id}">${field('from', 'Reporting starts', from)}${field('to', 'Reporting ends', to)}<label>Breakdown<select name="dimension">${supported.map(key => `<option value="${key}" ${dimension === key ? 'selected' : ''}>${dimensionNames[key]}</option>`).join('')}</select></label><button>Apply date range</button></form>
      ${state.exportAvailable ? `<button onclick="location.href='/export/${object.id}?${query}'">Export performance</button>` : ''}
      <div ${state.virtualRows ? 'style="height:150px;overflow:auto" id="virtual-performance"' : ''}><table aria-label="Performance"><thead><tr>${headers.map(value => `<th title="${esc(state.metricTooltips?.[value] || '')}">${esc(value)}</th>`).join('')}</tr></thead><tbody>${renderRows(firstRows)}</tbody></table>${state.virtualRows ? '<div style="height:2000px"></div>' : ''}</div>
      ${state.virtualRows ? `<script>const rows=${JSON.stringify(rows)},container=document.getElementById('virtual-performance');let offset=0;container.addEventListener('scroll',()=>{offset=Math.min(offset+2,Math.max(0,rows.length-2));const body=container.querySelector('tbody');body.replaceChildren();for(const row of rows.slice(offset,offset+2)){const tr=document.createElement('tr');for(const value of row){const td=document.createElement('td');td.textContent=value;tr.append(td)}body.append(tr)}});</script>` : `<button ${state.stopPagination || page * 2 >= rows.length ? 'disabled' : ''} onclick="location.href='/insights/${object.id}?${query}&page=${page + 1}'">Next page</button>`}`;
  }
  let serverOrigin;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, serverOrigin), path = url.pathname;
      const send = (code, body, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(body); };
      const redirect = path => { res.writeHead(303, { location: path, 'cache-control': 'no-store' }); res.end(); };
      let body = Buffer.alloc(0);
      if (req.method === 'POST') { const chunks = []; let length = 0; for await (const chunk of req) { length += chunk.length; if (length > 251 * 1024 * 1024) throw new Error('oversized'); chunks.push(chunk); } body = Buffer.concat(chunks, length); }
      const data = new URLSearchParams(body.toString());
      if (path === '/login' && req.method === 'POST') {
        if (data.get('email') !== 'admin@example.test' || data.get('password') !== 'password-canary-2fa') return send(403, chrome('<h1>Login denied</h1>'));
        const session = randomBytes(24).toString('hex'); sessions.add(session);
        res.setHeader('set-cookie', `fixture_session=${session}; HttpOnly; SameSite=Strict; Path=/`); redirect('/latest/home'); return;
      }
      const session = (req.headers.cookie || '').match(/(?:^|;\s*)fixture_session=([^;]+)/)?.[1];
      if (!sessions.has(session)) return send(200, chrome(`<h1>Log in</h1><form method="post" action="/login"><label>Email or phone<input name="email" autocomplete="username" autofocus></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Log in</button></form>${state.popupUrl ? `<button onclick="window.open('${esc(state.popupUrl)}')">Open help</button>` : ''}`));
      if (state.challenge) {
        if (path === '/challenge' && data.get('code') === '654321') { state.challenge = false; redirect('/latest/home'); return; }
        return send(200, chrome('<h1>Two-factor authentication</h1><form action="/challenge" method="post"><label>Security code<input name="code" autofocus></label><button>Continue</button></form>'));
      }
      if (state.privateRedirect) { redirect(typeof state.privateRedirect === 'string' ? state.privateRedirect : 'http://169.254.169.254/latest/meta-data'); return; }
      if (path === '/latest/home') return send(200, chrome(accounts() + listing()));
      if (path === '/create' && req.method === 'POST') {
        if (typeof state.beforeCreate === 'function') await state.beforeCreate();
        const id = String(++next), kind = data.get('kind');
        const object = { id, kind: kind === 'paid' ? 'paid' : 'organic', channel: kind === 'paid' ? null : kind, state: 'Draft', everActivated: false, adSetId: String(++next), adId: String(++next), creativeId: String(++next), config: defaults(), name: '' };
        if (kind !== 'paid') object.config.platforms = [kind];
        objects.set(id, object); if (state.loseCreate) { req.socket.destroy(); return; } redirect(`/draft/${id}`); return;
      }
      const match = path.match(/^\/(draft|object|save|upload|media|insights|export)\/(\d+)$/);
      if (!match) return send(404, chrome('<h1>Not found</h1>'));
      const [, action, id] = match;
      if (action === 'media') { const upload = uploads.get(id); if (!upload) return send(404, ''); res.writeHead(200, { 'content-type': upload.format === 'Video' ? 'video/mp4' : 'image/jpeg', 'content-length': upload.bytes.length }); res.end(upload.bytes); return; }
      const object = objects.get(id);
      if (!object) return send(404, chrome('<h1>Not found</h1>'));
      if (action === 'upload' && req.method === 'POST') {
        const media = { id: String(++next), name: url.searchParams.get('name'), format: /\.mp4$/i.test(url.searchParams.get('name') || '') ? 'Video' : 'Image', sha256: createHash('sha256').update(body).digest('hex') };
        uploads.set(media.id, { ...media, bytes: body }); object.config.media = media;
        send(200, JSON.stringify(media), { 'content-type': 'application/json' }); return;
      }
      if (action === 'save' && req.method === 'POST') {
        const control = data.get('action');
        if (control === 'pause' || control === 'resume') {
          if (object.kind !== 'paid' || !object.everActivated || (control === 'resume' ? object.state !== 'Paused' : !['Active', 'Scheduled', 'In review'].includes(object.state))) return send(409, chrome('<h1>Control not available</h1>'));
          object.state = control === 'pause' ? 'Paused' : state.publishState;
          state[control === 'pause' ? 'pauseCount' : 'resumeCount']++;
          redirect(`/object/${id}`); return;
        }
        const config = object.config;
        for (const key of ['caption', 'headline', 'destinationUrl', 'whatsappNumber', 'whatsappGreeting', 'objective', 'cta', 'crop', 'contentFormat', 'publishingSchedule', 'countries', 'ageMin', 'ageMax', 'genders', 'budgetType', 'budget', 'startAt', 'endAt']) config[key] = data.get(key) || '';
        for (const key of ['regions', 'cities', 'interests']) {
          const values = JSON.parse(data.get(key) || '[]');
          if (!Array.isArray(values) || values.some(item => !catalog.some(candidate => candidate.label === item.label && ['type', 'countryCode', 'region', 'scope'].every(key => candidate.context[key] === item.context[key])) || item.context.type === 'city' && (!(item.context.distanceUnit === 'kilometer' ? item.context.radius >= 17 && item.context.radius <= 80 : item.context.distanceUnit === 'mile' && item.context.radius >= 10 && item.context.radius <= 50)))) return send(400, chrome('<h1>Invalid geographic selection</h1>'));
          config[key] = values;
        }
        const countries = config.countries.split(';').map(value => value.trim()).filter(Boolean);
        if ([...config.regions, ...config.cities].some(item => countries.includes(item.context.countryCode)) || config.cities.some(city => config.regions.some(region => region.context.countryCode === city.context.countryCode && region.context.region === city.context.region))) return send(400, chrome('<h1>Overlapping geography</h1>'));
        for (const key of ['expansion', 'automaticPlacements', 'aiDisclosure', 'enhancements', 'automaticMusic', 'geoExpansion', 'shareToFeed']) config[key] = data.has(key);
        config.placements = ['facebook_feed', 'instagram_feed', 'facebook_reels', 'instagram_reels'].filter(key => data.has(key)); config.platforms = ['facebook', 'instagram'].filter(key => data.has(key)); object.name = data.get('campaignName');
        if (data.get('action') === 'publish') {
          if (!config.media || !config.caption || object.kind === 'paid' && (config.budgetType !== 'lifetime' || Number(config.budget.replaceAll(',', '')) <= 0 || !config.startAt || !config.endAt)) return send(400, chrome('<h1>Invalid configuration</h1>'));
          if (object.kind === 'paid' && (config.objective === 'whatsapp' && (!config.whatsappGreeting || config.whatsappNumber !== '+573001112233') || config.expansion || config.automaticPlacements || config.enhancements || state.campaignCount !== 1 || state.adSetCount !== 1 || state.adCount !== 1)) return send(400, chrome('<h1>Unsupported campaign configuration</h1>'));
          if (object.kind === 'organic' && (config.platforms.length !== 1 || config.platforms[0] !== object.channel || config.publishingSchedule !== 'now' || config.contentFormat !== (config.media.format === 'Video' ? 'reel' : 'feed') || object.channel === 'instagram' && config.media.format === 'Video' && !config.shareToFeed)) return send(400, chrome('<h1>Incorrect publication channel or format</h1>'));
          if (object.state !== 'Draft') return send(409, chrome('<h1>Already sent</h1>'));
          object.state = object.kind === 'paid' ? state.publishState : 'Published'; object.everActivated = object.kind === 'paid';
          if (object.kind === 'paid') state.activationCount++; else state.publishCount++;
          if (typeof state.afterPublish === 'function') state.afterPublish(object);
          if (state.losePublish) { req.socket.destroy(); return; }
        }
        if (state.loseSave && data.get('action') === 'save') { req.socket.destroy(); return; }
        redirect(`/${object.state === 'Draft' ? 'draft' : 'object'}/${id}`); return;
      }
      if (action === 'insights') return send(200, chrome(insights(object, url)));
      if (action === 'export') {
        const { headers, rows } = performanceData(object, url), separator = state.csvSeparator || ',';
        const lines = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replaceAll('"', '""')}"`).join(separator)).join('\r\n');
        send(200, lines, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="performance.csv"' }); return;
      }
      send(200, chrome(editor(object)));
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  serverOrigin = `http://127.0.0.1:${server.address().port}`;
  return { origin: serverOrigin, state, catalog, objects, uploads,
    seedMeasurementObject({ kind = 'paid', channel = null, video = false } = {}) {
      const id = String(++next), object = { id, kind, channel, state: kind === 'paid' ? 'Active' : 'Published', everActivated: kind === 'paid', adSetId: String(++next), adId: String(++next), creativeId: String(++next), name: 'Independent measurement record', config: { ...defaults(), contentFormat: video ? 'reel' : 'feed', platforms: channel ? [channel] : [] } };
      objects.set(id, object); return object;
    },
    expireSessions() { sessions.clear(); }, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
