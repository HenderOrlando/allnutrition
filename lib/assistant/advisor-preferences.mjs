import { adminAreas } from '../admin-view.mjs';
import { fail } from '../validation-core.mjs';
import { assertAssistantSession } from './settings.mjs';

const DEFAULTS = Object.freeze({ version: 0, focusArea: null, detail: 'guided', showAnnouncements: true });
const FIELDS = Object.keys(DEFAULTS);
const AREA_IDS = new Set(adminAreas.map(({ id }) => id));
const MAX_VERSION = 2147483647;

export async function readAdvisorPreferencesTx(tx, userId) {
  const row = await tx.db.get(`SELECT version,focus_area,detail,show_announcements
    FROM ${tx.t('assistant_advisor_preferences')} WHERE user_id=?`, [userId]);
  return row ? {
    version: row.version, focusArea: row.focus_area, detail: row.detail,
    showAnnouncements: row.show_announcements === 1,
  } : DEFAULTS;
}

export async function readAdvisorPreferences(store, session) {
  return store.readSnapshot(async tx => {
    const { userId } = await assertAssistantSession(tx, session);
    return readAdvisorPreferencesTx(tx, userId);
  });
}

export async function writeAdvisorPreferences(store, session, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !FIELDS.includes(key))
    || FIELDS.some(key => !Object.hasOwn(input, key))) fail('Envía solo los cuatro campos de preferencias.', 422);
  const { version, focusArea, detail, showAnnouncements } = input;
  if (!Number.isInteger(version) || version < 0 || version > MAX_VERSION
    || focusArea !== null && !AREA_IDS.has(focusArea)
    || detail !== 'brief' && detail !== 'guided'
    || typeof showAnnouncements !== 'boolean') fail('Revisa los valores de tus preferencias.', 422);

  return store.transaction(async tx => {
    const { userId } = await assertAssistantSession(tx, session, { lock: true });
    const table = tx.t('assistant_advisor_preferences');
    const announcement = Number(showAnnouncements);
    const result = version === 0
      ? await tx.db.run(`INSERT INTO ${table} (user_id,version,focus_area,detail,show_announcements)
          VALUES (?,1,?,?,?) ON CONFLICT(user_id) DO NOTHING`, [userId, focusArea, detail, announcement])
      : await tx.db.run(`UPDATE ${table} SET version=version+1,focus_area=?,detail=?,show_announcements=?
          WHERE user_id=? AND version=? AND version<?`, [focusArea, detail, announcement, userId, version, MAX_VERSION]);
    if (result.changes !== 1) {
      const current = await readAdvisorPreferencesTx(tx, userId);
      if (current.version === version) fail('No se puede avanzar la versión de tus preferencias.', 422);
      throw Object.assign(new Error('Tus preferencias cambiaron en otra sesión. Revisa lo guardado antes de volver a guardar.'), {
        status: 409, code: 'ASSISTANT_CONFLICT', current,
      });
    }
    return { version: version + 1, focusArea, detail, showAnnouncements };
  });
}
