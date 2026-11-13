-- OAuth transactions and model credentials are private, never commercial backup data.
CREATE TABLE allnutrition.assistant_oauth_states (
  state_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  session_token_hash TEXT NOT NULL REFERENCES allnutrition.sessions(token_hash) ON DELETE CASCADE,
  configuration_version INTEGER NOT NULL CHECK(configuration_version BETWEEN 0 AND 2147483647),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id,session_token_hash)
);
CREATE INDEX assistant_oauth_states_expiry ON allnutrition.assistant_oauth_states(expires_at);

CREATE TABLE allnutrition.assistant_oauth_credentials (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
