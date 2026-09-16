# Nexcel Chemical ERP — Data Model / ERD (v1: traceability spine)

This is the first concrete schema. It covers the **spine** every module depends on:
Foundations → Inventory → QC → Formulation → Production, plus the light Procurement/Sales
tables so every lot has a traceable **origin** and **destination** (required for recalls).
Planning, full Finance GL, and EHS are modeled later; hook points are noted.

**Conventions**
- Every table has `id` (UUID/primary key), `created_at`, `updated_at`.
- Money as integer minor units (paise/cents) or `DECIMAL(18,4)`; never float.
- Quantities as `DECIMAL(18,6)` (chemical qtys need precision). Every qty carries a `uom_id`.
- Soft-delete via `is_active`/`voided_at` on masters; transactions are never hard-deleted (ISO audit).
- `audit_log` records who/what/when for every quality-critical change (ISO rigor, raise-able later).
- Enums shown as `{...}`; implement as lookup tables or check constraints.

**The golden rule of stock:** a usable quantity is defined by **lot + bin + uom + qc_status**.
The `stock` table is keyed on that; nothing moves without a `stock_movement` row.

---

## Module A — Foundations & Master Data

### uom
| column | type | notes |
|---|---|---|
| id | pk | |
| code | text | e.g. KG, L, DRUM, EA |
| name | text | |
| dimension | enum {mass, volume, count, length} | conversions only valid within a dimension (except item-specific) |

### uom_conversion
| column | type | notes |
|---|---|---|
| id | pk | |
| from_uom_id | fk → uom | |
| to_uom_id | fk → uom | |
| factor | decimal | `qty_to = qty_from * factor` |
| item_id | fk → item (nullable) | item-specific conversion (e.g. 1 DRUM = 200 KG for this item) |

### item  *(material master: raw, intermediate, WIP, finished, packaging, by/co-product, waste)*
| column | type | notes |
|---|---|---|
| id | pk | |
| code | text | unique |
| name | text | |
| item_type | enum {raw, intermediate, wip, finished, packaging, by_product, co_product, waste} | |
| base_uom_id | fk → uom | stock is normalized to this |
| tracking | enum {lot, serial, none} | chemicals ⇒ lot |
| shelf_life_days | int (nullable) | drives expiry/FEFO |
| hazard_class | text (nullable) | GHS/DOT class; feeds bin compatibility |
| sds_ref | text (nullable) | link to SDS doc (R2) — EHS phase expands this |
| default_spec_id | fk → specification (nullable) | which QC spec applies |
| standard_cost | decimal | for standard-vs-actual costing |
| is_active | bool | |

### item_uom  *(which UOMs an item may be transacted in)*
`id, item_id fk, uom_id fk` (unique item+uom).

### partner  *(suppliers & customers — needed for lot origin/destination)*
| column | type | notes |
|---|---|---|
| id | pk | |
| code, name | text | |
| partner_type | enum {supplier, customer, both} | |
| gstin/tax_id, address, contact… | | aging/AR-AP later |
| is_active | bool | |

### equipment  *(reactors, lines — used by production & later planning)*
`id, code, name, equip_type, capacity_qty, capacity_uom_id, status {available, running, maintenance, down}`.

### app_user / role / user_role / permission  *(auth + RBAC)*
- `app_user`: id, email, name, status, last_login (auth via Cloudflare Access/SSO).
- `role`: id, code, name (e.g. Operator, QC Analyst, QC Manager, Warehouse, Planner, Finance, Admin).
- `user_role`: user_id, role_id.
- `permission` / `role_permission`: module + action grants.

### audit_log  *(ISO audit trail — the "raise rigor later" hook)*
`id, entity_table, entity_id, action {create,update,void,status_change}, changed_by fk→app_user, changed_at, before_json, after_json, reason_code (nullable)`.

---

## Module B — Warehouse & Locations

### warehouse
`id, code, name, site_id (nullable — multi-site hook), address`.

### bin  *(zone/bin topology; hazard-aware storage)*
| column | type | notes |
|---|---|---|
| id | pk | |
| warehouse_id | fk | |
| code | text | e.g. A-01-03 |
| zone | text | |
| temp_class | enum {ambient, cold, cool, hazmat, flammable} (nullable) | |
| capacity_qty / capacity_uom_id | | fill tracking |
| allowed_hazard_classes | text[] / json | putaway rule: block incompatible chemicals |
| is_active | bool | |

