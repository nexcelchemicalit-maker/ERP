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

  const [samplesOpen, oosOpen, coas, woOpen, batchesActive, batchesDone] = await Promise.all([
    one(`SELECT COUNT(*) n FROM sample WHERE status IN ('pending','testing')`),
    one(`SELECT COUNT(*) n FROM sample WHERE status='oos'`),
    one(`SELECT COUNT(*) n FROM coa`),
    one(`SELECT COUNT(*) n FROM work_order WHERE status IN ('planned','released','in_progress')`),
    one(`SELECT COUNT(*) n FROM batch WHERE status IN ('in_progress','on_hold')`),
    one(`SELECT COUNT(*) n FROM batch WHERE status IN ('completed','closed')`),
  ]);

  return c.json({
    tiles: { items, lots, released, quarantine, rejected, partners, bins, stockLines },
    qc: { samplesOpen, oosOpen, coas },
    production: { woOpen, batchesActive, batchesDone },
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

// ================= Phase 2: Quality Control =================

// ---------- Specifications ----------
app.get('/api/specs', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.version, s.status, i.code item_code, i.name item_name,
            (SELECT COUNT(*) FROM spec_parameter p WHERE p.spec_id=s.id) param_count
     FROM specification s JOIN item i ON i.id=s.item_id
     ORDER BY i.name, s.version`,
  ).all();
  return c.json(rows.results);
});

app.get('/api/specs/:id', async (c) => {
  const id = c.req.param('id');
  const spec = await c.env.DB
    .prepare(`SELECT s.*, i.code item_code, i.name item_name FROM specification s JOIN item i ON i.id=s.item_id WHERE s.id=?`)
    .bind(id)
    .first();
  if (!spec) return c.json({ error: 'spec not found' }, 404);
  const params = (await c.env.DB
    .prepare(`SELECT p.*, u.code uom FROM spec_parameter p LEFT JOIN uom u ON u.id=p.uom_id WHERE p.spec_id=? ORDER BY p.sequence`)
    .bind(id)
    .all()).results;
  return c.json({ ...spec, parameters: params });
});

// ---------- Samples ----------
app.get('/api/samples', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT s.id, s.sample_type, s.status, s.pulled_at,
            i.name item_name, l.lot_no, l.qc_status lot_status
     FROM sample s
     LEFT JOIN lot l  ON l.id=s.lot_id
     LEFT JOIN item i ON i.id=l.item_id
     ORDER BY s.pulled_at DESC`,
  ).all();
  return c.json(rows.results);
});

app.get('/api/samples/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const s = await db
    .prepare(
      `SELECT s.*, l.lot_no, l.qc_status lot_status, i.name item_name, i.code item_code
       FROM sample s LEFT JOIN lot l ON l.id=s.lot_id LEFT JOIN item i ON i.id=l.item_id WHERE s.id=?`,
    )
    .bind(id)
    .first();
  if (!s) return c.json({ error: 'sample not found' }, 404);
  // parameters joined with any recorded result
  const params = (await db
    .prepare(
      `SELECT p.id spec_parameter_id, p.sequence, p.test_name, p.method, p.result_type, p.lower_limit, p.upper_limit,
              p.target, p.identity_criterion, u.code uom,
              r.result_value, r.pass_fail, r.is_oos
       FROM spec_parameter p
       LEFT JOIN uom u ON u.id=p.uom_id
       LEFT JOIN test_result r ON r.spec_parameter_id=p.id AND r.sample_id=?
       WHERE p.spec_id=(SELECT spec_id FROM sample WHERE id=?)
       ORDER BY p.sequence`,
    )
    .bind(id, id)
    .all()).results;
  const disp = (await db
    .prepare(`SELECT decision, reason_code, decided_at FROM qc_disposition WHERE sample_id=? ORDER BY decided_at DESC`)
    .bind(id)
    .all()).results;
  const coa = await db.prepare(`SELECT id, coa_no FROM coa WHERE sample_id=?`).bind(id).first();
  return c.json({ ...s, parameters: params, dispositions: disp, coa });
});

// Pull a sample for a lot (defaults to the item's approved spec)
app.post('/api/samples', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.lot_id) return c.json({ error: 'lot_id is required' }, 400);
  const lot = await db.prepare(`SELECT item_id FROM lot WHERE id=?`).bind(b.lot_id).first<{ item_id: string }>();
  if (!lot) return c.json({ error: 'lot not found' }, 404);
  let specId: string | undefined = b.spec_id;
  if (!specId) {
    const sp = await db
      .prepare(`SELECT id FROM specification WHERE item_id=? AND status='approved' ORDER BY version DESC LIMIT 1`)
      .bind(lot.item_id)
      .first<{ id: string }>();
    specId = sp?.id;
  }
  if (!specId) return c.json({ error: 'no approved specification exists for this item' }, 400);
  const id = uid();
  await db
    .prepare(
      `INSERT INTO sample (id,sample_type,lot_id,spec_id,pulled_by,status) VALUES (?,?,?,?,?, 'pending')`,
    )
    .bind(id, b.sample_type ?? 'incoming', b.lot_id, specId, b.pulled_by ?? null)
    .run();
  return c.json({ id, spec_id: specId }, 201);
});

