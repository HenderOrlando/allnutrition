/** PostgreSQL de Supabase. Sin consultas desde el navegador ni claves NEXT_PUBLIC_. */
export function placeholders(sql) { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); }
export async function openPostgres(config, { migrate = false } = {}) {
  const { default: pg } = await import('pg');
  // TLS explícito y verificado; se quitan opciones URL que sobreescribirían la validación del certificado.
  const connection = new URL(config.url);
  for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connection.searchParams.delete(key);
  const pool = new pg.Pool({
    connectionString: connection.toString(), max: config.max,
    ssl: config.ssl === 'disable' ? false : { rejectUnauthorized: true, ...(config.ca ? { ca: config.ca } : {}) },
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 15000,
    query_timeout: 15000, application_name: 'allnutrition-nextjs'
  });
  pool.on('error', error => console.error('Conexión PostgreSQL inactiva:', error.code || error.name));
  const table = name => `allnutrition."${name}"`;
  function wrap(client) { return {
    provider: 'supabase', table,
    // Sin `name`: no se usan prepared statements nombrados (compatible con transaction pooler).
    async all(sql, params = []) { return (await client.query(placeholders(sql), params)).rows; },
    async get(sql, params = []) { return (await client.query(placeholders(sql), params)).rows[0] || null; },
    async run(sql, params = []) { const r = await client.query(placeholders(sql), params); return { changes: r.rowCount }; },
    async exec(sql) { await client.query(sql); },
    async transaction() { throw new Error('No se admiten transacciones anidadas.'); }
  }; }
  const adapter = {
    ...wrap(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await fn(wrap(client)); await client.query('COMMIT'); return result; }
      catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
      finally { client.release(); }
    },
    async close() { await pool.end(); }
  };
  try {
    if (!migrate) {
      const m = await adapter.get(`SELECT version FROM ${table('migrations')} WHERE version=2`);
      if (!m) throw new Error('Ejecuta npm run db:migrate antes de iniciar la aplicación.');
    }
    return adapter;
  } catch (error) { await pool.end(); throw error; }
}