---

## Module C — Inventory & Traceability  *(the spine)*

### lot  *(the atomic unit — carries QC status)*
| column | type | notes |
|---|---|---|
| id | pk | |
| item_id | fk → item | |
| lot_no | text | internal lot number (unique per item) |
| supplier_lot_no | text (nullable) | as received |
| origin_type | enum {purchase, production, adjustment, opening} | |
| origin_ref_id | uuid (nullable) | goods_receipt_line.id or batch.id |
| mfg_date, expiry_date | date (nullable) | FEFO/expiry |
| qc_status | enum {pending, quarantine, released, rejected, rework, scrapped} | **gates all usage** |
| created_at | ts | |

### lot_genealogy  *(bi-directional traceability → recalls)*
| column | type | notes |
|---|---|---|
| id | pk | |
| parent_lot_id | fk → lot | consumed / source |
| child_lot_id | fk → lot | produced / result |
| batch_id | fk → batch (nullable) | the transform that linked them |
| relationship | enum {consumed_into, produced_from, split, merge, repack} | |

### stock  *(current balance: lot + bin + uom)*
| column | type | notes |
|---|---|---|
| id | pk | |
| lot_id | fk → lot | qc_status read from the lot |
| bin_id | fk → bin | |
| uom_id | fk → uom | storage UOM (converts to item base_uom) |
| qty_on_hand | decimal | |
| qty_reserved | decimal | ≤ on_hand |
| unique (lot_id, bin_id, uom_id) | | one balance row per combination |

*qty_available = qty_on_hand − qty_reserved. Only lots with qc_status=released are pick-eligible.*

### stock_movement  *(every physical change — append-only ledger)*
| column | type | notes |
|---|---|---|
| id | pk | |
| movement_type | enum {receipt, putaway, transfer, issue_to_production, output_from_production, ship, adjustment, count_adjust, scrap} | |
| lot_id | fk → lot | |
| from_bin_id / to_bin_id | fk → bin (nullable) | |
| qty / uom_id | | signed by type |
| ref_type / ref_id | | source doc (goods_receipt, batch, shipment, count…) |
| reason_code | text (nullable) | required for adjustment/scrap |
| performed_by | fk → app_user | |
| performed_at | ts | |

### reservation  *(hard allocation to a batch or sales order — FEFO)*
| column | type | notes |
|---|---|---|
| id | pk | |
| lot_id | fk → lot | specific lot hard-allocated |
| qty / uom_id | | |
| reserved_for_type | enum {work_order, sales_order} | |
| reserved_for_id | uuid | |
| status | enum {active, consumed, released} | |

### inventory_count  /  count_line  *(cycle & physical)*
- `inventory_count`: id, count_type {cycle, physical}, status {open, counting, review, posted}, scheduled_for, created_by.
- `count_line`: id, count_id fk, lot_id fk, bin_id fk, system_qty, counted_qty, variance (computed), reason_code, counted_by.
  Posting a count writes `stock_movement` (count_adjust) rows.

---

## Module D — Quality Control  *(the state-machine engine)*

### specification  *(versioned; what "in-spec" means for an item)*
`id, item_id fk, version int, status {draft, approved, obsolete}, effective_date, approved_by`.
(unique item_id+version)

### spec_parameter  *(one test line in a spec)*
| column | type | notes |
|---|---|---|
| id | pk | |
| spec_id | fk → specification | |
| test_name | text | e.g. Assay, pH, Viscosity, Moisture |
| method | text | test method/SOP ref |
| result_type | enum {numeric, identity, attribute} | |
| uom_id | fk → uom (nullable) | for numeric |
| lower_limit / upper_limit / target | decimal (nullable) | acceptance criteria |
| identity_criterion | text (nullable) | for identity/attribute |

