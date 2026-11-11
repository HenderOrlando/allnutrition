-- Private conversational assistant state; never part of a commercial backup.

CREATE TABLE allnutrition.assistant_settings (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  api_key_ciphertext TEXT,
  api_key_iv TEXT,
  api_key_tag TEXT,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((api_key_ciphertext IS NULL AND api_key_iv IS NULL AND api_key_tag IS NULL) OR
        (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL AND api_key_tag IS NOT NULL))
);

CREATE TABLE allnutrition.assistant_threads (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(id,user_id)
);

CREATE TABLE allnutrition.assistant_turns (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  configuration_version INTEGER NOT NULL CHECK(configuration_version BETWEEN 0 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('running','completed','failed','cancelled')),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  deadline_at TEXT NOT NULL,
  UNIQUE(user_id,request_id),
  UNIQUE(id,thread_id,user_id),
  FOREIGN KEY(thread_id,user_id) REFERENCES allnutrition.assistant_threads(id,user_id) ON DELETE CASCADE
);

CREATE TABLE allnutrition.assistant_proposals (
  id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  configuration_version INTEGER NOT NULL CHECK(configuration_version BETWEEN 0 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('prepared','applied','executed','cancelled','stale')),
  data TEXT NOT NULL CHECK(jsonb_typeof(data::jsonb)='object'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(turn_id),
  FOREIGN KEY(thread_id,user_id) REFERENCES allnutrition.assistant_threads(id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(turn_id,thread_id,user_id) REFERENCES allnutrition.assistant_turns(id,thread_id,user_id) ON DELETE CASCADE
);

CREATE INDEX assistant_threads_owner_updated ON allnutrition.assistant_threads(user_id,updated_at,id);
CREATE UNIQUE INDEX assistant_turns_one_running_per_thread ON allnutrition.assistant_turns(thread_id) WHERE state='running';
CREATE INDEX assistant_turns_owner_history ON allnutrition.assistant_turns(user_id,thread_id,started_at,id);
CREATE INDEX assistant_proposals_thread_state ON allnutrition.assistant_proposals(thread_id,state);
