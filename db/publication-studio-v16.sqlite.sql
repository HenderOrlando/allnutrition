-- Private creative work and audience requests are not commercial backup tables.
CREATE TABLE social_creative_threads (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  campaign_id TEXT REFERENCES social_campaigns(id) ON DELETE SET NULL,
  selected_asset_id TEXT,
  selected_asset_version INTEGER,
  selected_asset_sha256 TEXT,
  attachments_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attachments_json) AND json_type(attachments_json)='array' AND length(CAST(attachments_json AS BLOB))<=65536),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id,request_id),
  UNIQUE(actor_id,campaign_id),
  CHECK((selected_asset_id IS NULL AND selected_asset_version IS NULL AND selected_asset_sha256 IS NULL) OR
    (selected_asset_id IS NOT NULL AND selected_asset_version IS NOT NULL AND selected_asset_version>0 AND selected_asset_sha256 IS NOT NULL AND length(selected_asset_sha256)=64))
);
CREATE INDEX social_creative_threads_actor_updated ON social_creative_threads(actor_id,updated_at,id);
CREATE INDEX social_creative_threads_campaign ON social_creative_threads(campaign_id);
ALTER TABLE social_generation_jobs ADD COLUMN thread_id TEXT REFERENCES social_creative_threads(id) ON DELETE SET NULL;
CREATE INDEX social_generation_jobs_thread_created ON social_generation_jobs(thread_id,created_at,id);

CREATE TABLE social_audience_requests (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES social_campaigns(id) ON DELETE CASCADE,
  campaign_version INTEGER NOT NULL CHECK(campaign_version BETWEEN 1 AND 2147483647),
  settings_version INTEGER NOT NULL CHECK(settings_version BETWEEN 1 AND 2147483647),
  context_hash TEXT NOT NULL CHECK(length(context_hash)=64),
  mode TEXT NOT NULL CHECK(length(mode) BETWEEN 1 AND 40),
  status TEXT NOT NULL CHECK(length(status) BETWEEN 1 AND 40),
  result_json TEXT CHECK(json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=65536),
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(actor_id,request_id)
);
CREATE INDEX social_audience_requests_campaign_actor ON social_audience_requests(campaign_id,actor_id,created_at,id);
