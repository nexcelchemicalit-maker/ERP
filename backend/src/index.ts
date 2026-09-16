import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Env = { DB: D1Database; ASSETS: Fetcher };

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

async function audit(
  db: D1Database,
  table: string,
  entityId: string,
  action: 'create' | 'update' | 'void' | 'status_change',
  after: unknown,
  changedBy?: string,
  reason?: string,
) {
  await db
    .prepare(
      `INSERT INTO audit_log (id,entity_table,entity_id,action,changed_by,after_json,reason_code)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .bind(uid(), table, entityId, action, changedBy ?? null, JSON.stringify(after), reason ?? null)
    .run();
}

app.get('/api/health', (c) => c.json({ ok: true, service: 'nexcel-erp', time: now() }));

// ---------- Dashboard ----------
app.get('/api/dashboard/summary', async (c) => {
  const db = c.env.DB;
  const one = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;

  const [items, lots, released, quarantine, rejected, partners, bins, stockLines] = await Promise.all([
    one(`SELECT COUNT(*) n FROM item WHERE is_active=1`),
    one(`SELECT COUNT(*) n FROM lot`),
    one(`SELECT COUNT(*) n FROM lot WHERE qc_status='released'`),
    one(`SELECT COUNT(*) n FROM lot WHERE qc_status='quarantine'`),
    one(`SELECT COUNT(*) n FROM lot WHERE qc_status='rejected'`),
    one(`SELECT COUNT(*) n FROM partner WHERE is_active=1`),
    one(`SELECT COUNT(*) n FROM bin WHERE is_active=1`),
    one(`SELECT COUNT(*) n FROM stock`),
  ]);

  const value = await db
    .prepare(
      `SELECT COALESCE(SUM(s.qty_on_hand * i.standard_cost),0) v
       FROM stock s JOIN lot l ON l.id=s.lot_id JOIN item i ON i.id=l.item_id`,
    )
    .first<{ v: number }>();

  const byStatus = await db
    .prepare(`SELECT qc_status status, COUNT(*) n FROM lot GROUP BY qc_status`)
    .all();

  return c.json({
    tiles: { items, lots, released, quarantine, rejected, partners, bins, stockLines },
    approxStockValue: value?.v ?? 0,
    lotsByStatus: byStatus.results,
  });
});

// ---------- Master data ----------
app.get('/api/uoms', async (c) =>
  c.json((await c.env.DB.prepare(`SELECT * FROM uom ORDER BY code`).all()).results),
);

app.get('/api/items', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT i.*, u.code base_uom FROM item i JOIN uom u ON u.id=i.base_uom_id
     ORDER BY i.name`,
  ).all();
  return c.json(rows.results);
});

app.post('/api/items', async (c) => {
  const b = await c.req.json();
  if (!b.code || !b.name || !b.item_type || !b.base_uom_id)
    return c.json({ error: 'code, name, item_type and base_uom_id are required' }, 400);
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO item (id,code,name,item_type,base_uom_id,shelf_life_days,hazard_class,standard_cost)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(id, b.code, b.name, b.item_type, b.base_uom_id, b.shelf_life_days ?? null, b.hazard_class ?? null, b.standard_cost ?? 0)
    .run();
  await audit(c.env.DB, 'item', id, 'create', b, b.performed_by);
  return c.json({ id }, 201);
});

app.get('/api/partners', async (c) =>
  c.json((await c.env.DB.prepare(`SELECT * FROM partner ORDER BY name`).all()).results),
);

app.post('/api/partners', async (c) => {
  const b = await c.req.json();
  if (!b.code || !b.name || !b.partner_type)
    return c.json({ error: 'code, name and partner_type are required' }, 400);
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO partner (id,code,name,partner_type,tax_id,address,contact) VALUES (?,?,?,?,?,?,?)`,
  )
    .bind(id, b.code, b.name, b.partner_type, b.tax_id ?? null, b.address ?? null, b.contact ?? null)
    .run();
  return c.json({ id }, 201);
});

app.get('/api/warehouses', async (c) =>
  c.json((await c.env.DB.prepare(`SELECT * FROM warehouse ORDER BY code`).all()).results),
);

app.get('/api/bins', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.*, w.code warehouse_code FROM bin b JOIN warehouse w ON w.id=b.warehouse_id
     WHERE b.is_active=1 ORDER BY b.code`,
  ).all();
  return c.json(rows.results);
});