// Enter/replace results for a sample; auto-evaluates each against the spec limits
app.post('/api/samples/:id/results', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const db = c.env.DB;
  const results: Array<{ spec_parameter_id: string; result_value: string; tested_by?: string }> = b.results ?? [];
  if (!results.length) return c.json({ error: 'results array is required' }, 400);

  // load the relevant parameters to evaluate against
  const params = (await db
    .prepare(`SELECT * FROM spec_parameter WHERE spec_id=(SELECT spec_id FROM sample WHERE id=?)`)
    .bind(id)
    .all()).results as Array<any>;
  const byId = new Map(params.map((p) => [p.id, p]));

  const evaluate = (p: any, raw: string): boolean => {
    if (raw == null || raw === '') return false;
    if (p.result_type === 'numeric') {
      const v = parseFloat(raw);
      if (Number.isNaN(v)) return false;
      if (p.lower_limit != null && v < p.lower_limit) return false;
      if (p.upper_limit != null && v > p.upper_limit) return false;
      return true;
    }
    // identity / attribute
    if (p.identity_criterion == null) return true;
    return String(raw).trim().toLowerCase() === String(p.identity_criterion).trim().toLowerCase();
  };

  const ops = [];
  let anyOos = false;
  for (const r of results) {
    const p = byId.get(r.spec_parameter_id);
    if (!p) continue;
    const pass = evaluate(p, r.result_value);
    if (!pass) anyOos = true;
    ops.push(
      db
        .prepare(
          `INSERT INTO test_result (id,sample_id,spec_parameter_id,result_value,pass_fail,is_oos,tested_by)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(sample_id,spec_parameter_id) DO UPDATE SET
             result_value=excluded.result_value, pass_fail=excluded.pass_fail,
             is_oos=excluded.is_oos, tested_by=excluded.tested_by, tested_at=datetime('now')`,
        )
        .bind(uid(), id, r.spec_parameter_id, r.result_value, pass ? 'pass' : 'fail', pass ? 0 : 1, r.tested_by ?? null),
    );
  }
  // has every parameter now got a result?
  const total = params.length;
  const answered = new Set(results.map((r) => r.spec_parameter_id)).size;
  const status = anyOos ? 'oos' : answered >= total ? 'complete' : 'testing';
  ops.push(db.prepare(`UPDATE sample SET status=? WHERE id=?`).bind(status, id));
  await db.batch(ops);
  return c.json({ id, status, oos: anyOos });
});

// Disposition a sample -> sets the lot's qc_status; a release issues a COA
app.post('/api/samples/:id/disposition', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const db = c.env.DB;
  const decisionToStatus: Record<string, string> = {
    released: 'released',
    rejected: 'rejected',
    rework: 'rework',
    scrapped: 'scrapped',
    hold: 'quarantine',
  };
  const lotStatus = decisionToStatus[b.decision];
  if (!lotStatus) return c.json({ error: 'decision must be released, rejected, rework, scrapped or hold' }, 400);

  const s = await db
    .prepare(`SELECT sample_type, lot_id FROM sample WHERE id=?`)
    .bind(id)
    .first<{ sample_type: string; lot_id: string }>();
  if (!s) return c.json({ error: 'sample not found' }, 404);

  const ops = [
    db.prepare(
      `INSERT INTO qc_disposition (id,sample_id,target_lot_id,decision,reason_code,decided_by)
       VALUES (?,?,?,?,?,?)`,
    ).bind(uid(), id, s.lot_id, b.decision, b.reason_code ?? null, b.decided_by ?? null),
    db.prepare(`UPDATE sample SET status='closed' WHERE id=?`).bind(id),
  ];
  if (s.lot_id) ops.push(db.prepare(`UPDATE lot SET qc_status=? WHERE id=?`).bind(lotStatus, s.lot_id));
  await db.batch(ops);
  await audit(db, 'lot', s.lot_id ?? id, 'status_change', { qc_status: lotStatus, via: 'qc_disposition' }, b.decided_by, b.reason_code);

  let coaId: string | null = null;
  let coaNo: string | null = null;
  if (b.decision === 'released' && s.lot_id) {
    coaId = uid();
    coaNo = 'COA-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + coaId.slice(0, 6).toUpperCase();
    const lines = (await db
      .prepare(
        `SELECT p.test_name, p.result_type, p.lower_limit, p.upper_limit, p.identity_criterion, u.code uom,
                r.result_value, r.is_oos
         FROM test_result r JOIN spec_parameter p ON p.id=r.spec_parameter_id
         LEFT JOIN uom u ON u.id=p.uom_id
         WHERE r.sample_id=? ORDER BY p.sequence`,
      )
      .bind(id)
      .all()).results as Array<any>;
    const specText = (p: any) => {
      if (p.result_type !== 'numeric') return p.identity_criterion ?? '';
      const lo = p.lower_limit, hi = p.upper_limit, u = p.uom ? ' ' + p.uom : '';
      if (lo != null && hi != null) return `${lo} – ${hi}${u}`;
      if (hi != null) return `≤ ${hi}${u}`;
      if (lo != null) return `≥ ${lo}${u}`;
      return '';
    };
    const conforms = lines.every((l) => !l.is_oos) ? 1 : 0;
    const coaOps = [
      db.prepare(`INSERT INTO coa (id,lot_id,sample_id,coa_no,conforms,issued_by) VALUES (?,?,?,?,?,?)`).bind(coaId, s.lot_id, id, coaNo, conforms, b.decided_by ?? null),
      ...lines.map((l) =>
        db.prepare(`INSERT INTO coa_line (id,coa_id,parameter_name,spec_text,result_value,conforms) VALUES (?,?,?,?,?,?)`).bind(uid(), coaId, l.test_name, specText(l), l.result_value, l.is_oos ? 0 : 1),
      ),
    ];
    await db.batch(coaOps);
  }
  return c.json({ id, lot_status: lotStatus, coa_id: coaId, coa_no: coaNo });
});

