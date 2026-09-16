-- Nexcel ERP — Phase 1: Foundations + Inventory (D1 / SQLite)
-- The traceability spine: a usable quantity is lot + bin + uom + qc_status.

-- ---------- Module A: Foundations & master data ----------

CREATE TABLE uom (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  dimension   TEXT NOT NULL CHECK (dimension IN ('mass','volume','count','length')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE uom_conversion (
  id          TEXT PRIMARY KEY,
  from_uom_id TEXT NOT NULL REFERENCES uom(id),
  to_uom_id   TEXT NOT NULL REFERENCES uom(id),
  factor      REAL NOT NULL,                 -- qty_to = qty_from * factor
  item_id     TEXT REFERENCES item(id)       -- NULL = global conversion
);

CREATE TABLE item (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  item_type      TEXT NOT NULL CHECK (item_type IN
                   ('raw','intermediate','wip','finished','packaging','by_product','co_product','waste')),
  base_uom_id    TEXT NOT NULL REFERENCES uom(id),
  tracking       TEXT NOT NULL DEFAULT 'lot' CHECK (tracking IN ('lot','serial','none')),
  shelf_life_days INTEGER,
  hazard_class   TEXT,
  sds_ref        TEXT,
  standard_cost  REAL NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE item_uom (
  id      TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES item(id),
  uom_id  TEXT NOT NULL REFERENCES uom(id),
  UNIQUE (item_id, uom_id)
);

CREATE TABLE partner (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN ('supplier','customer','both')),
  tax_id       TEXT,
  address      TEXT,
  contact      TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE app_user (
  id         TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE audit_log (
  id           TEXT PRIMARY KEY,
  entity_table TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('create','update','void','status_change')),
  changed_by   TEXT REFERENCES app_user(id),
  changed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  before_json  TEXT,
  after_json   TEXT,
  reason_code  TEXT
);

-- ---------- Module B: Warehouse & locations ----------

CREATE TABLE warehouse (
  id      TEXT PRIMARY KEY,
  code    TEXT NOT NULL UNIQUE,
  name    TEXT NOT NULL,
  address TEXT
);

CREATE TABLE bin (
  id                    TEXT PRIMARY KEY,
  warehouse_id          TEXT NOT NULL REFERENCES warehouse(id),
  code                  TEXT NOT NULL,
  zone                  TEXT,
  temp_class            TEXT CHECK (temp_class IN ('ambient','cold','cool','hazmat','flammable')),
  capacity_qty          REAL,
  capacity_uom_id       TEXT REFERENCES uom(id),
  allowed_hazard_classes TEXT,               -- JSON array of allowed GHS classes
  is_active             INTEGER NOT NULL DEFAULT 1,
  UNIQUE (warehouse_id, code)
);

-- ---------- Module C: Inventory & traceability ----------

CREATE TABLE lot (
  id              TEXT PRIMARY KEY,
  item_id         TEXT NOT NULL REFERENCES item(id),
  lot_no          TEXT NOT NULL,
  supplier_lot_no TEXT,
  origin_type     TEXT NOT NULL CHECK (origin_type IN ('purchase','production','adjustment','opening')),
  origin_ref_id   TEXT,
  mfg_date        TEXT,
  expiry_date     TEXT,
  qc_status       TEXT NOT NULL DEFAULT 'quarantine'
                    CHECK (qc_status IN ('pending','quarantine','released','rejected','rework','scrapped')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (item_id, lot_no)
);

CREATE TABLE lot_genealogy (
  id            TEXT PRIMARY KEY,
  parent_lot_id TEXT NOT NULL REFERENCES lot(id),
  child_lot_id  TEXT NOT NULL REFERENCES lot(id),
  batch_id      TEXT,
  relationship  TEXT NOT NULL CHECK (relationship IN
                  ('consumed_into','produced_from','split','merge','repack'))
);

CREATE TABLE stock (
  id           TEXT PRIMARY KEY,
  lot_id       TEXT NOT NULL REFERENCES lot(id),
  bin_id       TEXT NOT NULL REFERENCES bin(id),
  uom_id       TEXT NOT NULL REFERENCES uom(id),
  qty_on_hand  REAL NOT NULL DEFAULT 0,
  qty_reserved REAL NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (lot_id, bin_id, uom_id)
);

CREATE TABLE stock_movement (
  id            TEXT PRIMARY KEY,
  movement_type TEXT NOT NULL CHECK (movement_type IN
                  ('receipt','putaway','transfer','issue_to_production',
                   'output_from_production','ship','adjustment','count_adjust','scrap')),
  lot_id        TEXT NOT NULL REFERENCES lot(id),
  from_bin_id   TEXT REFERENCES bin(id),
  to_bin_id     TEXT REFERENCES bin(id),
  qty           REAL NOT NULL,               -- signed by convention (see API)
  uom_id        TEXT NOT NULL REFERENCES uom(id),
  ref_type      TEXT,
  ref_id        TEXT,
  reason_code   TEXT,
  performed_by  TEXT REFERENCES app_user(id),
  performed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE reservation (
  id                TEXT PRIMARY KEY,
  lot_id            TEXT NOT NULL REFERENCES lot(id),
  qty               REAL NOT NULL,
  uom_id            TEXT NOT NULL REFERENCES uom(id),
  reserved_for_type TEXT NOT NULL CHECK (reserved_for_type IN ('work_order','sales_order')),
  reserved_for_id   TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','consumed','released')),
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE inventory_count (
  id            TEXT PRIMARY KEY,
  count_type    TEXT NOT NULL CHECK (count_type IN ('cycle','physical')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','counting','review','posted')),
  scheduled_for TEXT,
  created_by    TEXT REFERENCES app_user(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE count_line (
  id          TEXT PRIMARY KEY,
  count_id    TEXT NOT NULL REFERENCES inventory_count(id),
  lot_id      TEXT NOT NULL REFERENCES lot(id),
  bin_id      TEXT NOT NULL REFERENCES bin(id),
  system_qty  REAL NOT NULL,
  counted_qty REAL,
  reason_code TEXT,
  counted_by  TEXT REFERENCES app_user(id)
);

-- Helpful indexes
CREATE INDEX idx_lot_item     ON lot(item_id);
CREATE INDEX idx_lot_status   ON lot(qc_status);
CREATE INDEX idx_stock_lot    ON stock(lot_id);
CREATE INDEX idx_stock_bin    ON stock(bin_id);
CREATE INDEX idx_move_lot     ON stock_movement(lot_id);
CREATE INDEX idx_move_time    ON stock_movement(performed_at);
