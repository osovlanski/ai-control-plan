-- Agent Runtime Registry PR 3 (docs/contracts/agent-runtime-v1.md): the operator disable overlay
-- and version-bound conformance storage.
--
-- `operator_state` is the operator's overlay on top of config `enabled`. It can only REMOVE
-- eligibility: NULL means "no operator opinion" (config decides), 'disabled' excludes the
-- assistant from routing whatever config says. There is deliberately no 'enabled' value, so the
-- overlay can never turn on what config turns off. Registry.init() upserts only provider and
-- enabled, so the overlay survives restarts and re-seeding from config.
ALTER TABLE assistants ADD COLUMN operator_state TEXT CHECK (operator_state IS NULL OR operator_state IN ('disabled'));
ALTER TABLE assistants ADD COLUMN operator_state_at TEXT;

-- One row per (assistant, CLI version, descriptor version). A new CLI version or descriptor
-- version has no row, so earlier evidence never vouches for it (fail closed). Written by the
-- conformance probe (PR 4); nothing writes it yet. `checks` holds check names, booleans and
-- classified reasons only: never stdout, stderr or a provider transcript.
CREATE TABLE runtime_conformance (
  assistant_id       TEXT NOT NULL REFERENCES assistants(id),
  cli_version        TEXT NOT NULL,
  descriptor_version INTEGER NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('pass','fail')),
  checks             TEXT NOT NULL,
  checked_at         TEXT NOT NULL,
  PRIMARY KEY (assistant_id, cli_version, descriptor_version)
);
