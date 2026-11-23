-- Personal advisor state is not part of commercial backups.
CREATE TABLE allnutrition.assistant_advisor_tasks (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  capability_id TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  due_at TEXT,
  initial_digest TEXT NOT NULL,
  data TEXT NOT NULL CHECK(octet_length(convert_to(data,'UTF8'))<=16384 AND jsonb_typeof(data::jsonb)='object'),
  PRIMARY KEY(user_id,id)
);
CREATE INDEX assistant_advisor_tasks_user_status ON allnutrition.assistant_advisor_tasks(user_id,status);
CREATE INDEX assistant_advisor_tasks_user_due ON allnutrition.assistant_advisor_tasks(user_id,due_at) WHERE due_at IS NOT NULL;

CREATE TABLE allnutrition.assistant_advisor_notice_state (
  user_id TEXT NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  seen_fingerprint TEXT,
  snoozed_until TEXT,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  PRIMARY KEY(user_id,source_key)
);

CREATE TABLE allnutrition.assistant_advisor_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES allnutrition.users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
  focus_area TEXT CHECK(focus_area IN ('home','orders','products','cash','reports','advertising','business')),
  detail TEXT NOT NULL CHECK(detail IN ('brief','guided')),
  show_announcements INTEGER NOT NULL CHECK(show_announcements IN (0,1))
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='allnutrition_app') THEN
    GRANT SELECT,INSERT,UPDATE,DELETE ON allnutrition.assistant_advisor_tasks, allnutrition.assistant_advisor_notice_state, allnutrition.assistant_advisor_preferences TO allnutrition_app;
  END IF;
END $$;