// ---------- Lots ----------
app.get('/api/lots', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT l.id, l.lot_no, l.supplier_lot_no, l.qc_status, l.origin_type, l.mfg_date, l.expiry_date,
            i.code item_code, i.name item_name,
            COALESCE((SELECT SUM(qty_on_hand) FROM stock s WHERE s.lot_id=l.id),0) qty_on_hand
     FROM lot l JOIN item i ON i.id=l.item_id
     ORDER BY l.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

app.get('/api/lots/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const lot = await db
    .prepare(`SELECT l.*, i.code item_code, i.name item_name FROM lot l JOIN item i ON i.id=l.item_id WHERE l.id=?`)
    .bind(id)
    .first();
  if (!lot) return c.json({ error: 'lot not found' }, 404);
  const stock = (await db
    .prepare(`SELECT s.*, b.code bin_code, u.code uom FROM stock s JOIN bin b ON b.id=s.bin_id JOIN uom u ON u.id=s.uom_id WHERE s.lot_id=?`)
    .bind(id)
    .all()).results;
  const genealogy = (await db
    .prepare(
      `SELECT g.relationship,
              pl.lot_no parent_lot, cl.lot_no child_lot
       FROM lot_genealogy g
       JOIN lot pl ON pl.id=g.parent_lot_id
       JOIN lot cl ON cl.id=g.child_lot_id
       WHERE g.parent_lot_id=? OR g.child_lot_id=?`,
    )
    .bind(id, id)
    .all()).results;
  return c.json({ ...lot, stock, genealogy });
});

// Release / reject / rework / hold a lot (QC disposition entry point)
app.post('/api/lots/:id/qc', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const map: Record<string, string> = {
    released: 'released',
    rejected: 'rejected',
    rework: 'rework',
    hold: 'quarantine',
    scrapped: 'scrapped',
  };
  const status = map[b.decision];
  if (!status) return c.json({ error: 'decision must be one of released, rejected, rework, hold, scrapped' }, 400);
  const res = await c.env.DB.prepare(`UPDATE lot SET qc_status=? WHERE id=?`).bind(status, id).run();
  if (!res.meta.changes) return c.json({ error: 'lot not found' }, 404);
  await audit(c.env.DB, 'lot', id, 'status_change', { qc_status: status }, b.decided_by, b.reason_code);
  return c.json({ id, qc_status: status });
});

// ---------- Stock (the joined "what do we have" view) ----------
app.get('/api/stock', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, i.code item_code, i.name item_name, i.item_type,
            l.lot_no, l.qc_status, l.expiry_date,
            b.code bin_code, b.zone, u.code uom,
            s.qty_on_hand, s.qty_reserved, (s.qty_on_hand - s.qty_reserved) qty_available
     FROM stock s
     JOIN lot l  ON l.id=s.lot_id
     JOIN item i ON i.id=l.item_id
     JOIN bin b  ON b.id=s.bin_id
     JOIN uom u  ON u.id=s.uom_id
     ORDER BY i.name, l.lot_no`,
  ).all();
  return c.json(rows.results);
});

// ---------- Movement ledger ----------
app.get('/api/movements', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.movement_type, m.qty, u.code uom, i.name item_name, l.lot_no,
            fb.code from_bin, tb.code to_bin, m.reason_code, m.performed_at
     FROM stock_movement m
     JOIN lot l  ON l.id=m.lot_id
     JOIN item i ON i.id=l.item_id
     JOIN uom u  ON u.id=m.uom_id
     LEFT JOIN bin fb ON fb.id=m.from_bin_id
     LEFT JOIN bin tb ON tb.id=m.to_bin_id
     ORDER BY m.performed_at DESC LIMIT 50`,
  ).all();
  return c.json(rows.results);
});

