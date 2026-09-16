# Chemical Manufacturing ERP — Process Research & Project Plan

## Context

We are building an ERP for a chemical manufacturing plant with full control over
**Inventory, Production, R&D/Formulation, Quality & Compliance, Planning, Sales &
Procurement, and Finance**. The goal of *this* phase is **not to write code** — it is to
(1) get the real-world **Production** and **QC** processes right, and (2) turn that
understanding into a system design and a phased build plan.

Everything downstream (schema, screens, permissions, reports) should fall out of how the
plant *actually operates*, not from a feature checklist. Get the process model right and the
software becomes "the best a chemical plant ever had"; get it wrong and it's just another
data-entry tool.

**Decisions locked so far:**
- Platform: **Desktop application** + **Cloudflare** backend, source on **GitHub**
- Deployment: **Hybrid** (cloud core + on-prem/shop-floor & mobile warehouse, offline-tolerant)
- Regulatory bar: **ISO / industrial** — strong traceability, lot genealogy, and COAs; audit
  trails on quality-critical records, but *not* pharma-grade e-signature/validation rigor.
  (Design so rigor *can* be turned up later without a rewrite.)
- Finance: **build a full GL in-house** (native GL/AP/AR/contra/trial balance/cash flow/aging),
  with connectors to external packages as an *export* convenience, not the source of truth.
- This session's output: **process research + full project plan** (no code yet)
- Processes mapped so far: **Production**, **QC**, **Inventory/Warehouse**.

---

## PART 1 — The Production Process (real-world → system)

Chemical production is *batch/recipe* manufacturing: you follow a formula to make a defined
quantity (a **batch/lot**), and everything is traced to that lot number. The definitive record
of "how this batch was actually made" is the **Batch Manufacturing Record (BMR)** — the heart
of the whole system.

### 1.1 The end-to-end flow

| # | Stage | What actually happens on the floor | What the system must do |
|---|-------|-----------------------------------|-------------------------|
| 1 | **Formula / Master Batch Record (MBR)** | R&D approves a formula: ingredients, %/qty, processing steps (heat, stir, pH, time), IPC checkpoints, expected yield | Store an approved, **versioned** MBR (recipe + routing + IPC specs). This is the template every batch is cloned from |
| 2 | **Production/Work Order** | Planning decides "make 500 kg of Product X on Reactor 2, Thursday" | Create work order from MBR; **batch sizing** (scale the recipe up/down); reserve equipment, honor capacity, changeover, cleaning |
| 3 | **Material reservation / hard allocation** | Specific raw-material **lots** are earmarked for this batch | Reserve/hard-allocate lots (FEFO/expiry aware); block them from other orders; check lots are QC-**Released** |
| 4 | **Weighing & Dispensing** | Operator weighs each raw material per the BMR quantity, labels & stages it | Scan lot → verify identity, lot #, QC status, expiry; capture **actual weight** (scale integration); record who/when; enforce tolerance |
| 5 | **Charging** | Materials added to reactor/vessel in the specified order | Confirm each charge against BMR sequence; record actuals, deviations |
| 6 | **Processing / Reaction** | Control temp, pressure, pH, mix speed, time per step | Record process parameters (manual or from equipment); step-by-step sign-off; timers |
| 7 | **In-Process Control (IPC)** | QC/operator pulls samples mid-batch (viscosity, pH, assay) and checks vs. spec | Trigger IPC tests → link to QC module; **hold** the batch until IPC passes |
| 8 | **WIP / intermediates** | Semi-finished material may be stored, split, or fed to the next step | Track **WIP** as its own lot; parent/child lot genealogy |
| 9 | **Packaging & Labeling** | Bulk filled into drums/totes/bags; labels link back to source lots (incl. GHS/HAZMAT) | Packaging run tied to batch; generate labels; consume packaging materials (costed separately from formula) |
| 10 | **Yield & batch costing** | Compare actual output vs. expected; capture real material, labor, machine, waste costs | **Yield calc** (incl. by-products/co-products & waste); roll up **actual batch cost** vs. standard |
| 11 | **Finished-goods QC & release** | Final sample tested; batch dispositioned | Finished-goods inspection → QC release moves lot to sellable stock (see Part 2) |
| 12 | **Batch record review & close** | Supervisor reviews the full BMR, deviations resolved, batch closed | Review/approve workflow; lock the record; post inventory & cost to Finance |

