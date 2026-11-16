-- Private generation and account-analysis work; never part of a commercial export.
CREATE TABLE allnutrition.social_generation_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  actor_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(length(state) BETWEEN 1 AND 40),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object' AND octet_length(data)<=2097152),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX social_generation_jobs_actor_created ON allnutrition.social_generation_jobs(actor_id,created_at,id);

CREATE TABLE allnutrition.social_account_analyses (
  id TEXT PRIMARY KEY NOT NULL,
  connection_id TEXT NOT NULL REFERENCES allnutrition.social_connections(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(length(state) BETWEEN 1 AND 40),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object' AND octet_length(data)<=2097152),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX social_account_analyses_connection_created ON allnutrition.social_account_analyses(connection_id,created_at,id);

CREATE TABLE allnutrition.social_account_analysis_items (
  id TEXT PRIMARY KEY NOT NULL,
  analysis_id TEXT NOT NULL REFERENCES allnutrition.social_account_analyses(id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK(length(resource_kind) BETWEEN 1 AND 80),
  resource_id TEXT NOT NULL CHECK(length(resource_id) BETWEEN 1 AND 200),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object' AND octet_length(data)<=1048576),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(analysis_id,resource_kind,resource_id)
);
CREATE INDEX social_account_analysis_items_analysis_id ON allnutrition.social_account_analysis_items(analysis_id,id);
