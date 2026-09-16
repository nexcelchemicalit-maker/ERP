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

  const [samplesOpen, oosOpen, coas] = await Promise.all([
    one(`SELECT COUNT(*) n FROM sample WHERE status IN ('pending','testing')`),
    one(`SELECT COUNT(*) n FROM sample WHERE status='oos'`),
    one(`SELECT COUNT(*) n FROM coa`),
  ]);

  return c.json({
    tiles: { items, lots, released, quarantine, rejected, partners, bins, stockLines },
    qc: { samplesOpen, oosOpen, coas },
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

// API 404 fallback (static assets are handled by the [assets] binding).
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

export default app;