// ---------- COAs ----------
app.get('/api/coas', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT co.id, co.coa_no, co.conforms, co.issued_at, i.name item_name, l.lot_no
     FROM coa co JOIN lot l ON l.id=co.lot_id JOIN item i ON i.id=l.item_id
     ORDER BY co.issued_at DESC`,
  ).all();
  return c.json(rows.results);
});

app.get('/api/coas/:id', async (c) => {
  const id = c.req.param('id');
  const co = await c.env.DB
    .prepare(
      `SELECT co.*, i.name item_name, i.code item_code, l.lot_no, l.expiry_date
       FROM coa co JOIN lot l ON l.id=co.lot_id JOIN item i ON i.id=l.item_id WHERE co.id=?`,
    )
    .bind(id)
    .first();
  if (!co) return c.json({ error: 'coa not found' }, 404);
  const lines = (await c.env.DB.prepare(`SELECT parameter_name, spec_text, result_value, conforms FROM coa_line WHERE coa_id=?`).bind(id).all()).results;
  return c.json({ ...co, lines });
});

// ================= Phase 3: R&D / Formulation =================

async function formulaCosts(db: D1Database, formulaId: string) {
  const mat = await db
    .prepare(`SELECT COALESCE(SUM(fi.qty * i.standard_cost),0) c FROM formula_ingredient fi JOIN item i ON i.id=fi.item_id WHERE fi.formula_id=?`)
    .bind(formulaId)
    .first<{ c: number }>();
  const pkg = await db
    .prepare(`SELECT COALESCE(SUM(p.qty_per_base * i.standard_cost),0) c FROM packaging_spec p JOIN item i ON i.id=p.packaging_item_id WHERE p.formula_id=?`)
    .bind(formulaId)
    .first<{ c: number }>();
  const material = mat?.c ?? 0;
  const packaging = pkg?.c ?? 0;
  return { material_cost: material, packaging_cost: packaging, total_cost: material + packaging };
}

app.get('/api/formulas', async (c) => {
  const rows = (await c.env.DB.prepare(
    `SELECT f.id, f.version, f.status, f.base_qty, f.security_level,
            i.code product_code, i.name product_name, u.code base_uom
     FROM formula f JOIN item i ON i.id=f.product_item_id JOIN uom u ON u.id=f.base_uom_id
     ORDER BY i.name, f.version`,
  ).all()).results as Array<any>;
  for (const r of rows) Object.assign(r, await formulaCosts(c.env.DB, r.id));
  return c.json(rows);
});

app.get('/api/formulas/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const f = await db
    .prepare(`SELECT f.*, i.code product_code, i.name product_name, u.code base_uom FROM formula f JOIN item i ON i.id=f.product_item_id JOIN uom u ON u.id=f.base_uom_id WHERE f.id=?`)
    .bind(id)
    .first();
  if (!f) return c.json({ error: 'formula not found' }, 404);
  const ingredients = (await db
    .prepare(
      `SELECT fi.id, fi.sequence, fi.qty, fi.percentage, fi.is_optional, i.code item_code, i.name item_name,
              u.code uom, i.standard_cost, (fi.qty * i.standard_cost) line_cost
       FROM formula_ingredient fi JOIN item i ON i.id=fi.item_id JOIN uom u ON u.id=fi.uom_id
       WHERE fi.formula_id=? ORDER BY fi.sequence`,
    )
    .bind(id)
    .all()).results;
  const steps = (await db
    .prepare(`SELECT id, step_no, instruction, param_type, target, tolerance_low, tolerance_high, is_ipc_checkpoint FROM formula_step WHERE formula_id=? ORDER BY step_no`)
    .bind(id)
    .all()).results;
  const packaging = (await db
    .prepare(`SELECT p.id, p.qty_per_base, i.code item_code, i.name item_name, u.code uom, i.standard_cost, (p.qty_per_base*i.standard_cost) line_cost FROM packaging_spec p JOIN item i ON i.id=p.packaging_item_id JOIN uom u ON u.id=p.uom_id WHERE p.formula_id=?`)
    .bind(id)
    .all()).results;
  return c.json({ ...f, ingredients, steps, packaging, costs: await formulaCosts(db, id) });
});

app.post('/api/formulas', async (c) => {
  const b = await c.req.json();
  if (!b.product_item_id || !b.base_qty || !b.base_uom_id)
    return c.json({ error: 'product_item_id, base_qty and base_uom_id are required' }, 400);
  const id = uid();
  const ver = b.version ?? 1;
  try {
    await c.env.DB.prepare(
      `INSERT INTO formula (id,product_item_id,version,status,base_qty,base_uom_id,security_level) VALUES (?,?,?, 'draft', ?,?,?)`,
    )
      .bind(id, b.product_item_id, ver, b.base_qty, b.base_uom_id, b.security_level ?? 'open')
      .run();
  } catch (e) {
    return c.json({ error: 'could not create formula (version already exists for this product?)', detail: String(e) }, 400);
  }
  return c.json({ id }, 201);
});

app.post('/api/formulas/:id/ingredients', async (c) => {
  const fid = c.req.param('id');
  const b = await c.req.json();
  if (!b.item_id || b.qty === undefined || !b.uom_id) return c.json({ error: 'item_id, qty and uom_id are required' }, 400);
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO formula_ingredient (id,formula_id,item_id,sequence,qty,uom_id,percentage,substitute_group,is_optional) VALUES (?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, fid, b.item_id, b.sequence ?? 1, b.qty, b.uom_id, b.percentage ?? null, b.substitute_group ?? null, b.is_optional ? 1 : 0)
    .run();
  return c.json({ id }, 201);
});

app.post('/api/formulas/:id/steps', async (c) => {
  const fid = c.req.param('id');
  const b = await c.req.json();
  if (!b.step_no || !b.instruction) return c.json({ error: 'step_no and instruction are required' }, 400);
  const id = uid();
  await c.env.DB.prepare(
    `INSERT INTO formula_step (id,formula_id,step_no,instruction,param_type,target,tolerance_low,tolerance_high,is_ipc_checkpoint,ipc_spec_parameter_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, fid, b.step_no, b.instruction, b.param_type ?? null, b.target ?? null, b.tolerance_low ?? null, b.tolerance_high ?? null, b.is_ipc_checkpoint ? 1 : 0, b.ipc_spec_parameter_id ?? null)
    .run();
  return c.json({ id }, 201);
});

