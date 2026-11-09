import { randomUUID } from 'node:crypto';

export const HEKA_ADAPTER_VERSION = 'heka-classic-v1';
export const HEKA_LOGIN_URL = 'https://www.hekaentrega.co/ingreso';
export const HEKA_PORTAL_URL = 'https://admin.hekaentrega.co/plataforma2.html';
const ERROR_CODES = new Set(['login_required', 'challenge_required', 'contract_changed', 'incomplete', 'limit_exceeded', 'timeout', 'provider_error', 'account_mismatch']);
const failure = code => Object.assign(new Error(code), { code });

// This function is serialized from the installed bundle, never supplied by a job or page.
async function readClassicPage({ operation, query, account, deadline, token }) {
  const codes = ['login_required', 'challenge_required', 'contract_changed', 'incomplete', 'limit_exceeded', 'timeout', 'provider_error', 'account_mismatch'];
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const reads = globalThis.__selleneitorHekaReads ??= new Map();
  reads.set(token, false);
  try {
    const carriers = ['SERVIENTREGA', 'ENVIA', 'TCC', 'INTERRAPIDISIMO', 'COORDINADORA', 'REFERIDOS', 'HEKA'];
    const text = (value, optional = false, max = 256) => {
      if (optional && (value == null || value === '')) return null;
      if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail('contract_changed');
      return value;
    };
    const millis = (value, optional = false) => {
      if (optional && value == null) return null;
      if (!Number.isSafeInteger(value) || value < 0 || value > 253402300799999) fail('contract_changed');
      return value;
    };
    const timestamp = value => {
      if (value == null) return null;
      if (typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'seconds') || !Object.hasOwn(value, 'nanoseconds')) fail('contract_changed');
      const { seconds, nanoseconds } = value;
      if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799 || !Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > 999999999) fail('contract_changed');
      return { seconds, nanoseconds };
    };
    const day = value => {
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail('contract_changed');
      return value;
    };
    const money = (value, optional = false, nonnegative = false) => {
      if (optional && (value == null || value === '')) return null;
      if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
      if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,2})?$/.test(value)) fail('contract_changed');
      const negative = value.startsWith('-');
      const [whole, fraction = ''] = value.replace(/^-/, '').split('.');
      const minor = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n);
      if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER) || (nonnegative && minor < 0n)) fail('contract_changed');
      return { raw: `${minor < 0n ? '-' : ''}${(minor < 0n ? -minor : minor) / 100n}.${String((minor < 0n ? -minor : minor) % 100n).padStart(2, '0')}`, minor };
    };
    const observedMoney = (value, nonnegative = false) => money(value, true, nonnegative)?.raw ?? null;
    const identity = () => {
      const visibleChallenge = [...document.querySelectorAll('iframe[src*="captcha"], iframe[src*="challenge"], input[autocomplete="one-time-code"]')].some(node => node.getClientRects().length > 0);
      if (visibleChallenge || /(?:challenge|captcha)/i.test(location.pathname)) fail('challenge_required');
      if (location.origin === 'https://www.hekaentrega.co' && location.pathname.startsWith('/ingreso')) fail('login_required');
      if (location.origin !== 'https://admin.hekaentrega.co' || location.pathname !== '/plataforma2.html') fail('contract_changed');
      if (typeof firebase === 'undefined' || !/^[78]\./.test(firebase.SDK_VERSION ?? '') || typeof firebase.firestore !== 'function') fail('contract_changed');
      const userId = localStorage.user_id;
      const centerCost = typeof datos_usuario === 'undefined' ? null : datos_usuario.centro_de_costo;
      if (!userId || !centerCost) fail('login_required');
      const result = { userId: text(userId), centerCost: text(centerCost) };
      if (result.userId.includes('/')) fail('contract_changed');
      if (account && (result.userId !== account.userId || result.centerCost !== account.centerCost)) fail('account_mismatch');
      return result;
    };
    const check = () => {
      if (reads.get(token) || Date.now() >= deadline) fail('timeout');
      return identity();
    };
    const initialAccount = check();
    if (operation === 'identity') return { ok: true, value: initialAccount };
    if (!account || initialAccount.userId !== account.userId || initialAccount.centerCost !== account.centerCost) fail('account_mismatch');
    if (!query || Object.keys(query).some(key => !['queryId', 'from', 'to', 'tracking'].includes(key))) fail('contract_changed');
    const typedQuery = { queryId: text(query.queryId), from: day(query.from), to: day(query.to), tracking: text(query.tracking, true) ?? '' };
    const span = Date.parse(typedQuery.to) - Date.parse(typedQuery.from);
    if (span < 0 || span > 30 * 86400000) fail('limit_exceeded');
    const from = Date.parse(typedQuery.from + 'T00:00:00-05:00');
    const until = Date.parse(typedQuery.to + 'T00:00:00-05:00') + 86400000;
    const cutoff = Date.parse(typedQuery.to + 'T00:00:00Z') + 86400000;
    const db = firebase.firestore();
    if (!db || typeof db.collection !== 'function' || !firebase.firestore.FieldPath?.documentId) fail('contract_changed');
    const documentOrder = firebase.firestore.FieldPath.documentId();
    const serverMetadata = snapshot => {
      if (!snapshot?.metadata || snapshot.metadata.fromCache !== false || snapshot.metadata.hasPendingWrites !== false) fail('incomplete');
    };
    const get = async reference => {
      check();
      const snapshot = await reference.get({ source: 'server' });
      check();
      serverMetadata(snapshot);
      return snapshot;
    };
    const documentData = doc => {
      serverMetadata(doc);
      if (doc.exists !== true || typeof doc.data !== 'function' || !doc.ref || typeof doc.ref.path !== 'string') fail('incomplete');
      text(doc.id);
      const data = doc.data();
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('contract_changed');
      return data;
    };
    const pages = async (reference, consume, expectedPath) => {
      let cursor = null;
      const seen = new Set();
      for (;;) {
        const request = cursor ? reference.startAfter(cursor) : reference;
        const snapshot = await get(request.limit(500));
        if (!Array.isArray(snapshot.docs) || snapshot.size !== snapshot.docs.length || snapshot.docs.length > 500) fail('incomplete');
        for (const doc of snapshot.docs) {
          const data = documentData(doc);
          if (doc.ref.path !== `${expectedPath}/${doc.id}` || seen.has(doc.ref.path)) fail('incomplete');
          seen.add(doc.ref.path);
          consume(doc.id, data);
        }
        if (snapshot.docs.length < 500) break;
        cursor = snapshot.docs[snapshot.docs.length - 1];
      }
    };
    let rows = 0, bytes = 0;
    const budget = (value, count = true) => {
      if (count && ++rows > 10000) fail('limit_exceeded');
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > 10 * 1024 * 1024) fail('limit_exceeded');
      return value;
    };
    const guides = [];
    const guidePath = `usuarios/${account.userId}/guias`;
    let guideRef = db.collection('usuarios').doc(account.userId).collection('guias');
    if (typedQuery.tracking) guideRef = guideRef.where('numeroGuia', '==', typedQuery.tracking);
    guideRef = guideRef.where('timeline', '>=', from).where('timeline', '<', until).orderBy('timeline', 'desc').orderBy(documentOrder, 'desc');
    await pages(guideRef, (documentId, data) => {
      if (data.timeline < from || data.timeline >= until || (typedQuery.tracking && data.numeroGuia !== typedQuery.tracking)) fail('incomplete');
      guides.push(budget({ documentId, id_heka: text(data.id_heka), numeroGuia: text(data.numeroGuia), transportadora: text(data.transportadora),
        estado: text(data.estado, true), estadoTransportadora: text(data.estadoTransportadora, true), referencia: text(data.referencia, true, 1000),
        ultima_actualizacion: timestamp(data.ultima_actualizacion), fecha: text(data.fecha, true), timeline: millis(data.timeline, true),
        seguro: observedMoney(data.seguro, true), valor: observedMoney(data.valor, true), costo_envio: observedMoney(data.costo_envio), type: text(data.type, true) }));
    }, guidePath);
    const paidRef = carrier => db.collection('pagos').doc(carrier).collection('pagos').where('REMITENTE', '==', account.centerCost);
    const packageIds = new Set(), discovered = new Map();
    const line = (documentId, data, carrierCollection, packageId = null) => {
      if (data.REMITENTE !== account.centerCost) fail('account_mismatch');
      if (!carriers.includes(carrierCollection)) fail('contract_changed');
      if (packageId ? data.idPaquetePago !== packageId : data.idPaquetePago != null && data.idPaquetePago !== '') fail('incomplete');
      const result = { documentId, carrierCollection, idPaquetePago: packageId, REMITENTE: text(data.REMITENTE), TRANSPORTADORA: text(data.TRANSPORTADORA), GUIA: text(data.GUIA),
        FECHA: text(data.FECHA, !packageId), fechaPago: data.fechaPago == null ? null : day(data.fechaPago), momentoParticularPago: millis(data.momentoParticularPago, !packageId),
        RECAUDO: money(data.RECAUDO, !packageId)?.raw ?? null, 'ENVÍO TOTAL': money(data['ENVÍO TOTAL'], !packageId)?.raw ?? null,
        'COMISION HEKA': money(data['COMISION HEKA'], !packageId)?.raw ?? null, 'TOTAL A PAGAR': money(data['TOTAL A PAGAR'], !packageId)?.raw ?? null,
        referencia: text(data.referencia, true, 1000) };
      if (result.RECAUDO !== null && result['ENVÍO TOTAL'] !== null && result['TOTAL A PAGAR'] !== null && money(result['TOTAL A PAGAR']).minor !== money(result.RECAUDO).minor - money(result['ENVÍO TOTAL']).minor) fail('incomplete');
      if (result.FECHA !== null) {
        if (!/^\d{2}-\d{2}-\d{4}$/.test(result.FECHA)) fail('contract_changed');
        const calendar = day(result.FECHA.slice(6) + '-' + result.FECHA.slice(3, 5) + '-' + result.FECHA.slice(0, 2));
        if (result.fechaPago !== null && result.fechaPago !== calendar) fail('incomplete');
      }
      return result;
    };
    let discoveryBytes = 0;
    for (const carrier of carriers) {
      let ref = paidRef(carrier).where('momentoParticularPago', '>=', from).where('momentoParticularPago', '<', until);
      if (typedQuery.tracking) ref = ref.where('GUIA', '==', typedQuery.tracking);
      await pages(ref.orderBy('momentoParticularPago').orderBy(documentOrder), (id, data) => {
        const packageId = text(data.idPaquetePago);
        const value = line(id, data, carrier, packageId);
        if (value.momentoParticularPago < from || value.momentoParticularPago >= until || (typedQuery.tracking && value.GUIA !== typedQuery.tracking)) fail('incomplete');
        const key = `${carrier}/${id}`;
        if (discovered.size >= 10000) fail('limit_exceeded');
        discoveryBytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
        if (discoveryBytes > 10 * 1024 * 1024) fail('limit_exceeded');
        discovered.set(key, value);
        packageIds.add(packageId);
      }, `pagos/${carrier}/pagos`);
    }
    const header = data => {
      if (data.id_user !== account.userId || data.centro_de_costo !== account.centerCost) fail('account_mismatch');
      if (!Array.isArray(data.guiasPagadas)) fail('contract_changed');
      if (data.guiasPagadas.length > 10000) fail('limit_exceeded');
      if (data.cantidad_pagos != null && (!Number.isSafeInteger(data.cantidad_pagos) || data.cantidad_pagos < 0)) fail('contract_changed');
      return { id_user: text(data.id_user), centro_de_costo: text(data.centro_de_costo), guiasPagadas: data.guiasPagadas.map(value => text(value)),
        fecha: timestamp(data.fecha), total_pagado: money(data.total_pagado).raw, comision_heka: money(data.comision_heka).raw,
        cantidad_pagos: data.cantidad_pagos ?? null, timeline: millis(data.timeline, true) };
    };
    const headerSignature = data => JSON.stringify(['id_user', 'centro_de_costo', 'guiasPagadas', 'fecha', 'total_pagado', 'comision_heka', 'cantidad_pagos', 'timeline'].map(key => [key, Object.hasOwn(data, key), key === 'fecha' ? timestamp(data[key]) : data[key]]));
    const packages = [];
    const collectedPaid = new Set();
    for (const idPaquetePago of packageIds) {
      if (idPaquetePago.includes('/')) fail('contract_changed');
      const ref = db.collection('paquetePagos').doc(idPaquetePago);
      const firstDoc = await get(ref);
      if (firstDoc.ref?.path !== `paquetePagos/${idPaquetePago}`) fail('incomplete');
      const firstData = documentData(firstDoc);
      const first = header(firstData);
      const lines = [];
      for (const carrier of carriers) {
        await pages(paidRef(carrier).where('idPaquetePago', '==', idPaquetePago).orderBy(documentOrder), (id, data) => {
          const value = line(id, data, carrier, idPaquetePago);
          const key = `${carrier}/${id}`, earlier = discovered.get(key);
          if (collectedPaid.has(key)) fail('incomplete');
          collectedPaid.add(key);
          if (earlier && JSON.stringify(earlier) !== JSON.stringify(value)) fail('incomplete');
          discovered.delete(key);
          lines.push(budget(value));
        }, `pagos/${carrier}/pagos`);
      }
      const declared = [...first.guiasPagadas].sort();
      if (!lines.length || JSON.stringify(declared) !== JSON.stringify(lines.map(value => value.GUIA).sort())) fail('incomplete');
      const calendar = lines[0].FECHA;
      let net = 0n, commission = 0n, gross = 0n, shipping = 0n;
      for (const value of lines) {
        if (value.FECHA !== calendar) fail('incomplete');
        net += money(value['TOTAL A PAGAR']).minor;
        commission += money(value['COMISION HEKA']).minor;
        gross += money(value.RECAUDO).minor;
        shipping += money(value['ENVÍO TOTAL']).minor;
      }
      if (net !== money(first.total_pagado).minor || commission !== money(first.comision_heka).minor) fail('incomplete');
      if ([gross, shipping].some(value => value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER))) fail('incomplete');
      const lastDoc = await get(ref);
      if (lastDoc.ref?.path !== `paquetePagos/${idPaquetePago}`) fail('incomplete');
      const afterData = documentData(lastDoc);
      const after = header(afterData);
      if (headerSignature(firstData) !== headerSignature(afterData)) fail('incomplete');
      budget(first, false); budget(after, false);
      packages.push({ idPaquetePago, header: first, headerAfter: after, lines });
    }
    if (discovered.size) fail('incomplete');
    const pending = { cutoff: new Date(cutoff).toISOString(), lines: [] };
    await pages(db.collection('pendientePorPagar').where('REMITENTE', '==', account.centerCost).orderBy('timeline').orderBy(documentOrder).endAt(cutoff), (id, data) => {
      if (millis(data.timeline) > cutoff) fail('incomplete');
      const value = line(id, data, data.TRANSPORTADORA);
      if (collectedPaid.has(`${value.carrierCollection}/${id}`)) fail('incomplete');
      pending.lines.push(budget(value));
    }, 'pendientePorPagar');
    const finalAccount = check();
    if (finalAccount.userId !== initialAccount.userId || finalAccount.centerCost !== initialAccount.centerCost) fail('account_mismatch');
    const value = { schemaVersion: 1, adapterVersion: 'heka-classic-v1', query: typedQuery, account: initialAccount, capturedAt: new Date().toISOString(), source: 'server', complete: true, guides, packages, pending };
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 10 * 1024 * 1024) fail('limit_exceeded');
    return { ok: true, value };
  } catch (error) {
    let code = codes.includes(error?.code) ? error.code : 'provider_error';
    if (['permission-denied', 'unauthenticated', 'auth/user-token-expired', 'auth/requires-recent-login'].includes(error?.code)) code = 'login_required';
    if (error?.code === 'failed-precondition' || error instanceof TypeError) code = 'contract_changed';
    return { ok: false, code };
  } finally {
    reads.delete(token);
    if (!reads.size) delete globalThis.__selleneitorHekaReads;
  }
}

