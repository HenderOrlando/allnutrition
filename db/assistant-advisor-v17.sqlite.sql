-- Personal advisor state is not part of commercial backups.
CREATE TABLE assistant_advisor_tasks (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  due_at TEXT,
  initial_digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK(typeof(data)='text' AND length(CAST(data AS BLOB))<=16384 AND json_valid(data) AND json_type(data)='object'),
  PRIMARY KEY(user_id,id)
);
CREATE INDEX assistant_advisor_tasks_user_status ON assistant_advisor_tasks(user_id,status);
CREATE INDEX assistant_advisor_tasks_user_due ON assistant_advisor_tasks(user_id,due_at) WHERE due_at IS NOT NULL;

CREATE TABLE assistant_advisor_notice_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  seen_fingerprint TEXT,
  snoozed_until TEXT,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483647),
  PRIMARY KEY(user_id,source_key)
);

CREATE TABLE assistant_advisor_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(typeof(version)='integer' AND version BETWEEN 1 AND 2147483647),
  focus_area TEXT CHECK(focus_area IN ('home','orders','products','cash','reports','advertising','business')),
  detail TEXT NOT NULL CHECK(detail IN ('brief','guided')),
  show_announcements INTEGER NOT NULL CHECK(show_announcements IN (0,1))
);
