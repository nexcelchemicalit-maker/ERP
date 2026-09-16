-- Nexcel ERP — Phase 4: Production (D1 / SQLite)
-- Work orders instantiate an approved formula as a batch (BMR): dispense released
-- lots, run steps (incl. IPC), book outputs with lot genealogy, roll up actual cost.

CREATE TABLE equipment (
  id              TEXT PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  equip_type      TEXT,
  capacity_qty    REAL,
  capacity_uom_id TEXT REFERENCES uom(id),
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','running','maintenance','down'))
);

CREATE TABLE work_order (
  id              TEXT PRIMARY KEY,
  formula_id      TEXT NOT NULL REFERENCES formula(id),
  product_item_id TEXT NOT NULL REFERENCES item(id),
  planned_qty     REAL NOT NULL,
  uom_id          TEXT NOT NULL REFERENCES uom(id),
  scale_factor    REAL NOT NULL,
  equipment_id    TEXT REFERENCES equipment(id),
  status          TEXT NOT NULL DEFAULT 'planned'
                    CHECK (status IN ('planned','released','in_progress','completed','closed','cancelled')),
  planned_start   TEXT,
  planned_end     TEXT,
  mps_order_ref   TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE batch (
  id            TEXT PRIMARY KEY,
  work_order_id TEXT NOT NULL REFERENCES work_order(id),
  batch_no      TEXT NOT NULL UNIQUE,
  actual_qty    REAL,
  uom_id        TEXT REFERENCES uom(id),
  status        TEXT NOT NULL DEFAULT 'in_progress'
                  CHECK (status IN ('planned','in_progress','on_hold','completed','rejected','closed')),
  started_at    TEXT,
  completed_at  TEXT,
  reviewed_by   TEXT REFERENCES app_user(id),
  closed_at     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE batch_step (
  id                TEXT PRIMARY KEY,
  batch_id          TEXT NOT NULL REFERENCES batch(id),
  formula_step_id   TEXT REFERENCES formula_step(id),
  step_no           INTEGER NOT NULL,
  instruction       TEXT NOT NULL,
  actual_param_value TEXT,
  is_ipc_checkpoint INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','deviation')),
  performed_by      TEXT REFERENCES app_user(id),
  performed_at      TEXT,
  ipc_sample_id     TEXT REFERENCES sample(id)
);

CREATE TABLE batch_material (
  id           TEXT PRIMARY KEY,
  batch_id     TEXT NOT NULL REFERENCES batch(id),
  item_id      TEXT NOT NULL REFERENCES item(id),
  planned_qty  REAL NOT NULL,
  actual_qty   REAL,
  uom_id       TEXT NOT NULL REFERENCES uom(id),
  lot_id       TEXT REFERENCES lot(id),
  is_substitute INTEGER NOT NULL DEFAULT 0,
  dispensed_by TEXT REFERENCES app_user(id),
  dispensed_at TEXT
);

CREATE TABLE batch_output (
  id          TEXT PRIMARY KEY,
  batch_id    TEXT NOT NULL REFERENCES batch(id),
  item_id     TEXT NOT NULL REFERENCES item(id),
  lot_id      TEXT NOT NULL REFERENCES lot(id),
  qty         REAL NOT NULL,
  uom_id      TEXT NOT NULL REFERENCES uom(id),
  output_type TEXT NOT NULL CHECK (output_type IN ('product','co_product','by_product','waste'))
);

CREATE TABLE deviation (
  id            TEXT PRIMARY KEY,
  batch_id      TEXT NOT NULL REFERENCES batch(id),
  batch_step_id TEXT REFERENCES batch_step(id),
  reason_code   TEXT,
  description   TEXT,
  severity      TEXT NOT NULL DEFAULT 'minor' CHECK (severity IN ('minor','major','critical')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','closed')),
  raised_by     TEXT REFERENCES app_user(id),
  resolution    TEXT,
  resolved_by   TEXT REFERENCES app_user(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE batch_cost (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL REFERENCES batch(id),
  material_cost  REAL NOT NULL DEFAULT 0,
  packaging_cost REAL NOT NULL DEFAULT 0,
  labor_cost     REAL NOT NULL DEFAULT 0,
  machine_cost   REAL NOT NULL DEFAULT 0,
  waste_cost     REAL NOT NULL DEFAULT 0,
  actual_total   REAL NOT NULL DEFAULT 0,
  standard_total REAL NOT NULL DEFAULT 0,
  variance       REAL NOT NULL DEFAULT 0
);

CREATE INDEX idx_wo_formula   ON work_order(formula_id);
CREATE INDEX idx_batch_wo     ON batch(work_order_id);
CREATE INDEX idx_bstep_batch  ON batch_step(batch_id);
CREATE INDEX idx_bmat_batch   ON batch_material(batch_id);
CREATE INDEX idx_boutput_batch ON batch_output(batch_id);
