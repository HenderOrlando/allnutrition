-- Runtime integrations v10 is applied atomically by migrateRuntimeIntegrationsV10.
-- Private integration state never belongs to a commercial backup.

ALTER TABLE allnutrition.social_oauth_states ADD COLUMN configuration_version INTEGER NOT NULL DEFAULT 0 CHECK(configuration_version BETWEEN 0 AND 2147483647);
DELETE FROM allnutrition.social_oauth_states WHERE consumed_at IS NULL;

CREATE TABLE allnutrition.social_integration_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb)='object'),
  app_secret_ciphertext TEXT,
  app_secret_iv TEXT,
  app_secret_tag TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((app_secret_ciphertext IS NULL AND app_secret_iv IS NULL AND app_secret_tag IS NULL) OR
        (app_secret_ciphertext IS NOT NULL AND app_secret_iv IS NOT NULL AND app_secret_tag IS NOT NULL))
);

CREATE TABLE allnutrition.shipping_connections (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL UNIQUE REFERENCES allnutrition.platform_sources(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL DEFAULT 'heka' CHECK(provider='heka'),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version BETWEEN 1 AND 2147483647),
  epoch INTEGER NOT NULL DEFAULT 1 CHECK(epoch BETWEEN 1 AND 2147483647),
  actor_id TEXT NOT NULL,
  candidate_identity TEXT CHECK(candidate_identity IS NULL OR jsonb_typeof(candidate_identity::jsonb)='object'),
  confirmed_identity TEXT CHECK(confirmed_identity IS NULL OR jsonb_typeof(confirmed_identity::jsonb)='object'),
  identity_fingerprint TEXT,
  state TEXT NOT NULL CHECK(state IN ('awaiting_pairing','awaiting_identity','confirmation_required','connected','login_required','revoked')),
  last_seen_at TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb)='object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX shipping_connections_active_identity ON allnutrition.shipping_connections(identity_fingerprint) WHERE identity_fingerprint IS NOT NULL AND state<>'revoked';

CREATE TABLE allnutrition.shipping_pairings (
  hash TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES allnutrition.shipping_connections(id) ON DELETE RESTRICT,
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 2147483647),
  actor_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE allnutrition.shipping_bridge_credentials (
  device_id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES allnutrition.shipping_connections(id) ON DELETE RESTRICT,
  epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 2147483647),
  bearer_hash TEXT NOT NULL UNIQUE,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE allnutrition.shipping_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES allnutrition.shipping_connections(id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL REFERENCES allnutrition.platform_sources(id) ON DELETE RESTRICT,
  query_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK(schema_version BETWEEN 1 AND 2147483647),
  adapter_version TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  captured_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  import_batch_id TEXT REFERENCES allnutrition.import_batches(id) ON DELETE RESTRICT
);

CREATE INDEX shipping_pairings_connection ON allnutrition.shipping_pairings(connection_id,expires_at);
CREATE INDEX shipping_bridge_credentials_connection ON allnutrition.shipping_bridge_credentials(connection_id,epoch);
CREATE INDEX shipping_snapshots_connection ON allnutrition.shipping_snapshots(connection_id,captured_at);
CREATE INDEX shipping_snapshots_expiry ON allnutrition.shipping_snapshots(expires_at);
