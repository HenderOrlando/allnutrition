-- Ejecutar con npm run db:migrate o el SQL Editor de Supabase.
-- Esquema privado: NO añadir allnutrition a los esquemas expuestos por la Data API.
-- No usa Supabase Auth ni Storage; acceso exclusivo por el backend de Next.js.
BEGIN;
CREATE SCHEMA IF NOT EXISTS allnutrition;
REVOKE ALL ON SCHEMA allnutrition FROM PUBLIC;
CREATE TABLE IF NOT EXISTS allnutrition.migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allnutrition.records(id TEXT PRIMARY KEY,kind TEXT NOT NULL,slug TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,sort_order INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(kind,slug));
CREATE INDEX IF NOT EXISTS records_kind_status ON allnutrition.records(kind,status,sort_order);
CREATE TABLE IF NOT EXISTS allnutrition.settings(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS allnutrition.users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS allnutrition.sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,csrf TEXT NOT NULL,expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS allnutrition.attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS allnutrition.orders(id TEXT PRIMARY KEY,number INTEGER NOT NULL UNIQUE,data TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS allnutrition.order_events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES allnutrition.orders(id),actor_id TEXT NOT NULL,previous_status TEXT,next_status TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_order ON allnutrition.order_events(order_id,created_at);
CREATE TABLE IF NOT EXISTS allnutrition.order_audit(id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES allnutrition.orders(id),actor_id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS audit_order ON allnutrition.order_audit(order_id,created_at);
CREATE TABLE IF NOT EXISTS allnutrition.counters(id TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT INTO allnutrition.counters VALUES('orders',0) ON CONFLICT(id) DO NOTHING;
UPDATE allnutrition.counters SET value=GREATEST(value,(SELECT COALESCE(MAX(number),0) FROM allnutrition.orders)) WHERE id='orders';
CREATE TABLE IF NOT EXISTS allnutrition.idempotency(key TEXT PRIMARY KEY,actor_id TEXT NOT NULL,payload_hash TEXT NOT NULL,order_id TEXT NOT NULL REFERENCES allnutrition.orders(id));
CREATE INDEX IF NOT EXISTS orders_status ON allnutrition.orders((data::jsonb->>'status'));
CREATE INDEX IF NOT EXISTS sessions_expiry ON allnutrition.sessions(expires);
INSERT INTO allnutrition.migrations VALUES(2,CURRENT_TIMESTAMP::text) ON CONFLICT(version) DO NOTHING;
REVOKE ALL ON ALL TABLES IN SCHEMA allnutrition FROM PUBLIC;
-- También revocar roles de la Data API cuando existen (Supabase).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON SCHEMA allnutrition FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA allnutrition FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON SCHEMA allnutrition FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA allnutrition FROM authenticated;
  END IF;
END $$;
COMMIT;