### 1.2 Key production concepts the system must model natively
- **Batch/lot as the atomic unit** — every quantity of material carries a lot with full genealogy (which raw lots → which batch → which finished lot → which customer). This is what enables **speedy recalls** (bi-directional traceability).
- **Deviations** — reality diverges from the MBR (substituted a lot, off-spec temp, short yield). Deviations must be captured, reason-coded, and reviewed, not hidden.
- **Substitution & scaling** — allow approved material substitution and batch resizing without breaking traceability or cost.
- **By-products / co-products / waste** — a batch can yield more than the target product; each needs its own lot, valuation, and (for waste) disposal tracking.
- **Actual vs. standard costing** — separate **formula cost** from **packaging cost**; capture actual labor/machine/waste per batch.

---

## PART 2 — The Quality Control Process (real-world → system)

QA vs QC: **QA** = the system/processes that *prevent* defects (specs, SOPs, approvals);
**QC** = the *testing* that catches defects (sampling, lab tests, disposition). The software
must run both, but the daily engine is the **QC sample lifecycle** and the **specification vs.
result** comparison that produces a **Certificate of Analysis (COA)**.

### 2.1 The QC lifecycle (the state machine at the core of the system)

Every material — incoming raw, in-process, finished — moves through the same status machine:

```
                 ┌─────────────┐
  Goods receipt →│ QUARANTINE  │← batch produced / IPC sample
   / batch step  │  (on hold)  │
                 └──────┬──────┘
                        │ sample pulled, tests run vs. SPEC
             ┌──────────┼───────────┐
             ▼          ▼           ▼
        ┌─────────┐ ┌────────┐  ┌────────────┐
        │RELEASED │ │REJECTED│  │  ON HOLD / │
        │(usable) │ │        │  │ OOS → invest.│
        └─────────┘ └────────┘  └─────┬──────┘
                                       │ investigation (OOS/OOT)
                                       ▼
                            retest / rework / reclaim / scrap
```

**Statuses:** Pending → Quarantine → (Released | Rejected | Rework/Reclaim | Scrapped).
**Quarantine reason codes:** supplier quality, identity mismatch, OOS/OOT, IPC fail,
labeling fail, environmental excursion, expiry risk.

### 2.2 The three QC gates (same engine, three trigger points)

1. **Incoming / Receiving QC** — On goods receipt, raw material lands in **Quarantine**. QC verifies supplier COA, labeling, identity test, and runs the **sampling plan** (sized to risk). Only **Released** lots can be reserved/charged into production.
2. **In-Process QC (IPC)** — Mid-batch samples per the MBR's IPC checkpoints; batch is held until pass. OOS pauses/fails the step.
3. **Finished-Goods QC** — Final testing against the product spec → produces the **COA**; only then does the batch become sellable.

### 2.3 Spec, result, disposition (the data model of QC)
- A **Specification** = the set of test parameters for a material/product, each with a method + acceptance criteria (range, limit, or identity criterion).
- A **Sample** is pulled and one or more **Tests** run; each test yields a **Result**.
- **Pass/fail** = result vs. spec limit. If any result is outside spec → **Out-Of-Spec (OOS)**; drift within spec but atypical → **Out-Of-Trend (OOT)**.
- **OOS/OOT investigation**: Phase-1 confirms data integrity (sample ID, instrument, calc, audit trail) *before* any retest; retest only with a documented assignable cause per SOP.
- **COA** = the released evidence package: for each parameter, the spec + the actual result + conform/not-conform, issued per lot for customer/regulatory use.

