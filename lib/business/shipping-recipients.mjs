import { fail, integer, text } from '../validation-core.mjs';
import { RECIPIENT_FIELDS, recipientValues, shippingObject } from '../shipping/center-values.mjs';
import { audit, insertRow, newId, stamp, updateVersioned } from './commands.mjs';

const PAGE_SIZE = 20;
const SOURCES = { order: 'orders', saved: 'shipping_recipients' };
const KEYS = RECIPIENT_FIELDS.map(([key]) => key);
// Preserve mailbox and ID identifiers verbatim; do not infer equivalent accounts or documents.
const EXACT = new Set(['email', 'documentNumber']);
const publicId = (source, id) => `${source === 'saved' ? 's' : 'o'}_${Buffer.from(id, 'utf8').toString('base64url')}`;
const phoneKey = value => value.replace(/[ ()-]/g, '');

function recipientId(value) {
  if (typeof value !== 'string' || !/^[so]_[A-Za-z0-9_-]{1,540}$/.test(value)) fail('Destinatario no encontrado.', 404);
  const source = value[0] === 's' ? 'saved' : 'order';
  const id = Buffer.from(value.slice(2), 'base64url').toString('utf8');
  if (!id || id.length > 100 || id.trim() !== id || /[\u0000-\u001f]/.test(id) || publicId(source, id) !== value) fail('Destinatario no encontrado.', 404);
  return { source, id };
}

function detail(row, source) {
  const data = JSON.parse(row.data);
  // An order can have old or incomplete contact data. Return only the recorded fields;
  // the preparation/editor validates them before saving or using them to issue a guide.
  const recipient = Object.fromEntries(KEYS.map(key => [key, typeof data[key] === 'string' ? data[key].trim() : '']));
  return { id: publicId(source, row.id), source, ...(source === 'saved' ? { version: Number(row.version) } : {}), recipient };
}

