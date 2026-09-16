# Nexcel Chemical ERP

ERP for Nexcel Chemical — full control over Inventory, Production, R&D/Formulation, Quality &
Compliance, Planning, Sales & Procurement, and Finance.

- **Backend:** Cloudflare Workers + D1 (SQLite at the edge). Online-only.
- **Client:** Web dashboard now; desktop app later.
- **Source:** this repo (`nexcelchemicalit-maker/ERP`).

See `docs/` for the process research, the full data model (ERD), and the phased roadmap.

## Status — Phases 1–4 complete

- **Phase 1 — Foundations + Inventory:** master data (items, UOMs, partners, warehouses/bins)
  and the traceability spine (lots with QC status, stock by lot+bin+uom, movement ledger, goods
  receipt, transfers, adjustments).
- **Phase 2 — Quality Control:** versioned specs + parameters, sample lifecycle (pull → enter
  results with automatic spec evaluation / OOS flag → disposition), lot release/reject, and
  automatic COA generation.
- **Phase 3 — R&D / Formulation:** versioned formulas (ingredients, process steps with IPC
  checkpoints, packaging) with separated material vs packaging costing, and approval.
- **Phase 4 — Production:** work orders from an approved formula (scale factor), batch (BMR)
  execution — dispense released lots, run steps (IPC auto-pulls an in-process QC sample and holds
  the batch), book outputs with lot genealogy, and roll up actual-vs-standard cost; review-lock close.

The full chain works end-to-end: receive → QC release → formula → work order → batch → dispense
→ IPC sample → output lot (quarantine) → finished QC → COA, all traceable via lot genealogy.

## Quick start (local, no Cloudflare account needed)

```bash
cd backend
npm install
npm run db:reset      # create local D1 + apply schema + seed sample data
npm run dev           # http://localhost:8787  (dashboard at /)
```

## Deploy to Cloudflare (needs your Cloudflare login)

```bash
cd backend
npx wrangler login
npx wrangler d1 create nexcel-erp-db        # copy the database_id it prints
# paste that id into wrangler.toml -> database_id
npm run db:migrate:remote
npm run deploy
```

Point `erp.nexcelchemical.org` at the deployed Worker in the Cloudflare dashboard.
