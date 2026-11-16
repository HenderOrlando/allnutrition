-- Private generation and account-analysis work; never part of a commercial export.
CREATE TABLE social_generation_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(length(state) BETWEEN 1 AND 40),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB))<=2097152),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX social_generation_jobs_actor_created ON social_generation_jobs(actor_id,created_at,id);

CREATE TABLE social_account_analyses (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES social_connections(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(length(state) BETWEEN 1 AND 40),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB))<=2097152),
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX social_account_analyses_connection_created ON social_account_analyses(connection_id,created_at,id);

CREATE TABLE social_account_analysis_items (
  id TEXT PRIMARY KEY NOT NULL,
  analysis_id TEXT NOT NULL REFERENCES social_account_analyses(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK(length(resource_kind) BETWEEN 1 AND 80),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 200),
  data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB))<=1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(analysis_id,resource_kind,resource_id)
);
CREATE INDEX social_account_analysis_items_analysis_id ON social_account_analysis_items(analysis_id,id);