export async function pageShippingRecipients(store, input = {}) {
  shippingObject(input, ['page', 'query', 'source'], 'Agenda');
  const page = integer(input.page ?? 1, 'Página', 1, 100_000);
  const query = text(input.query, 'Búsqueda', 100);
  if (query.includes('\0')) fail('Búsqueda no válida.');
  const source = input.source;
  if (source != null && (typeof source !== 'string' || !Object.hasOwn(SOURCES, source))) fail('Origen de destinatario no válido.');

  const sqlite = store.provider === 'sqlite';
  const binary = sqlite ? 'COLLATE BINARY' : 'COLLATE "C"';
  const fold = value => sqlite ? `offer_casefold(${value})` : `LOWER(TRANSLATE(${value},'ÁÉÍÓÚÜÑ','áéíóúüñ'))`;
  const position = (field, term) => `${sqlite ? 'INSTR' : 'STRPOS'}(${field}, ${term}) > 0`;
  const value = key => `TRIM(COALESCE(${sqlite ? `CAST(json_extract(data,'$.${key}') AS TEXT)` : `(data::jsonb->>'${key}')`},''))`;
  const field = key => `field_${key}`;
  const normalized = key => `normalized_${key}`;
  const phone = expression => [' ', '(', ')', '-'].reduce((sql, char) => `REPLACE(${sql},'${char}','')`, expression);
  const normalize = key => key === 'phone' ? phone(field(key)) : EXACT.has(key) ? field(key) : fold(field(key));
  const columns = KEYS.map(key => `${value(key)} AS ${field(key)}`).join(', ');
  const identity = KEYS.map(key => `${normalize(key)} ${binary} AS ${normalized(key)}`).join(', ');
  const partition = KEYS.map(key => `${normalized(key)} ${binary}`).join(', ');
  const sort = `updated_at DESC, source_priority, local_id ${binary}`;
  const conditions = ['recipient_rank = 1'];
  const params = [];
  let search = '';
  if (query) {
    search = ', search AS (SELECT ' + fold('CAST(? AS TEXT)') + ' AS term, CAST(? AS TEXT) AS phone_term)';
    params.push(query, /^\+?[0-9 ()-]+$/.test(query) ? phoneKey(query) : '');
    const fields = KEYS.map(key => key === 'phone'
      ? `(search.phone_term <> '' AND ${position(normalized(key), 'search.phone_term')})`
      : position(EXACT.has(key) ? fold(normalized(key)) : normalized(key), 'search.term'));
    conditions.push(`(${fields.join(' OR ')})`);
  }
  if (source != null) { conditions.push('source = ?'); params.push(source); }
  params.push((page - 1) * PAGE_SIZE);
  const phoneEnding = sqlite ? 'SUBSTR(normalized_phone,-4)' : 'RIGHT(normalized_phone,4)';

  // Pick the canonical entry before applying filters so the same contact keeps
  // its ID and displayed origin while navigating the directory.
  const rows = await store.db.all(`WITH candidates AS (
    SELECT id AS local_id, updated_at, 'saved' AS source, 0 AS source_priority, ${columns} FROM ${store.t(SOURCES.saved)}
    UNION ALL
    SELECT id AS local_id, updated_at, 'order' AS source, 1 AS source_priority, ${columns} FROM ${store.t(SOURCES.order)}
  ), normalized AS (
    SELECT candidates.*, ${identity} FROM candidates WHERE field_customerName <> ''
  ), ranked AS (
    SELECT normalized.*, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY source_priority, updated_at DESC, local_id ${binary}) AS recipient_rank
    FROM normalized
  )${search}, matching AS (
    SELECT local_id, updated_at, source, source_priority, field_customerName AS name, field_city AS city, field_department AS department,
      SUBSTR(field_address,1,73) AS address, SUBSTR(field_addressNotes,1,33) AS address_notes, ${phoneEnding} AS phone_ending
    FROM ranked${query ? ' CROSS JOIN search' : ''} WHERE ${conditions.join(' AND ')}
  ), paged AS (
    SELECT * FROM matching ORDER BY ${sort} LIMIT ${PAGE_SIZE} OFFSET ?
  ) SELECT totals.total, paged.* FROM (SELECT COUNT(*) AS total FROM matching) totals
    LEFT JOIN paged ON 1=1 ORDER BY ${sort}`, params);
  const shorten = (value, max) => {
    if (value.length <= max) return value;
    const chars = Array.from(value);
    return chars.length > max ? `${chars.slice(0, max).join('')}…` : value;
  };
  return { page, pageSize: PAGE_SIZE, total: Number(rows[0].total), records: rows.filter(row => row.local_id != null).map(row => ({
    id: publicId(row.source, row.local_id), source: row.source, name: row.name, city: row.city, department: row.department,
    address: shorten(row.address, 72), addressNotes: shorten(row.address_notes, 32),
    phoneEnding: /^\d{1,4}$/.test(row.phone_ending) ? row.phone_ending : '',
  })) };
}

export async function getShippingRecipient(store, value) {
  const { source, id } = recipientId(value);
  const row = await store.db.get(`SELECT id, version, data FROM ${store.t(SOURCES[source])} WHERE id=?`, [id]);
  if (!row) fail('Destinatario no encontrado.', 404);
  return detail(row, source);
}

export async function saveShippingRecipient(store, input, actorId, value = null) {
  shippingObject(input, value == null ? ['recipient'] : ['recipient', 'version'], 'Ficha de destinatario');
  const recipient = recipientValues(input.recipient, { complete: true });
  if (KEYS.some(key => recipient[key].includes('\0'))) fail('Ficha de destinatario no válida.');
  const data = JSON.stringify(recipient);
  return store.transaction(async tx => {
    const table = SOURCES.saved;
    if (value != null) {
      const { source, id } = recipientId(value);
      if (source !== 'saved') fail('Solo puedes editar fichas guardadas en Envíos.', 404);
      const version = integer(input.version, 'Versión', 1);
      if (!await tx.db.get(`SELECT id FROM ${tx.t(table)} WHERE id=?`, [id])) fail('Destinatario no encontrado.', 404);
      await updateVersioned(tx, table, id, version, { data });
      await audit(tx, { entityType: 'shipping_recipient', entityId: id, actorId, previous: { version }, next: { version: version + 1 } });
      return { id: value, source, version: version + 1, recipient };
    }
    const id = newId(), version = 1, now = stamp();
    await insertRow(tx, table, { id, version, data, created_at: now, updated_at: now });
    await audit(tx, { entityType: 'shipping_recipient', entityId: id, actorId, next: { version } });
    return { id: publicId('saved', id), source: 'saved', version, recipient };
  });
}