function cancelClassicRead(token) {
  if (globalThis.__selleneitorHekaReads?.has(token)) globalThis.__selleneitorHekaReads.set(token, true);
}

async function execute(webContents, options) {
  const { signal } = options;
  const deadline = options.deadline instanceof Date ? options.deadline.getTime() : options.deadline ?? Date.now() + 300000;
  if (!Number.isFinite(deadline) || signal?.aborted || Date.now() >= deadline) throw failure('timeout');
  const token = randomUUID();
  const args = { ...options, signal: undefined, deadline, token };
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      try {
        void webContents.executeJavaScript(`(${cancelClassicRead.toString()})(${JSON.stringify(token)})`).catch(() => {});
      } catch {
        // Main may already have destroyed the timed-out provider window.
      }
      reject(failure('timeout'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const result = await Promise.race([webContents.executeJavaScript(`(${readClassicPage.toString()})(${JSON.stringify(args)})`), aborted]);
    if (!result?.ok) throw failure(ERROR_CODES.has(result?.code) ? result.code : 'provider_error');
    return result.value;
  } catch (error) {
    throw failure(ERROR_CODES.has(error?.code) ? error.code : 'provider_error');
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function getHekaIdentity(webContents) {
  return execute(webContents, { operation: 'identity' });
}

export function captureHeka(webContents, { query, account, signal, deadline }) {
  return execute(webContents, { operation: 'capture', query, account, signal, deadline });
}
