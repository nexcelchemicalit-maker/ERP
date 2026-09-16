-- Nexcel ERP — Phase 5: Planning / MPS (D1 / SQLite)
-- Master production schedule; requirements are exploded from the approved formula on demand.

CREATE TABLE mps_order (
  id              TEXT PRIMARY KEY,
  product_item_id TEXT NOT NULL REFERENCES item(id),
  qty             REAL NOT NULL,
  uom_id          TEXT NOT NULL REFERENCES uom(id),
  due_date        TEXT,
  source          TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('forecast','sales_order','manual')),
  status          TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','firm','converted','cancelled')),
  work_order_id   TEXT REFERENCES work_order(id),
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_mps_product ON mps_order(product_item_id);
CREATE INDEX idx_mps_status  ON mps_order(status);