// ---------- Goods receipt: creates a lot in QUARANTINE + stock + movement ----------
app.post('/api/receipts', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.item_id || !b.lot_no || !b.qty || !b.uom_id)
    return c.json({ error: 'item_id, lot_no, qty and uom_id are required' }, 400);

  let binId: string | null = b.bin_id ?? null;
  if (!binId) {
    const q = await db.prepare(`SELECT id FROM bin WHERE zone='Quarantine' AND is_active=1 LIMIT 1`).first<{ id: string }>();
    binId = q?.id ?? null;
  }
  if (!binId) return c.json({ error: 'no bin_id given and no Quarantine bin exists' }, 400);

  const lotId = uid();
  const stockId = uid();
  const moveId = uid();

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO lot (id,item_id,lot_no,supplier_lot_no,origin_type,origin_ref_id,mfg_date,expiry_date,qc_status)
           VALUES (?,?,?,?,?,?,?,?, 'quarantine')`,
        )
        .bind(lotId, b.item_id, b.lot_no, b.supplier_lot_no ?? null, 'purchase', b.po_ref ?? null, b.mfg_date ?? null, b.expiry_date ?? null),
      db.prepare(`INSERT INTO stock (id,lot_id,bin_id,uom_id,qty_on_hand,qty_reserved) VALUES (?,?,?,?,?,0)`).bind(stockId, lotId, binId, b.uom_id, b.qty),
      db
        .prepare(
          `INSERT INTO stock_movement (id,movement_type,lot_id,to_bin_id,qty,uom_id,ref_type,performed_by)
           VALUES (?, 'receipt', ?, ?, ?, ?, 'goods_receipt', ?)`,
        )
        .bind(moveId, lotId, binId, b.qty, b.uom_id, b.performed_by ?? null),
    ]);
  } catch (e) {
    return c.json({ error: 'receipt failed (duplicate lot number for this item?)', detail: String(e) }, 400);
  }
  await audit(db, 'lot', lotId, 'create', { ...b, qc_status: 'quarantine' }, b.performed_by);
  return c.json({ lot_id: lotId, qc_status: 'quarantine', bin_id: binId }, 201);
});

// ---------- Transfer qty between bins ----------
app.post('/api/transfers', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.lot_id || !b.from_bin_id || !b.to_bin_id || !b.qty || !b.uom_id)
    return c.json({ error: 'lot_id, from_bin_id, to_bin_id, qty and uom_id are required' }, 400);

  const from = await db
    .prepare(`SELECT * FROM stock WHERE lot_id=? AND bin_id=? AND uom_id=?`)
    .bind(b.lot_id, b.from_bin_id, b.uom_id)
    .first<{ id: string; qty_on_hand: number; qty_reserved: number }>();
  if (!from) return c.json({ error: 'no stock in source bin for this lot/uom' }, 400);
  if (from.qty_on_hand - from.qty_reserved < b.qty)
    return c.json({ error: 'not enough available qty in source bin' }, 400);

  const to = await db
    .prepare(`SELECT * FROM stock WHERE lot_id=? AND bin_id=? AND uom_id=?`)
    .bind(b.lot_id, b.to_bin_id, b.uom_id)
    .first<{ id: string }>();

  const ops = [
    db.prepare(`UPDATE stock SET qty_on_hand=qty_on_hand-?, updated_at=datetime('now') WHERE id=?`).bind(b.qty, from.id),
    to
      ? db.prepare(`UPDATE stock SET qty_on_hand=qty_on_hand+?, updated_at=datetime('now') WHERE id=?`).bind(b.qty, to.id)
      : db.prepare(`INSERT INTO stock (id,lot_id,bin_id,uom_id,qty_on_hand,qty_reserved) VALUES (?,?,?,?,?,0)`).bind(uid(), b.lot_id, b.to_bin_id, b.uom_id, b.qty),
    db
      .prepare(
        `INSERT INTO stock_movement (id,movement_type,lot_id,from_bin_id,to_bin_id,qty,uom_id,performed_by)
         VALUES (?, 'transfer', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(uid(), b.lot_id, b.from_bin_id, b.to_bin_id, b.qty, b.uom_id, b.performed_by ?? null),
  ];
  await db.batch(ops);
  return c.json({ ok: true });
});

// ---------- Stock adjustment (+/- with reason) ----------
app.post('/api/adjustments', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.lot_id || !b.bin_id || !b.uom_id || b.delta_qty === undefined || !b.reason_code)
    return c.json({ error: 'lot_id, bin_id, uom_id, delta_qty and reason_code are required' }, 400);

  const row = await db
    .prepare(`SELECT * FROM stock WHERE lot_id=? AND bin_id=? AND uom_id=?`)
    .bind(b.lot_id, b.bin_id, b.uom_id)
    .first<{ id: string; qty_on_hand: number; qty_reserved: number }>();

  if (!row && b.delta_qty < 0) return c.json({ error: 'no stock to reduce' }, 400);
  if (row && row.qty_on_hand + b.delta_qty < row.qty_reserved)
    return c.json({ error: 'adjustment would drop below reserved qty' }, 400);

  const ops = [
    row
      ? db.prepare(`UPDATE stock SET qty_on_hand=qty_on_hand+?, updated_at=datetime('now') WHERE id=?`).bind(b.delta_qty, row.id)
      : db.prepare(`INSERT INTO stock (id,lot_id,bin_id,uom_id,qty_on_hand,qty_reserved) VALUES (?,?,?,?,?,0)`).bind(uid(), b.lot_id, b.bin_id, b.uom_id, b.delta_qty),
    db
      .prepare(
        `INSERT INTO stock_movement (id,movement_type,lot_id,to_bin_id,qty,uom_id,reason_code,performed_by)
         VALUES (?, 'adjustment', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(uid(), b.lot_id, b.bin_id, b.delta_qty, b.uom_id, b.reason_code, b.performed_by ?? null),
  ];
  await db.batch(ops);
  return c.json({ ok: true });
});

// API 404 fallback (static assets are handled by the [assets] binding).
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

export default app;