### 2.4 Compliance & EHS (wraps around QC)
- **GHS / SDS** authoring (LISAM-style integration), **HAZMAT** bills of lading, **VOC**, **SARA Tier I/II/III** reporting.
- **Waste & disposal** tracking (tie to by-products/waste lots from production).
- **Worker & end-user safety** — exposure/handling data surfaced at dispensing and packaging.

---

## PART 2.5 — The Inventory / Warehouse Process (real-world → system)

Inventory is the **traceability base** every other module reads and writes. In a chemical plant
the golden rule: **you never hold "material X" — you hold a specific lot of X, in a specific
bin, with a specific QC status, in a specific UOM.** Every movement is a scan that keeps the
digital record in sync with the physical reality.

### 2.5.1 The end-to-end warehouse flow

| # | Stage | What actually happens | What the system must do |
|---|-------|----------------------|-------------------------|
| 1 | **Receiving** | Truck arrives against a PO; operator scans supplier lot #, counts, checks packaging/SDS | Receipt vs. PO; create internal **lot** + license-plate (LPN) label; land it in **Quarantine** (hands off to incoming QC) |
| 2 | **Putaway** | Move received pallet to a storage bin | Suggest bin by rules: **hazard/SDS compatibility**, temperature class, capacity, lot mix; record bin |
| 3 | **Storage / bin mgmt** | Material sits in racks/tanks/drums by zone | Bin & zone topology; segregation of incompatible chemicals; capacity & fill tracking |
| 4 | **Reservation / allocation** | Lots earmarked for a batch or a customer order | Hard-allocate specific lots (**FEFO** by expiry, else FIFO); block double-use; require QC:Released |
| 5 | **Picking / issue to production** | Operator pulls the exact lot from the exact bin for a batch | **Lot-directed picking**: scanner shows bin + lot + qty; decrement on scan; feed the BMR (Part 1, step 4) |
| 6 | **Internal moves & UOM conversion** | Bulk drum split into smaller containers; kg ↔ L ↔ drums | **Multiple UOM** with conversions; splitting/merging lots keeps genealogy |
| 7 | **WIP / finished-goods receipt** | Batch output booked back into stock | Create WIP/finished **lot** with parent linkage; land in Quarantine → finished-goods QC |
| 8 | **Cycle & physical count** | Ongoing risk-based counts + periodic full count | **Cycle counting** by lot (verify expiry), blind counts, **reason-coded** adjustments; freeze/recount |
| 9 | **Shipping** | Finished lots picked & loaded for a customer | Pick by lot; attach **COA + HAZMAT/GHS** docs; record customer↔lot link for recall |

### 2.5.2 Inventory concepts the system must model natively
- **Lot + LPN + bin + UOM + QC status** on every quantity — the five attributes that make a
  balance meaningful. A quantity with no lot/QC status is not usable.
- **Bi-directional traceability & serialization** — from supplier lot → batch → finished lot →
  customer, and back. This is what powers **speedy recalls**.
- **FEFO / expiry** enforcement for shelf-life-limited chemicals.
- **Hazard-aware storage** — bins carry compatibility rules; the system blocks illegal
  co-location (SDS/GHS classes).
- **Multiple UOM with conversions** — purchasing UOM ≠ storage UOM ≠ recipe UOM.
- **Mobile, scan-driven, offline-tolerant** — receiving/putaway/pick/count must work on a
  handheld even if the network drops, then sync (this is why the desktop app is offline-first).
- **Real-time balances** — every movement posts immediately so Planning and Finance see truth.

---

## PART 3 — How Production, QC and Inventory connect (the spine of the system)

The two processes share one backbone. The **lot** and its **QC status** gate every material
movement:

