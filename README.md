# Nexcel Chemical ERP

ERP for Nexcel Chemical — full control over Inventory, Production, R&D/Formulation, Quality &
Compliance, Planning, Sales & Procurement, and Finance.

- **Backend:** Cloudflare Workers + D1 (SQLite at the edge). Online-only.
- **Client:** Web dashboard now; desktop app later.
- **Source:** this repo (`nexcelchemicalit-maker/ERP`).

See `docs/` for the process research, the full data model (ERD), and the phased roadmap.

## Status — Phase 1: Foundations + Inventory

Implemented: master data (items, UOMs, partners, warehouses/bins) and the inventory
traceability spine (lots with QC status, stock by lot+bin+uom, movement ledger, goods receipt,
transfers, adjustments, and lot release/reject).

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
