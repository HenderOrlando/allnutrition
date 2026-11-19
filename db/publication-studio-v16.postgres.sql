-- Private creative work and audience requests are not commercial backup tables.
CREATE TABLE allnutrition.social_creative_threads (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  campaign_id TEXT REFERENCES allnutrition.social_campaigns(id) ON DELETE SET NULL,
  selected_asset_id TEXT,
  selected_asset_version INTEGER,
  selected_asset_sha256 TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(attachments_json::jsonb)='array' AND octet_length(attachments_json)<=65536),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id,request_id),
  UNIQUE(actor_id,campaign_id),
  CHECK((selected_asset_id IS NULL AND selected_asset_version IS NULL AND selected_asset_sha256 IS NULL) OR
    (selected_asset_id IS NOT NULL AND selected_asset_version IS NOT NULL AND selected_asset_version>0 AND selected_asset_sha256 IS NOT NULL AND length(selected_asset_sha256)=64))
);
CREATE INDEX social_creative_threads_actor_updated ON allnutrition.social_creative_threads(actor_id,updated_at,id);
CREATE INDEX social_creative_threads_campaign ON allnutrition.social_creative_threads(campaign_id);
ALTER TABLE allnutrition.social_generation_jobs ADD COLUMN thread_id TEXT REFERENCES allnutrition.social_creative_threads(id) ON DELETE SET NULL;
CREATE INDEX social_generation_jobs_thread_created ON allnutrition.social_generation_jobs(thread_id,created_at,id);

CREATE TABLE allnutrition.social_audience_requests (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES allnutrition.social_campaigns(id) ON DELETE CASCADE,
  campaign_version INTEGER NOT NULL CHECK(campaign_version BETWEEN 1 AND 2147483647),
  settings_version INTEGER NOT NULL CHECK(settings_version BETWEEN 1 AND 2147483647),
  context_hash TEXT NOT NULL CHECK(length(context_hash)=64),
  mode TEXT NOT NULL CHECK(length(mode) BETWEEN 1 AND 40),
  status TEXT NOT NULL CHECK(length(status) BETWEEN 1 AND 40),
  result_json TEXT CHECK(jsonb_typeof(result_json::jsonb)='object' AND octet_length(result_json)<=65536),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id,request_id)
);
CREATE INDEX social_audience_requests_campaign_actor ON allnutrition.social_audience_requests(campaign_id,actor_id,created_at,id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='allnutrition_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON allnutrition.social_creative_threads, allnutrition.social_audience_requests TO allnutrition_app;
  END IF;
END $$;