app.post('/api/formulas/:id/packaging', async (c) => {
  const fid = c.req.param('id');
  const b = await c.req.json();
  if (!b.packaging_item_id || b.qty_per_base === undefined || !b.uom_id) return c.json({ error: 'packaging_item_id, qty_per_base and uom_id are required' }, 400);
  const id = uid();
  await c.env.DB.prepare(`INSERT INTO packaging_spec (id,formula_id,packaging_item_id,qty_per_base,uom_id) VALUES (?,?,?,?,?)`)
    .bind(id, fid, b.packaging_item_id, b.qty_per_base, b.uom_id)
    .run();
  return c.json({ id }, 201);
});

app.post('/api/formulas/:id/approve', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const res = await c.env.DB
    .prepare(`UPDATE formula SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=? AND status='draft'`)
    .bind(b.approved_by ?? null, id)
    .run();
  if (!res.meta.changes) return c.json({ error: 'formula not found or not in draft' }, 400);
  await audit(c.env.DB, 'formula', id, 'status_change', { status: 'approved' }, b.approved_by);
  return c.json({ id, status: 'approved' });
});

// ================= Phase 4: Production =================

app.get('/api/equipment', async (c) =>
  c.json((await c.env.DB.prepare(`SELECT e.*, u.code capacity_uom FROM equipment e LEFT JOIN uom u ON u.id=e.capacity_uom_id ORDER BY e.code`).all()).results),
);

// Create a work order from an approved formula (computes the scale factor)
app.post('/api/work-orders', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.formula_id || !b.planned_qty) return c.json({ error: 'formula_id and planned_qty are required' }, 400);
  const f = await db
    .prepare(`SELECT product_item_id, base_qty, base_uom_id, status FROM formula WHERE id=?`)
    .bind(b.formula_id)
    .first<{ product_item_id: string; base_qty: number; base_uom_id: string; status: string }>();
  if (!f) return c.json({ error: 'formula not found' }, 404);
  if (f.status !== 'approved') return c.json({ error: 'formula is not approved' }, 400);
  const id = uid();
  const scale = b.planned_qty / f.base_qty;
  await db
    .prepare(
      `INSERT INTO work_order (id,formula_id,product_item_id,planned_qty,uom_id,scale_factor,equipment_id,status,planned_start)
       VALUES (?,?,?,?,?,?,?, 'planned', ?)`,
    )
    .bind(id, b.formula_id, f.product_item_id, b.planned_qty, f.base_uom_id, scale, b.equipment_id ?? null, b.planned_start ?? null)
    .run();
  return c.json({ id, scale_factor: scale }, 201);
});

