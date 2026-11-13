-- Recoverable assistant work is private and excluded from commercial backups.
CREATE TABLE assistant_workspaces (
  turn_id TEXT PRIMARY KEY NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483647),
  mode TEXT NOT NULL CHECK(mode IN ('quick','extended')),
  phase TEXT NOT NULL CHECK(phase IN ('planning','reading','analyzing','answering','done')),
  source_turn_id TEXT,
  lease_token TEXT,
  lease_until TEXT,
  active_request_id TEXT,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB))<=32768),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(turn_id,thread_id,user_id),
  CHECK(source_turn_id IS NULL OR source_turn_id<>turn_id),
  CHECK((lease_token IS NULL AND lease_until IS NULL) OR (lease_token IS NOT NULL AND lease_until IS NOT NULL AND active_request_id IS NOT NULL)),
  FOREIGN KEY(turn_id,thread_id,user_id) REFERENCES assistant_turns(id,thread_id,user_id) ON DELETE CASCADE,
  FOREIGN KEY(source_turn_id,thread_id,user_id) REFERENCES assistant_turns(id,thread_id,user_id) ON DELETE CASCADE
);

CREATE TABLE assistant_work_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  turn_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(typeof(sequence)='integer' AND sequence>=0),
  kind TEXT NOT NULL CHECK(kind IN ('input','read','guide','analysis')),
  query_hash TEXT,
  data TEXT NOT NULL CHECK(json_valid(data) AND json_type(data)='object' AND length(CAST(data AS BLOB))<=CASE WHEN kind='input' THEN 65536 ELSE 49152 END),
  created_at TEXT NOT NULL,
  UNIQUE(turn_id,sequence),
  FOREIGN KEY(turn_id,thread_id,user_id) REFERENCES assistant_workspaces(turn_id,thread_id,user_id) ON DELETE CASCADE
);
CREATE INDEX assistant_work_chunks_query ON assistant_work_chunks(turn_id,kind,query_hash);