```
 R&D formula (MBR, versioned)
        │ approve
        ▼
 Planning → Work/Production Order ── reserves ──► Raw-material LOTS (must be QC:Released)
        │                                              ▲
        ▼                                              │ incoming QC gate
   BATCH executes (weigh→charge→process)          [Quarantine→Release]
        │  IPC samples ─────────────► QC (in-process gate)
        ▼
   WIP / intermediate LOTS ──► Packaging ──► Finished LOT
        │                                        │ finished-goods QC gate
        ▼                                        ▼  COA issued
   Yield + actual cost ──► FINANCE          Sellable stock ──► Sales/Shipping
        │  by-products/waste ──► EHS/Waste                       │
        └──────────────────► GL / AP / AR ◄──────────────────────┘
```

**Core shared entities** (the first schema to design):
`Material/Item`, `Lot` (+ genealogy links), `Location/Bin`, `UOM` (+ conversions),
`Specification` / `Test` / `Result` / `COA`, `Formula/MBR` (+ version), `WorkOrder`,
`Batch/BMR` (+ steps, deviations), `PurchaseOrder`, `SalesOrder`, `Partner`
(supplier/customer), `GL Account` / `Journal Entry`.

---

## PART 4 — Technical architecture (desktop + Cloudflare + GitHub, hybrid)

- **Backend on Cloudflare:** Cloudflare **Workers** for the API, **D1** (SQLite) or an
  external Postgres for relational data, **R2** for documents/COAs/SDS/label PDFs, **Queues**
  for async (report generation, integrations), **Access** for auth/SSO. (During research phase
  we only *name* these; final choice confirmed before Phase 0 build.)
- **Desktop app (hybrid/offline-tolerant):** a cross-platform desktop client (candidate:
  **Tauri** — Rust core + web UI, small footprint, good for plant PCs; alt: Electron). Local
  cache/DB so weighing, dispensing, and warehouse scanning keep working if the network drops,
  then **sync** to Cloudflare when back online. This is essential for shop-floor & mobile
  warehouse use.
- **Sync model:** offline-first local store → change queue → reconcile with server
  (lots, batch steps, counts are the offline-critical entities).
- **Source control:** GitHub monorepo (`/backend` Workers, `/desktop` app, `/shared` types &
  schema, `/docs` this process model). CI on GitHub Actions.
- **Integrations (later phases):** Finance connectors (Tally, QuickBooks, SAP, MAS 90/100,
  Navision), LISAM for GHS/SDS, scale/instrument capture.

> Note: the **desktop + Cloudflare-only** combo needs one design decision early — whether the
> relational store is Cloudflare **D1** vs. an external **Postgres** (Neon/Supabase) fronted by
> Workers. This affects offline sync and reporting. Flagged in "Open Questions."

---

## PART 5 — Phased project plan (build order)

Build **Inventory + QC + Production** first — they are the traceability spine everything else
references. Sales/Procurement, then Finance, then Planning/EHS layer on.

- **Phase 0 — Foundations** (repo, CI, auth, core schema: Item/Lot/UOM/Location, offline-sync skeleton, desktop shell)
- **Phase 1 — Inventory & Traceability** (lots + genealogy, bins, multi-UOM, physical/cycle count, mobile warehouse scan, serialization)
- **Phase 2 — Quality/QC engine** (specs/tests/results, the quarantine→release state machine, incoming QC gate, COA generation)
- **Phase 3 — R&D / Formulation** (versioned formulas/MBR, formula vs. packaging costing, substitution rules, patent/security controls)
- **Phase 4 — Production** (work orders, batch sizing, BMR execution: weigh→charge→process, IPC gate, WIP, yield, actual batch costing, by-products/waste)
- **Phase 5 — Planning** (MPS dashboard, material & capacity planning, changeovers/maintenance, MPS→production order)
- **Phase 6 — Sales & Procurement** (vendor/customer mgmt, quote-to-receipt, sales orders, allocation, shipping w/ COA & HAZMAT docs)
- **Phase 7 — Finance (full in-house GL)** (GL, AP, AR, contra, trial balance, cash flow, partner aging; batch actuals & inventory movements auto-post here; export connectors to Tally/QuickBooks/SAP as a convenience, not the source of truth)
- **Phase 8 — Compliance/EHS & recalls** (GHS/SDS/LISAM, HAZMAT BOL, VOC, SARA reports, waste/disposal, recall simulation)