### sample  *(pulled at one of the three gates)*
| column | type | notes |
|---|---|---|
| id | pk | |
| sample_type | enum {incoming, in_process, finished} | which gate |
| lot_id | fk → lot (nullable) | incoming/finished |
| batch_id | fk → batch (nullable) | in_process/finished |
| batch_step_id | fk → batch_step (nullable) | IPC checkpoint |
| spec_id | fk → specification | spec version tested against |
| pulled_by | fk → app_user | |
| pulled_at | ts | |
| status | enum {pending, testing, complete, oos, closed} | |

### test_result
`id, sample_id fk, spec_parameter_id fk, result_value (text/decimal), pass_fail {pass, fail}, is_oos bool, is_oot bool, tested_by fk, tested_at`.

### qc_disposition  *(the release/reject decision)*
| column | type | notes |
|---|---|---|
| id | pk | |
| sample_id | fk → sample | |
| target_lot_id | fk → lot (nullable) | lot whose qc_status this sets |
| decision | enum {released, rejected, rework, scrapped, hold} | drives lot.qc_status |
| reason_code | enum {supplier_quality, identity_mismatch, oos, oot, ipc_fail, labeling_fail, environmental, expiry_risk} (nullable) | |
| investigation_ref | uuid (nullable) | OOS/OOT investigation |
| decided_by | fk → app_user | QC manager |
| decided_at | ts | |

### coa / coa_line  *(released evidence package)*
- `coa`: id, lot_id fk, sample_id fk, coa_no, issued_by fk, issued_at, pdf_ref (R2), conforms bool.
- `coa_line`: id, coa_id fk, parameter_name, spec_text, result_value, conforms bool.

---

## Module E — R&D / Formulation  *(feeds Production)*

### formula  *(versioned recipe = Master Batch Record template)*
| column | type | notes |
|---|---|---|
| id | pk | |
| product_item_id | fk → item | the product this makes |
| version | int | |
| status | enum {draft, approved, obsolete} | only approved → production |
| base_qty / base_uom_id | | the recipe's reference batch size (for scaling) |
| security_level | enum {open, restricted, confidential} | patent/security control |
| approved_by / approved_at | | |

### formula_ingredient  *(recipe lines; formula cost)*
| column | type | notes |
|---|---|---|
| id | pk | |
| formula_id | fk → formula | |
| item_id | fk → item | raw/intermediate |
| qty / uom_id | | at base_qty scale |
| percentage | decimal (nullable) | %-based recipes |
| sequence | int | charge order |
| substitute_group | text (nullable) | approved substitutes share a group |
| is_optional | bool | |

### formula_step  *(routing + IPC checkpoints)*
| column | type | notes |
|---|---|---|
| id | pk | |
| formula_id | fk → formula | |
| step_no | int | |
| instruction | text | "heat to 80°C, stir 30 min" |
| param_type | enum {temp, pressure, ph, time, mix_speed, other} (nullable) | |
| target / tolerance_low / tolerance_high | decimal (nullable) | |
| is_ipc_checkpoint | bool | triggers a QC in_process sample |
| ipc_spec_parameter_id | fk → spec_parameter (nullable) | what to test |

### packaging_spec  *(packaging costed separately from formula)*
`id, formula_id fk, packaging_item_id fk → item(type=packaging), qty_per_base, uom_id`.

---

## Module F — Production  *(BMR execution)*

### work_order
| column | type | notes |
|---|---|---|
| id | pk | |
| formula_id | fk → formula | pinned version |
| product_item_id | fk → item | |
| planned_qty / uom_id | | |
| scale_factor | decimal | planned_qty ÷ formula.base_qty |
| equipment_id | fk → equipment (nullable) | |
| status | enum {planned, released, in_progress, completed, closed, cancelled} | |
| planned_start / planned_end | ts | |
| mps_order_ref | uuid (nullable) | Planning phase hook |

### batch  *(the BMR instance)*
| column | type | notes |
|---|---|---|
| id | pk | |
| work_order_id | fk → work_order | |
| batch_no | text | |
| actual_qty / uom_id | | |
| status | enum {planned, in_progress, on_hold, completed, rejected, closed} | on_hold when IPC/QC pending |
| started_at / completed_at | ts | |
| reviewed_by / closed_at | | batch-record review & lock |

### batch_step  *(actuals vs the formula_step)*
`id, batch_id fk, formula_step_id fk, step_no, actual_param_value, status {pending, done, deviation}, performed_by fk, performed_at, ipc_sample_id fk → sample (nullable)`.