app.get('/api/work-orders', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT w.id, w.planned_qty, w.scale_factor, w.status, u.code uom,
            i.name product_name, f.version formula_version, e.code equipment_code,
            (SELECT COUNT(*) FROM batch b WHERE b.work_order_id=w.id) batch_count
     FROM work_order w
     JOIN item i ON i.id=w.product_item_id
     JOIN formula f ON f.id=w.formula_id
     JOIN uom u ON u.id=w.uom_id
     LEFT JOIN equipment e ON e.id=w.equipment_id
     ORDER BY w.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

// Start a batch from a work order: pre-populates planned materials (scaled) and steps
app.post('/api/batches', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.work_order_id) return c.json({ error: 'work_order_id is required' }, 400);
  const wo = await db
    .prepare(`SELECT formula_id, product_item_id, uom_id, scale_factor FROM work_order WHERE id=?`)
    .bind(b.work_order_id)
    .first<{ formula_id: string; product_item_id: string; uom_id: string; scale_factor: number }>();
  if (!wo) return c.json({ error: 'work order not found' }, 404);

  const ingredients = (await db.prepare(`SELECT * FROM formula_ingredient WHERE formula_id=? ORDER BY sequence`).bind(wo.formula_id).all()).results as Array<any>;
  const steps = (await db.prepare(`SELECT * FROM formula_step WHERE formula_id=? ORDER BY step_no`).bind(wo.formula_id).all()).results as Array<any>;

  const batchId = uid();
  const count = (await db.prepare(`SELECT COUNT(*) n FROM batch`).first<{ n: number }>())?.n ?? 0;
  const batchNo = b.batch_no ?? 'B' + new Date().toISOString().slice(2, 10).replace(/-/g, '') + '-' + String(count + 1).padStart(3, '0');

  const ops = [
    db.prepare(`INSERT INTO batch (id,work_order_id,batch_no,uom_id,status,started_at) VALUES (?,?,?,?, 'in_progress', datetime('now'))`).bind(batchId, b.work_order_id, batchNo, wo.uom_id),
    db.prepare(`UPDATE work_order SET status='in_progress' WHERE id=?`).bind(b.work_order_id),
  ];
  for (const ing of ingredients) {
    ops.push(
      db.prepare(`INSERT INTO batch_material (id,batch_id,item_id,planned_qty,uom_id) VALUES (?,?,?,?,?)`).bind(uid(), batchId, ing.item_id, ing.qty * wo.scale_factor, ing.uom_id),
    );
  }
  for (const s of steps) {
    ops.push(
      db.prepare(`INSERT INTO batch_step (id,batch_id,formula_step_id,step_no,instruction,is_ipc_checkpoint) VALUES (?,?,?,?,?,?)`).bind(uid(), batchId, s.id, s.step_no, s.instruction, s.is_ipc_checkpoint),
    );
  }
  await db.batch(ops);
  return c.json({ id: batchId, batch_no: batchNo }, 201);
});