Each phase = a runnable slice with its own schema, desktop screens, tests, and a demo.

---

## Deliverable of THIS phase

A **process-and-design document** (this plan, expanded into `/docs` in the repo) covering:
1. Production process map (Part 1) + QC process map (Part 2) — done above, to be reviewed with
   plant SMEs.
2. Core shared data model (Part 3) — first ERD.
3. Architecture decision record for desktop + Cloudflare + offline sync (Part 4).
4. Phased roadmap (Part 5).

No production code is written until this is validated.

## Verification / next steps
- **Walk Part 1 & Part 2 past a real plant operator + QC lead** — the acid test is whether a
  supervisor recognizes their own day in the flow. Adjust reason codes, IPC points, and
  disposition paths to the actual SOPs.
- Turn "Core shared entities" into a first **ERD** and review before any table is built.
- Resolve the **D1-vs-Postgres** and **Tauri-vs-Electron** decisions (ADR) before Phase 0.

## Resolved decisions
- **Regulatory bar:** ISO / industrial (strong traceability + COAs + audit trails on
  quality-critical records; not pharma e-signature/validation rigor — but architected to raise).
- **Finance:** full in-house GL is the source of truth; external packages are export targets.

## Open questions still to resolve before building
1. **Relational store on Cloudflare:** D1 vs. external Postgres (drives offline sync & reporting).
2. **Desktop framework:** Tauri vs. Electron.
3. **Number of plants/sites** and whether inventory is multi-site from day one.
4. Remaining processes to map before Phase 0: **R&D/Formulation, Planning/MPS,
   Sales & Procurement, EHS/Compliance** (Inventory now mapped — see Part 2.5).

## Sources
- [BatchMaster – Batch Production](https://www.batchmaster.com/batch-production/)
- [SYSPRO – Batch Manufacturing Software](https://us.syspro.com/business-software/manufacturing-types/batch-manufacturing/)
- [CertiPro – How Chemical ERP Streamlines Batch Manufacturing](https://certipro.com/blog/how-chemical-erp-software-streamlines-batch-manufacturing/)
- [SimplerQMS – Batch Manufacturing Record (BMR)](https://simplerqms.com/batch-manufacturing-record/)
- [PharmaGMPGuide – Raw Material Dispensing SOP](https://pharmagmpguide.com/raw-material-dispensing-sop-in-pharma/)
- [SG Systems – Quarantine / Quality Hold Status](https://sgsystemsglobal.com/glossary/quarantine-quality-hold-status/)
- [SG Systems – QC Testing & Release Evidence](https://sgsystemsglobal.com/glossary/quality-control-qc-testing-release-evidence/)
- [Contract Laboratory – What Is a Certificate of Analysis (COA)?](https://contractlaboratory.com/certificate-of-analysis-coa-understanding-its-importance-and-key-components/)
- [Alliance Chemical – How to Read a Chemical COA](https://alliancechemical.com/blogs/articles/how-to-read-a-chemical-certificate-of-analysis-coa)
- [TÜV SÜD – QA/QC for Chemical Process Plants](https://www.tuvsud.com/en-us/industries/chemical-and-process/process-safety/quality-assurance-and-quality-control)
- [SG Systems – Warehouse Management System (WMS)](https://sgsystemsglobal.com/glossary/warehouse-management-system-wms/)
- [SG Systems – Warehouse Locations: Bin & Zone Topology](https://sgsystemsglobal.com/glossary/warehouse-locations-bin-zone-topology/)
- [ASC Software – Complete Guide to FEFO Inventory Management](https://ascsoftware.com/blog/fefo-inventory-management-guide/)
- [CyberStockroom – Managing Chemical & Hazardous Raw Material Inventory](https://blog.cyberstockroom.com/2026/05/28/managing-chemical-and-hazardous-raw-material-inventory-in-manufacturing-plants/comment-page-1/)
