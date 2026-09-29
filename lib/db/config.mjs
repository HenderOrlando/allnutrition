/** Configuración exclusiva del servidor. No importar desde componentes cliente. */
export function databaseConfig(env = process.env) {
  const driver = (env.DB_DRIVER || 'auto').trim();
  if (!['auto', 'supabase', 'sqlite'].includes(driver)) throw new Error('DB_DRIVER debe ser auto, supabase o sqlite.');
  const url = env.SUPABASE_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || '';
  const provider = driver === 'auto' ? (url ? 'supabase' : 'sqlite') : driver;
  if (provider === 'sqlite' && env.VERCEL === '1') throw new Error('SQLite no es persistente en Vercel. Configura DB_DRIVER=supabase y DATABASE_URL.');
  if (provider === 'supabase' && !url) throw new Error('Falta DATABASE_URL o SUPABASE_DATABASE_URL. No se cambia a SQLite por error de configuración.');
  if (provider === 'supabase') {
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('La cadena de conexión PostgreSQL no es válida.'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error('Usa una cadena postgresql://, no la URL de la API de Supabase.');
  }
  const max = Number(env.DB_POOL_MAX || 1);
  if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error('DB_POOL_MAX debe ser un entero de 1 a 10.');
  const ssl = env.DB_SSL || 'verify';
  if (!['verify', 'disable'].includes(ssl)) throw new Error('DB_SSL debe ser verify o disable (solo PostgreSQL local).');
  if (ssl === 'disable' && provider === 'supabase' && !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname)) throw new Error('No desactives TLS para una base remota.');
  return { provider, url, max, ssl, ca: env.DB_CA_CERT?.replaceAll('\\n', '\n'), filename: env.SQLITE_PATH || `${env.DATA_DIR || './data'}/all-nutrition.sqlite` };
}

export function allowedOrigins(env = process.env) {
  const values = [env.APP_URL, ...(env.EXTRA_ALLOWED_ORIGINS || '').split(',')];
  if (env.VERCEL === '1') {
    if (env.VERCEL_URL) values.push(`https://${env.VERCEL_URL}`);
    if (env.VERCEL_BRANCH_URL) values.push(`https://${env.VERCEL_BRANCH_URL}`);
  }
  if (env.NODE_ENV !== 'production') values.push('http://localhost:3000');
  return [...new Set(values.filter(Boolean).map(v => {
    const u = new URL(v.trim());
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('APP_URL/origen no válido.');
    if (env.NODE_ENV === 'production' && u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) throw new Error('El origen de producción debe usar HTTPS.');
    return u.origin;
  }))];
}