app.get('/api/batches', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.batch_no, b.status, b.actual_qty, u.code uom, i.name product_name,
            w.planned_qty,
            (SELECT actual_total FROM batch_cost bc WHERE bc.batch_id=b.id) actual_cost
     FROM batch b
     JOIN work_order w ON w.id=b.work_order_id
     JOIN item i ON i.id=w.product_item_id
     LEFT JOIN uom u ON u.id=b.uom_id
     ORDER BY b.created_at DESC`,
  ).all();
  return c.json(rows.results);
});

app.get('/api/batches/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const b = await db
    .prepare(
      `SELECT b.*, i.name product_name, w.product_item_id, w.planned_qty, w.scale_factor
       FROM batch b JOIN work_order w ON w.id=b.work_order_id JOIN item i ON i.id=w.product_item_id WHERE b.id=?`,
    )
    .bind(id)
    .first();
  if (!b) return c.json({ error: 'batch not found' }, 404);
  const materials = (await db
    .prepare(
      `SELECT bm.id, bm.planned_qty, bm.actual_qty, u.code uom, i.code item_code, i.name item_name, bm.item_id,
              l.lot_no, l.qc_status
       FROM batch_material bm JOIN item i ON i.id=bm.item_id JOIN uom u ON u.id=bm.uom_id
       LEFT JOIN lot l ON l.id=bm.lot_id WHERE bm.batch_id=? ORDER BY i.name`,
    )
    .bind(id)
    .all()).results;
  const steps = (await db.prepare(`SELECT id, step_no, instruction, is_ipc_checkpoint, status, actual_param_value, ipc_sample_id FROM batch_step WHERE batch_id=? ORDER BY step_no`).bind(id).all()).results;
  const outputs = (await db
    .prepare(`SELECT bo.output_type, bo.qty, u.code uom, i.name item_name, l.lot_no, l.qc_status FROM batch_output bo JOIN item i ON i.id=bo.item_id JOIN uom u ON u.id=bo.uom_id JOIN lot l ON l.id=bo.lot_id WHERE bo.batch_id=?`)
    .bind(id)
    .all()).results;
  const cost = await db.prepare(`SELECT * FROM batch_cost WHERE batch_id=?`).bind(id).first();
  return c.json({ ...b, materials, steps, outputs, cost });
});

// Dispense a released lot against a planned material line
app.post('/api/batches/:id/materials/:mid/dispense', async (c) => {
  const mid = c.req.param('mid');
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.lot_id || b.actual_qty === undefined) return c.json({ error: 'lot_id and actual_qty are required' }, 400);

  const bm = await db.prepare(`SELECT item_id, uom_id FROM batch_material WHERE id=?`).bind(mid).first<{ item_id: string; uom_id: string }>();
  if (!bm) return c.json({ error: 'material line not found' }, 400);
  const lot = await db.prepare(`SELECT item_id, qc_status FROM lot WHERE id=?`).bind(b.lot_id).first<{ item_id: string; qc_status: string }>();
  if (!lot) return c.json({ error: 'lot not found' }, 404);
  if (lot.qc_status !== 'released') return c.json({ error: 'lot is not QC-released' }, 400);
  const isSub = lot.item_id !== bm.item_id;

  // find a stock row (released lot) with enough available
  const st = await db
    .prepare(`SELECT id, bin_id, qty_on_hand, qty_reserved FROM stock WHERE lot_id=? AND uom_id=? AND (qty_on_hand-qty_reserved) >= ? ORDER BY (qty_on_hand-qty_reserved) DESC LIMIT 1`)
    .bind(b.lot_id, bm.uom_id, b.actual_qty)
    .first<{ id: string; bin_id: string }>();
  if (!st) return c.json({ error: 'not enough available stock of this lot to dispense' }, 400);

  await db.batch([
    db.prepare(`UPDATE stock SET qty_on_hand=qty_on_hand-?, updated_at=datetime('now') WHERE id=?`).bind(b.actual_qty, st.id),
    db.prepare(`UPDATE batch_material SET actual_qty=?, lot_id=?, is_substitute=?, dispensed_by=?, dispensed_at=datetime('now') WHERE id=?`).bind(b.actual_qty, b.lot_id, isSub ? 1 : 0, b.dispensed_by ?? null, mid),
    db.prepare(`INSERT INTO stock_movement (id,movement_type,lot_id,from_bin_id,qty,uom_id,ref_type,ref_id,performed_by) VALUES (?, 'issue_to_production', ?, ?, ?, ?, 'batch', ?, ?)`).bind(uid(), b.lot_id, st.bin_id, b.actual_qty, bm.uom_id, c.req.param('id'), b.dispensed_by ?? null),
  ]);
  return c.json({ ok: true, is_substitute: isSub });
});

// Complete a step; an IPC checkpoint pulls an in-process sample and holds the batch
app.post('/api/batches/:id/steps/:sid/complete', async (c) => {
  const batchId = c.req.param('id');
  const sid = c.req.param('sid');
  const b = await c.req.json().catch(() => ({}));
  const db = c.env.DB;
  const step = await db.prepare(`SELECT is_ipc_checkpoint FROM batch_step WHERE id=?`).bind(sid).first<{ is_ipc_checkpoint: number }>();
  if (!step) return c.json({ error: 'step not found' }, 404);

  let sampleId: string | null = null;
  const ops = [
    db.prepare(`UPDATE batch_step SET status='done', actual_param_value=?, performed_by=?, performed_at=datetime('now') WHERE id=?`).bind(b.actual_param_value ?? null, b.performed_by ?? null, sid),
  ];
  if (step.is_ipc_checkpoint) {
    const prod = await db
      .prepare(`SELECT w.product_item_id FROM batch bt JOIN work_order w ON w.id=bt.work_order_id WHERE bt.id=?`)
      .bind(batchId)
      .first<{ product_item_id: string }>();
    const spec = prod
      ? await db.prepare(`SELECT id FROM specification WHERE item_id=? AND status='approved' ORDER BY version DESC LIMIT 1`).bind(prod.product_item_id).first<{ id: string }>()
      : null;
    if (spec) {
      sampleId = uid();
      ops.push(db.prepare(`INSERT INTO sample (id,sample_type,batch_id,batch_step_id,spec_id,pulled_by,status) VALUES (?, 'in_process', ?, ?, ?, ?, 'pending')`).bind(sampleId, batchId, sid, spec.id, b.performed_by ?? null));
      ops.push(db.prepare(`UPDATE batch_step SET ipc_sample_id=? WHERE id=?`).bind(sampleId, sid));
      ops.push(db.prepare(`UPDATE batch SET status='on_hold' WHERE id=? AND status='in_progress'`).bind(batchId));
    }
  }
  await db.batch(ops);
  return c.json({ ok: true, ipc_sample_id: sampleId });
});

// Complete a batch: book outputs (new lots + stock + genealogy), roll up actual cost
app.post('/api/batches/:id/complete', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json();
  const db = c.env.DB;
  const outputs: Array<{ item_id: string; qty: number; uom_id: string; output_type: string; lot_no?: string }> = b.outputs ?? [];
  if (!outputs.length) return c.json({ error: 'at least one output is required' }, 400);

  const batch = await db.prepare(`SELECT batch_no, work_order_id FROM batch WHERE id=?`).bind(id).first<{ batch_no: string; work_order_id: string }>();
  if (!batch) return c.json({ error: 'batch not found' }, 404);
  const wo = await db.prepare(`SELECT formula_id, scale_factor FROM work_order WHERE id=?`).bind(batch.work_order_id).first<{ formula_id: string; scale_factor: number }>();

  const fgBin = await db.prepare(`SELECT id FROM bin WHERE zone='Finished goods' AND is_active=1 LIMIT 1`).first<{ id: string }>();
  const qBin = await db.prepare(`SELECT id FROM bin WHERE zone='Quarantine' AND is_active=1 LIMIT 1`).first<{ id: string }>();
  const anyBin = await db.prepare(`SELECT id FROM bin WHERE is_active=1 LIMIT 1`).first<{ id: string }>();
  const pickBin = (t: string) => (t === 'waste' ? qBin?.id : fgBin?.id) ?? qBin?.id ?? anyBin?.id;

  const consumed = (await db.prepare(`SELECT DISTINCT lot_id FROM batch_material WHERE batch_id=? AND lot_id IS NOT NULL`).bind(id).all()).results as Array<{ lot_id: string }>;

  const ops = [];
  const createdOutputs: Array<{ lotId: string; type: string }> = [];
  let productQty = 0;
  let idx = 0;
  for (const o of outputs) {
    idx++;
    const lotId = uid();
    const status = o.output_type === 'waste' ? 'released' : 'quarantine';
    const lotNo = o.lot_no ?? `${batch.batch_no}-${o.output_type[0].toUpperCase()}${idx}`;
    const binId = pickBin(o.output_type);
    ops.push(db.prepare(`INSERT INTO lot (id,item_id,lot_no,origin_type,origin_ref_id,qc_status) VALUES (?,?,?, 'production', ?, ?)`).bind(lotId, o.item_id, lotNo, id, status));
    ops.push(db.prepare(`INSERT INTO stock (id,lot_id,bin_id,uom_id,qty_on_hand,qty_reserved) VALUES (?,?,?,?,?,0)`).bind(uid(), lotId, binId, o.uom_id, o.qty));
    ops.push(db.prepare(`INSERT INTO stock_movement (id,movement_type,lot_id,to_bin_id,qty,uom_id,ref_type,ref_id,performed_by) VALUES (?, 'output_from_production', ?, ?, ?, ?, 'batch', ?, ?)`).bind(uid(), lotId, binId, o.qty, o.uom_id, id, b.performed_by ?? null));
    ops.push(db.prepare(`INSERT INTO batch_output (id,batch_id,item_id,lot_id,qty,uom_id,output_type) VALUES (?,?,?,?,?,?,?)`).bind(uid(), id, o.item_id, lotId, o.qty, o.uom_id, o.output_type));
    createdOutputs.push({ lotId, type: o.output_type });
    if (o.output_type === 'product') productQty += o.qty;
  }
  // genealogy: each consumed raw lot -> each product/co_product output lot
  for (const cm of consumed) {
    for (const co of createdOutputs) {
      if (co.type === 'product' || co.type === 'co_product') {
        ops.push(db.prepare(`INSERT INTO lot_genealogy (id,parent_lot_id,child_lot_id,batch_id,relationship) VALUES (?,?,?,?, 'consumed_into')`).bind(uid(), cm.lot_id, co.lotId, id));
      }
    }
  }
  ops.push(db.prepare(`UPDATE batch SET status='completed', actual_qty=?, completed_at=datetime('now') WHERE id=?`).bind(productQty, id));
  ops.push(db.prepare(`UPDATE work_order SET status='completed' WHERE id=?`).bind(batch.work_order_id));

  // ---- costing ----
  const matCost = (await db.prepare(`SELECT COALESCE(SUM(bm.actual_qty*i.standard_cost),0) c FROM batch_material bm JOIN item i ON i.id=bm.item_id WHERE bm.batch_id=? AND bm.actual_qty IS NOT NULL`).bind(id).first<{ c: number }>())?.c ?? 0;
  const scale = wo?.scale_factor ?? 1;
  const pkgBase = wo ? (await formulaCosts(db, wo.formula_id)).packaging_cost : 0;
  const stdBase = wo ? (await formulaCosts(db, wo.formula_id)).total_cost : 0;
  const packaging = pkgBase * scale;
  const labor = b.labor_cost ?? 0;
  const machine = b.machine_cost ?? 0;
  const actual = matCost + packaging + labor + machine;
  const standard = stdBase * scale;
  ops.push(db.prepare(`INSERT INTO batch_cost (id,batch_id,material_cost,packaging_cost,labor_cost,machine_cost,actual_total,standard_total,variance) VALUES (?,?,?,?,?,?,?,?,?)`).bind(uid(), id, matCost, packaging, labor, machine, actual, standard, actual - standard));

  await db.batch(ops);
  return c.json({ ok: true, product_qty: productQty, actual_cost: actual, standard_cost: standard, variance: actual - standard });
});

// Close (review-lock) a completed batch
app.post('/api/batches/:id/close', async (c) => {
  const id = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));
  const res = await c.env.DB.prepare(`UPDATE batch SET status='closed', reviewed_by=?, closed_at=datetime('now') WHERE id=? AND status='completed'`).bind(b.reviewed_by ?? null, id).run();
  if (!res.meta.changes) return c.json({ error: 'batch not found or not completed' }, 400);
  await audit(c.env.DB, 'batch', id, 'status_change', { status: 'closed' }, b.reviewed_by);
  return c.json({ id, status: 'closed' });
});

// ================= Phase 5: Planning / MPS =================

app.get('/api/mps-orders', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT m.id, m.qty, m.due_date, m.source, m.status, u.code uom, i.name product_name, i.id product_item_id,
            m.work_order_id
     FROM mps_order m JOIN item i ON i.id=m.product_item_id JOIN uom u ON u.id=m.uom_id
     ORDER BY m.due_date, m.created_at`,
  ).all();
  return c.json(rows.results);
});

