-- Nexcel ERP — Phase 3: R&D / Formulation (D1 / SQLite)
-- Versioned formulas (Master Batch Record template) that Production instantiates as batches.

CREATE TABLE formula (
  id              TEXT PRIMARY KEY,
  product_item_id TEXT NOT NULL REFERENCES item(id),
  version         INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','obsolete')),
  base_qty        REAL NOT NULL,                 -- reference batch size
  base_uom_id     TEXT NOT NULL REFERENCES uom(id),
  security_level  TEXT NOT NULL DEFAULT 'open' CHECK (security_level IN ('open','restricted','confidential')),
  approved_by     TEXT REFERENCES app_user(id),
  approved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (product_item_id, version)
);

CREATE TABLE formula_ingredient (
  id               TEXT PRIMARY KEY,
  formula_id       TEXT NOT NULL REFERENCES formula(id),
  item_id          TEXT NOT NULL REFERENCES item(id),
  sequence         INTEGER NOT NULL DEFAULT 1,     -- charge order
  qty              REAL NOT NULL,                  -- at base_qty scale
  uom_id           TEXT NOT NULL REFERENCES uom(id),
  percentage       REAL,
  substitute_group TEXT,
  is_optional      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE formula_step (
  id                   TEXT PRIMARY KEY,
  formula_id           TEXT NOT NULL REFERENCES formula(id),
  step_no              INTEGER NOT NULL,
  instruction          TEXT NOT NULL,
  param_type           TEXT CHECK (param_type IN ('temp','pressure','ph','time','mix_speed','other')),
  target               REAL,
  tolerance_low        REAL,
  tolerance_high       REAL,
  is_ipc_checkpoint    INTEGER NOT NULL DEFAULT 0,
  ipc_spec_parameter_id TEXT REFERENCES spec_parameter(id)
);

CREATE TABLE packaging_spec (
  id                TEXT PRIMARY KEY,
  formula_id        TEXT NOT NULL REFERENCES formula(id),
  packaging_item_id TEXT NOT NULL REFERENCES item(id),
  qty_per_base      REAL NOT NULL,                 -- packaging units per base_qty
  uom_id            TEXT NOT NULL REFERENCES uom(id)
);

CREATE INDEX idx_fingredient_formula ON formula_ingredient(formula_id);
CREATE INDEX idx_fstep_formula       ON formula_step(formula_id);
CREATE INDEX idx_pkgspec_formula     ON packaging_spec(formula_id);
