-- Existing rows and references remain unchanged; only the lifecycle grows.
ALTER TABLE allnutrition.import_batches DROP CONSTRAINT import_batches_state_check;
ALTER TABLE allnutrition.import_batches ADD CONSTRAINT import_batches_state_check
  CHECK(state IN ('uploaded','previewing','review','queued','applying','completed','completed_with_errors','failed','expired','cancelled'));