app.post('/api/mps-orders', async (c) => {
  const b = await c.req.json();
  const db = c.env.DB;
  if (!b.product_item_id || !b.qty) return c.json({ error: 'product_item_id and qty are required' }, 400);
  let uomId = b.uom_id;
  if (!uomId) uomId = (await db.prepare(`SELECT base_uom_id id FROM item WHERE id=?`).bind(b.product_item_id).first<{ id: string }>())?.id;
  if (!uomId) return c.json({ error: 'item not found' }, 404);
  const id = uid();
  await db.prepare(`INSERT INTO mps_order (id,product_item_id,qty,uom_id,due_date,source,notes) VALUES (?,?,?,?,?,?,?)`)
    .bind(id, b.product_item_id, b.qty, uomId, b.due_date ?? null, b.source ?? 'manual', b.notes ?? null)
    .run();
  return c.json({ id }, 201);
});

// Explode the approved formula and net against QC-released stock (MRP-lite)
app.get('/api/mps-orders/:id/requirements', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const m = await db.prepare(`SELECT product_item_id, qty FROM mps_order WHERE id=?`).bind(id).first<{ product_item_id: string; qty: number }>();
  if (!m) return c.json({ error: 'mps order not found' }, 404);
  const f = await db.prepare(`SELECT id, base_qty FROM formula WHERE product_item_id=? AND status='approved' ORDER BY version DESC LIMIT 1`).bind(m.product_item_id).first<{ id: string; base_qty: number }>();
  if (!f) return c.json({ error: 'no approved formula for this product', has_formula: false }, 200);
  const scale = m.qty / f.base_qty;
  const ings = (await db
    .prepare(`SELECT fi.item_id, fi.qty, u.code uom, i.code item_code, i.name item_name FROM formula_ingredient fi JOIN item i ON i.id=fi.item_id JOIN uom u ON u.id=fi.uom_id WHERE fi.formula_id=? ORDER BY fi.sequence`)
    .bind(f.id)
    .all()).results as Array<any>;
  const lines = [];
  let canBuild = true;
  for (const ing of ings) {
    const required = ing.qty * scale;
    const avail = (await db
      .prepare(`SELECT COALESCE(SUM(s.qty_on_hand-s.qty_reserved),0) a FROM stock s JOIN lot l ON l.id=s.lot_id WHERE l.item_id=? AND l.qc_status='released'`)
      .bind(ing.item_id)
      .first<{ a: number }>())?.a ?? 0;
    const shortfall = Math.max(0, required - avail);
    if (shortfall > 0) canBuild = false;
    lines.push({ item_code: ing.item_code, item_name: ing.item_name, uom: ing.uom, required, available: avail, shortfall });
  }
  return c.json({ has_formula: true, scale_factor: scale, can_build: canBuild, lines });
});

