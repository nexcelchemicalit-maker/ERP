-- Nexcel ERP — Phase 2: Quality Control engine (D1 / SQLite)
-- The QC state machine: sample -> results vs spec -> disposition -> lot.qc_status (+ COA).

CREATE TABLE specification (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES item(id),
  version        INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('draft','approved','obsolete')),
  effective_date TEXT,
  approved_by    TEXT REFERENCES app_user(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, version)
);

CREATE TABLE spec_parameter (
  id                 TEXT PRIMARY KEY,
  spec_id            TEXT NOT NULL REFERENCES specification(id),
  sequence           INTEGER NOT NULL DEFAULT 1,
  test_name          TEXT NOT NULL,
  method             TEXT,
  result_type        TEXT NOT NULL DEFAULT 'numeric' CHECK (result_type IN ('numeric','identity','attribute')),
  uom_id             TEXT REFERENCES uom(id),
  lower_limit        REAL,
  upper_limit        REAL,
  target             REAL,
  identity_criterion TEXT
);

CREATE TABLE sample (
  id            TEXT PRIMARY KEY,
  sample_type   TEXT NOT NULL CHECK (sample_type IN ('incoming','in_process','finished')),
  lot_id        TEXT REFERENCES lot(id),
  batch_id      TEXT,
  batch_step_id TEXT,
  spec_id       TEXT NOT NULL REFERENCES specification(id),
  pulled_by     TEXT REFERENCES app_user(id),
  pulled_at     TEXT NOT NULL DEFAULT (datetime('now')),
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','testing','complete','oos','closed'))
);

CREATE TABLE test_result (
  id                TEXT PRIMARY KEY,
  sample_id         TEXT NOT NULL REFERENCES sample(id),
  spec_parameter_id TEXT NOT NULL REFERENCES spec_parameter(id),
  result_value      TEXT,
  pass_fail         TEXT CHECK (pass_fail IN ('pass','fail')),
  is_oos            INTEGER NOT NULL DEFAULT 0,
  is_oot            INTEGER NOT NULL DEFAULT 0,
  tested_by         TEXT REFERENCES app_user(id),
  tested_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sample_id, spec_parameter_id)
);

CREATE TABLE qc_disposition (
  id               TEXT PRIMARY KEY,
  sample_id        TEXT NOT NULL REFERENCES sample(id),
  target_lot_id    TEXT REFERENCES lot(id),
  decision         TEXT NOT NULL CHECK (decision IN ('released','rejected','rework','scrapped','hold')),
  reason_code      TEXT,
  investigation_ref TEXT,
  decided_by       TEXT REFERENCES app_user(id),
  decided_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE coa (
  id        TEXT PRIMARY KEY,
  lot_id    TEXT NOT NULL REFERENCES lot(id),
  sample_id TEXT REFERENCES sample(id),
  coa_no    TEXT NOT NULL UNIQUE,
  conforms  INTEGER NOT NULL DEFAULT 1,
  issued_by TEXT REFERENCES app_user(id),
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  pdf_ref   TEXT
);

CREATE TABLE coa_line (
  id             TEXT PRIMARY KEY,
  coa_id         TEXT NOT NULL REFERENCES coa(id),
  parameter_name TEXT NOT NULL,
  spec_text      TEXT,
  result_value   TEXT,
  conforms       INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_specparam_spec ON spec_parameter(spec_id);
CREATE INDEX idx_sample_lot     ON sample(lot_id);
CREATE INDEX idx_sample_status  ON sample(status);
CREATE INDEX idx_result_sample  ON test_result(sample_id);
CREATE INDEX idx_coa_lot        ON coa(lot_id);
