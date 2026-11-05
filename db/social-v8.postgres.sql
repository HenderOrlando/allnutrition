-- Social v8 is applied atomically by migrateSocialV8.

CREATE TABLE allnutrition.social_connections (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL CHECK(provider='meta'),
  integration_method TEXT NOT NULL CHECK(integration_method IN ('api','browser')),
  state TEXT NOT NULL CHECK(state IN ('connected','reconnect_required','disconnected','login_required','login_in_progress','challenge_required','layout_changed')),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE allnutrition.social_credentials (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES allnutrition.social_connections(id) ON DELETE RESTRICT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>=1),
  updated_at TEXT NOT NULL
);

CREATE TABLE allnutrition.social_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL,
  csrf_hash TEXT NOT NULL,
  connection_id TEXT REFERENCES allnutrition.social_connections(id) ON DELETE RESTRICT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE allnutrition.social_browser_controls (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES allnutrition.social_connections(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  session_binding TEXT NOT NULL,
  lease_key TEXT NOT NULL,
  lease_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','completed','cancelled','expired')),
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE allnutrition.social_assets (
  id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','processing','ready','failed','archived','missing_file')),
  sha256 TEXT,
  bytes BIGINT NOT NULL CHECK(bytes BETWEEN 0 AND 9007199254740991),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE allnutrition.social_campaigns (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT REFERENCES allnutrition.social_connections(id) ON DELETE RESTRICT,
  asset_id TEXT REFERENCES allnutrition.social_assets(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  mode TEXT NOT NULL CHECK(mode IN ('organic','paid')),
  objective TEXT NOT NULL CHECK(objective IN ('whatsapp','traffic','reach','engagement')),
  state TEXT NOT NULL CHECK(state IN ('draft','ready','scheduled','publishing','partial','published','in_review','active','paused','completed','failed','needs_attention','cancelled')),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(CASE WHEN data::jsonb->>'budgetMinor' IS NULL THEN TRUE WHEN jsonb_typeof(data::jsonb->'budgetMinor')='number' THEN (data::jsonb->>'budgetMinor')::numeric BETWEEN 0 AND 9007199254740991 AND trunc((data::jsonb->>'budgetMinor')::numeric)=(data::jsonb->>'budgetMinor')::numeric ELSE FALSE END),
  CHECK(state='draft' OR (connection_id IS NOT NULL AND asset_id IS NOT NULL))
);

CREATE TABLE allnutrition.social_revisions (
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  spec_hash TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  PRIMARY KEY(campaign_id,revision)
);

CREATE TABLE allnutrition.social_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('facebook','instagram','meta_ads')),
  state TEXT NOT NULL CHECK(state IN ('queued','preparing','ready','scheduled','publishing','published','in_review','active','paused','completed','failed','uncertain','blocked','cancelled')),
  remote_id TEXT,
  next_sync_at TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id,revision,channel),
  UNIQUE(id,campaign_id),
  FOREIGN KEY(campaign_id,revision) REFERENCES allnutrition.social_revisions(campaign_id,revision) ON DELETE RESTRICT
);

CREATE TABLE allnutrition.social_operations (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  delivery_id TEXT REFERENCES allnutrition.social_deliveries(id) ON DELETE RESTRICT,
  operation_key TEXT NOT NULL UNIQUE,
  step TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','sent','confirmed','retry_wait','uncertain','failed')),
  next_attempt_at TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(delivery_id,step),
  FOREIGN KEY(delivery_id,campaign_id) REFERENCES allnutrition.social_deliveries(id,campaign_id) ON DELETE RESTRICT
);

CREATE TABLE allnutrition.social_measurements (
  id TEXT PRIMARY KEY NOT NULL,
  delivery_id TEXT NOT NULL REFERENCES allnutrition.social_deliveries(id) ON DELETE RESTRICT,
  query_key TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL)
);

CREATE TABLE allnutrition.social_forecasts (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  spec_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL)
);

CREATE TABLE allnutrition.social_recommendations (
  id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  evidence_hash TEXT NOT NULL,
  rule_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('suggested','applied','dismissed','evaluated')),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id,evidence_hash,rule_key)
);

CREATE TABLE allnutrition.social_order_links (
  order_id TEXT PRIMARY KEY NOT NULL REFERENCES allnutrition.orders(id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE allnutrition.social_expense_links (
  expense_id TEXT PRIMARY KEY NOT NULL REFERENCES allnutrition.expenses(id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 500),
  data TEXT NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(data::jsonb) IS NOT NULL),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX social_campaigns_state_updated ON allnutrition.social_campaigns(state,updated_at);

CREATE INDEX social_deliveries_campaign_state ON allnutrition.social_deliveries(campaign_id,state);

CREATE INDEX social_deliveries_sync ON allnutrition.social_deliveries(state,next_sync_at);

CREATE INDEX social_operations_pending ON allnutrition.social_operations(state,next_attempt_at);

CREATE INDEX social_measurements_query ON allnutrition.social_measurements(delivery_id,query_key,fetched_at);

CREATE INDEX social_order_links_campaign ON allnutrition.social_order_links(campaign_id);

CREATE INDEX social_expense_links_campaign ON allnutrition.social_expense_links(campaign_id);

CREATE FUNCTION allnutrition.social_connection_method_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.integration_method IS DISTINCT FROM OLD.integration_method THEN RAISE EXCEPTION 'integration_method is immutable' USING ERRCODE='23514'; END IF; RETURN NEW; END; $$;
CREATE TRIGGER social_connections_method_immutable BEFORE UPDATE OF integration_method ON allnutrition.social_connections FOR EACH ROW EXECUTE FUNCTION allnutrition.social_connection_method_guard();