// Convert an MPS order into a production work order
app.post('/api/mps-orders/:id/convert', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const m = await db.prepare(`SELECT product_item_id, qty, status FROM mps_order WHERE id=?`).bind(id).first<{ product_item_id: string; qty: number; status: string }>();
  if (!m) return c.json({ error: 'mps order not found' }, 404);
  if (m.status === 'converted') return c.json({ error: 'already converted' }, 400);
  const f = await db.prepare(`SELECT id, base_qty FROM formula WHERE product_item_id=? AND status='approved' ORDER BY version DESC LIMIT 1`).bind(m.product_item_id).first<{ id: string; base_qty: number }>();
  if (!f) return c.json({ error: 'no approved formula for this product' }, 400);
  const woId = uid();
  const scale = m.qty / f.base_qty;
  const uomId = (await db.prepare(`SELECT base_uom_id id FROM formula WHERE id=?`).bind(f.id).first<{ id: string }>())?.id;
  await db.batch([
    db.prepare(`INSERT INTO work_order (id,formula_id,product_item_id,planned_qty,uom_id,scale_factor,status,mps_order_ref) VALUES (?,?,?,?,?,?, 'planned', ?)`).bind(woId, f.id, m.product_item_id, m.qty, uomId, scale, id),
    db.prepare(`UPDATE mps_order SET status='converted', work_order_id=? WHERE id=?`).bind(woId, id),
  ]);
  return c.json({ work_order_id: woId });
});

// API 404 fallback (static assets are handled by the [assets] binding).
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

export default app;
