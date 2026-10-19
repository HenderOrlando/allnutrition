-- Children keep referencing import_batches. The migrator checks every FK before
-- clearing SQLite's deferred counters and committing the replacement table.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE import_batches_v5 (
  id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL REFERENCES platform_sources(id) ON DELETE RESTRICT, profile_id TEXT REFERENCES import_profiles(id) ON DELETE RESTRICT,
  file_hash TEXT, filename TEXT, file_bytes_base64 TEXT,
  state TEXT NOT NULL CHECK(state IN ('uploaded','previewing','review','queued','applying','completed','completed_with_errors','failed','expired','cancelled')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT,
  data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)), CHECK(file_bytes_base64 IS NULL OR length(file_bytes_base64)<=13981016),
  FOREIGN KEY(profile_id,source_id) REFERENCES import_profiles(id,source_id) ON DELETE RESTRICT
);
INSERT INTO import_batches_v5(id,source_id,profile_id,file_hash,filename,file_bytes_base64,state,version,created_at,updated_at,expires_at,data)
  SELECT id,source_id,profile_id,file_hash,filename,file_bytes_base64,state,version,created_at,updated_at,expires_at,data FROM import_batches;
DROP TABLE import_batches;
ALTER TABLE import_batches_v5 RENAME TO import_batches;
CREATE INDEX import_batches_state ON import_batches(state,created_at);