### batch_material  *(planned vs actual consumption; lot-level ⇒ genealogy)*
| column | type | notes |
|---|---|---|
| id | pk | |
| batch_id | fk → batch | |
| item_id | fk → item | |
| lot_id | fk → lot | the actual lot charged (must be qc released) |
| planned_qty / actual_qty / uom_id | | tolerance-checked at dispense |
| is_substitute | bool | approved substitution used |
| dispensed_by | fk → app_user | |

### batch_output  *(products, co/by-products, waste — each its own lot)*
`id, batch_id fk, item_id fk, lot_id fk (created), qty/uom_id, output_type {product, co_product, by_product, waste}`.

### deviation
`id, batch_id fk, batch_step_id fk (nullable), reason_code, description, severity {minor, major, critical}, raised_by fk, resolution, status {open, resolved, closed}, resolved_by`.

### batch_cost  *(actual vs standard; formula vs packaging split)*
`id, batch_id fk, material_cost, packaging_cost, labor_cost, machine_cost, waste_cost, actual_total, standard_total, variance`. Posts to Finance on batch close.

---

## Module G — Procurement & Sales  *(minimal: gives every lot an origin & destination)*

### purchase_order / po_line
- `purchase_order`: id, po_no, supplier_id fk → partner, status {open, partial, received, closed}, order_date.
- `po_line`: id, po_id fk, item_id fk, qty/uom_id, unit_price, received_qty.

### goods_receipt / goods_receipt_line  *(creates lots in QUARANTINE → incoming QC)*
- `goods_receipt`: id, gr_no, po_id fk, supplier_id fk, received_by fk, received_at.
- `goods_receipt_line`: id, gr_id fk, po_line_id fk, item_id fk, lot_id fk (created), qty/uom_id, supplier_lot_no, bin_id (putaway).
  ⇒ creates `lot` (qc_status=quarantine) + `stock` + `stock_movement(receipt)`.

### sales_order / so_line
- `sales_order`: id, so_no, customer_id fk → partner, status {open, allocated, shipped, closed}, order_date.
- `so_line`: id, so_id fk, item_id fk, qty/uom_id, unit_price.

### shipment / shipment_line  *(links finished lot → customer for recall)*
- `shipment`: id, ship_no, so_id fk, customer_id fk, shipped_by fk, shipped_at, coa_ref, hazmat_bol_ref.
- `shipment_line`: id, shipment_id fk, so_line_id fk, lot_id fk (the finished lot), qty/uom_id.
  ⇒ `stock_movement(ship)`; customer↔lot recorded via customer_id + lot_id.

---

## Key relationships (cardinality summary)
- item 1─N lot ; item 1─N specification(version) ; item 1─N formula(version)
- lot 1─N stock (across bins) ; lot 1─N stock_movement ; lot ↔ lot via lot_genealogy (M─N)
- formula 1─N formula_ingredient / formula_step / packaging_spec
- work_order 1─N batch ; batch 1─N batch_step / batch_material / batch_output / deviation ; batch 1─1 batch_cost
- specification 1─N spec_parameter ; sample 1─N test_result ; sample 1─N qc_disposition ; lot 1─N coa
- goods_receipt_line 1─1 lot (origin) ; shipment_line N─1 lot (destination)

## Recall query (why this model exists)
*Forward* (supplier lot → customers): `supplier lot → lot → lot_genealogy(child) → batch → batch_output.lot → shipment_line → customer`.
*Backward* (bad finished lot → source raws): `finished lot → lot_genealogy(parent) → batch_material.lot → goods_receipt_line → supplier lot`.

## Open modeling questions
1. **Multi-site now or later?** `warehouse.site_id` is a hook; if multi-site from day 1, add `site` and scope lots/stock/counts by site.
2. **Serial vs lot** — chemicals are lot-tracked; keep `serial` enum value but defer serial tables.
3. **Finance depth** — this v1 stops at `batch_cost` + partner refs. Full GL (journal, accounts, AP/AR) is Phase 7; add `journal_entry`/`gl_account` then, posting from stock_movement + batch_cost + goods_receipt + shipment.
4. **UOM conversion precision/rounding policy** — define once, centrally.
