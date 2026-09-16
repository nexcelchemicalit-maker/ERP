-- Sample data so the dashboard opens in a realistic state. Example data only.

DELETE FROM batch_cost; DELETE FROM deviation; DELETE FROM batch_output; DELETE FROM batch_material;
DELETE FROM batch_step; DELETE FROM batch; DELETE FROM work_order; DELETE FROM equipment;
DELETE FROM packaging_spec; DELETE FROM formula_step; DELETE FROM formula_ingredient; DELETE FROM formula;
DELETE FROM coa_line; DELETE FROM coa; DELETE FROM qc_disposition; DELETE FROM test_result;
DELETE FROM sample; DELETE FROM spec_parameter; DELETE FROM specification;
DELETE FROM count_line; DELETE FROM inventory_count; DELETE FROM reservation;
DELETE FROM stock_movement; DELETE FROM stock; DELETE FROM lot_genealogy; DELETE FROM lot;
DELETE FROM bin; DELETE FROM warehouse; DELETE FROM audit_log; DELETE FROM app_user;
DELETE FROM partner; DELETE FROM item_uom; DELETE FROM item; DELETE FROM uom_conversion; DELETE FROM uom;

-- UOMs
INSERT INTO uom (id,code,name,dimension) VALUES
 ('uom-kg','KG','Kilogram','mass'),
 ('uom-g','G','Gram','mass'),
 ('uom-l','L','Litre','volume'),
 ('uom-drum','DRUM','Drum','count'),
 ('uom-ea','EA','Each','count');

INSERT INTO uom_conversion (id,from_uom_id,to_uom_id,factor,item_id) VALUES
 ('cv-kg-g','uom-kg','uom-g',1000,NULL);

-- Users
INSERT INTO app_user (id,email,name) VALUES
 ('usr-admin','admin@nexcelchemical.org','Plant Admin'),
 ('usr-qc','qc@nexcelchemical.org','QC Analyst');

-- Items (raw chemicals, packaging, a finished product)
INSERT INTO item (id,code,name,item_type,base_uom_id,shelf_life_days,hazard_class,standard_cost) VALUES
 ('itm-caustic','RM-CAUSTIC','Caustic soda flakes','raw','uom-kg',730,'GHS05 Corrosive',42.5),
 ('itm-sulfacid','RM-H2SO4','Sulphuric acid 98%','raw','uom-l',NULL,'GHS05 Corrosive',18.0),
 ('itm-solvent','RM-IPA','Isopropyl alcohol','raw','uom-l',365,'GHS02 Flammable',95.0),
 ('itm-dye','RM-DYE-BLU','Reactive blue dye','raw','uom-kg',540,NULL,310.0),
 ('itm-drum200','PK-DRUM200','HDPE drum 200L','packaging','uom-ea',NULL,NULL,650.0),
 ('itm-water','RM-WATER','Demineralised water','raw','uom-l',NULL,NULL,2.0),
 ('itm-cleaner','FG-CLEAN-IND','Industrial cleaner concentrate','finished','uom-l',365,'GHS07 Irritant',0);

INSERT INTO item_uom (id,item_id,uom_id) VALUES
 ('iu-1','itm-caustic','uom-kg'),('iu-2','itm-caustic','uom-g'),
 ('iu-3','itm-sulfacid','uom-l'),('iu-4','itm-solvent','uom-l'),
 ('iu-5','itm-dye','uom-kg'),('iu-6','itm-drum200','uom-ea'),
 ('iu-7','itm-cleaner','uom-l'),('iu-8','itm-cleaner','uom-drum'),('iu-9','itm-water','uom-l');

-- Partners
INSERT INTO partner (id,code,name,partner_type,tax_id) VALUES
 ('prt-acme','SUP-ACME','Acme Chemicals Pvt Ltd','supplier','27AACCA1234F1Z5'),
 ('prt-solvco','SUP-SOLVCO','SolvCo Distributors','supplier','29AABCS4321K1Z2'),
 ('prt-bharat','CUS-BHARAT','Bharat Textiles Ltd','customer','24AAACB9999M1Z8');

-- Warehouse + bins (hazard-aware)
INSERT INTO warehouse (id,code,name,address) VALUES
 ('wh-main','WH-01','Main store','Plot 14, MIDC Industrial Area');

INSERT INTO bin (id,warehouse_id,code,zone,temp_class,capacity_qty,capacity_uom_id,allowed_hazard_classes) VALUES
 ('bin-a1','wh-main','A-01-01','Raw materials','ambient',5000,'uom-kg','["GHS05 Corrosive"]'),
 ('bin-a2','wh-main','A-01-02','Raw materials','ambient',5000,'uom-l','["GHS05 Corrosive"]'),
 ('bin-f1','wh-main','F-02-01','Flammable store','flammable',2000,'uom-l','["GHS02 Flammable"]'),
 ('bin-q1','wh-main','Q-00-01','Quarantine','ambient',NULL,NULL,NULL),
 ('bin-fg1','wh-main','FG-03-01','Finished goods','ambient',10000,'uom-l',NULL);

-- Lots (mix of released and quarantine)
INSERT INTO lot (id,item_id,lot_no,supplier_lot_no,origin_type,origin_ref_id,mfg_date,expiry_date,qc_status) VALUES
 ('lot-caus-1','itm-caustic','CAUSTIC-2609-01','AC-88231','purchase',NULL,'2026-08-20','2028-08-20','released'),
 ('lot-h2so4-1','itm-sulfacid','H2SO4-2609-01','AC-77120','purchase',NULL,'2026-09-01',NULL,'released'),
 ('lot-ipa-1','itm-solvent','IPA-2609-01','SV-4410','purchase',NULL,'2026-09-05','2027-09-05','quarantine'),
 ('lot-dye-1','itm-dye','DYE-2608-07','AC-55010','purchase',NULL,'2026-07-15','2028-01-15','released');

-- Stock (lot + bin + uom)
INSERT INTO stock (id,lot_id,bin_id,uom_id,qty_on_hand,qty_reserved) VALUES
 ('stk-1','lot-caus-1','bin-a1','uom-kg',1500,200),
 ('stk-2','lot-h2so4-1','bin-a2','uom-l',800,0),
 ('stk-3','lot-ipa-1','bin-q1','uom-l',600,0),
 ('stk-4','lot-dye-1','bin-a1','uom-kg',75,0);

-- Movement ledger (receipts + one internal transfer)
INSERT INTO stock_movement (id,movement_type,lot_id,from_bin_id,to_bin_id,qty,uom_id,ref_type,performed_by) VALUES
 ('mv-1','receipt','lot-caus-1',NULL,'bin-a1',1500,'uom-kg','goods_receipt','usr-admin'),
 ('mv-2','receipt','lot-h2so4-1',NULL,'bin-a2',800,'uom-l','goods_receipt','usr-admin'),
 ('mv-3','receipt','lot-ipa-1',NULL,'bin-q1',600,'uom-l','goods_receipt','usr-admin'),
 ('mv-4','receipt','lot-dye-1',NULL,'bin-a1',75,'uom-kg','goods_receipt','usr-admin');

-- One active reservation against the caustic lot
INSERT INTO reservation (id,lot_id,qty,uom_id,reserved_for_type,reserved_for_id) VALUES
 ('rsv-1','lot-caus-1',200,'uom-kg','work_order','wo-demo-1');

-- Extra QC-released feedstock so a production batch can be dispensed end-to-end
-- (the IPA lot above stays in quarantine to demonstrate the QC flow).
INSERT INTO lot (id,item_id,lot_no,supplier_lot_no,origin_type,mfg_date,expiry_date,qc_status) VALUES
 ('lot-water-1','itm-water','WATER-2609-01',NULL,'opening','2026-09-01',NULL,'released'),
 ('lot-ipa-2','itm-solvent','IPA-2609-02','SV-4411','purchase','2026-09-10','2027-09-10','released');
INSERT INTO stock (id,lot_id,bin_id,uom_id,qty_on_hand,qty_reserved) VALUES
 ('stk-w1','lot-water-1','bin-a2','uom-l',5000,0),
 ('stk-i2','lot-ipa-2','bin-f1','uom-l',400,0);

-- ---------- QC specifications (Phase 2) ----------
INSERT INTO specification (id,item_id,version,status,effective_date,approved_by) VALUES
 ('spec-caustic','itm-caustic',1,'approved','2026-01-01','usr-qc'),
 ('spec-h2so4','itm-sulfacid',1,'approved','2026-01-01','usr-qc'),
 ('spec-ipa','itm-solvent',1,'approved','2026-01-01','usr-qc'),
 ('spec-dye','itm-dye',1,'approved','2026-01-01','usr-qc'),
 ('spec-cleaner','itm-cleaner',1,'approved','2026-01-01','usr-qc');

INSERT INTO spec_parameter (id,spec_id,sequence,test_name,method,result_type,uom_id,lower_limit,upper_limit,target,identity_criterion) VALUES
 -- Caustic soda
 ('sp-caus-1','spec-caustic',1,'Assay (NaOH)','Titration','numeric',NULL,98.0,100.5,99.0,NULL),
 ('sp-caus-2','spec-caustic',2,'Carbonate','Titration','numeric',NULL,NULL,2.0,NULL,NULL),
 ('sp-caus-3','spec-caustic',3,'Appearance','Visual','identity',NULL,NULL,NULL,NULL,'White flakes'),
 -- Sulphuric acid
 ('sp-h2so4-1','spec-h2so4',1,'Assay (H2SO4)','Titration','numeric',NULL,97.0,99.0,98.0,NULL),
 ('sp-h2so4-2','spec-h2so4',2,'Iron (Fe)','ICP','numeric',NULL,NULL,50.0,NULL,NULL),
 -- Isopropyl alcohol
 ('sp-ipa-1','spec-ipa',1,'Purity','GC','numeric',NULL,99.5,100.0,99.8,NULL),
 ('sp-ipa-2','spec-ipa',2,'Water content','Karl Fischer','numeric',NULL,NULL,0.2,NULL,NULL),
 ('sp-ipa-3','spec-ipa',3,'Appearance','Visual','identity',NULL,NULL,NULL,NULL,'Clear colourless liquid'),
 -- Reactive blue dye
 ('sp-dye-1','spec-dye',1,'Dye content','Spectrophotometry','numeric',NULL,95.0,100.0,98.0,NULL),
 ('sp-dye-2','spec-dye',2,'Moisture','Loss on drying','numeric',NULL,NULL,5.0,NULL,NULL),
 -- Finished cleaner
 ('sp-clean-1','spec-cleaner',1,'Active content','Titration','numeric',NULL,28.0,32.0,30.0,NULL),
 ('sp-clean-2','spec-cleaner',2,'pH (1% soln)','pH meter','numeric',NULL,9.0,11.0,10.0,NULL);

-- ---------- Formulation (Phase 3): approved recipe for the finished cleaner ----------
-- Base batch = 1000 L. Ingredients scale linearly with a production order.
INSERT INTO formula (id,product_item_id,version,status,base_qty,base_uom_id,security_level,approved_by,approved_at) VALUES
 ('fm-cleaner','itm-cleaner',1,'approved',1000,'uom-l','restricted','usr-admin','2026-02-01');

INSERT INTO formula_ingredient (id,formula_id,item_id,sequence,qty,uom_id,percentage,substitute_group,is_optional) VALUES
 ('fi-1','fm-cleaner','itm-water',1,830,'uom-l',83.0,NULL,0),
 ('fi-2','fm-cleaner','itm-caustic',2,120,'uom-kg',12.0,NULL,0),
 ('fi-3','fm-cleaner','itm-solvent',3,50,'uom-l',5.0,NULL,0);

INSERT INTO formula_step (id,formula_id,step_no,instruction,param_type,target,tolerance_low,tolerance_high,is_ipc_checkpoint,ipc_spec_parameter_id) VALUES
 ('fs-1','fm-cleaner',1,'Charge demineralised water to reactor',NULL,NULL,NULL,NULL,0,NULL),
 ('fs-2','fm-cleaner',2,'Add caustic soda slowly, maintain below 45 C','temp',40,NULL,45,0,NULL),
 ('fs-3','fm-cleaner',3,'Add isopropyl alcohol and mix',NULL,NULL,NULL,NULL,0,NULL),
 ('fs-4','fm-cleaner',4,'Mix 30 minutes','time',30,25,40,0,NULL),
 ('fs-5','fm-cleaner',5,'IPC: check pH of 1% solution','ph',10,9,11,1,'sp-clean-2');

INSERT INTO packaging_spec (id,formula_id,packaging_item_id,qty_per_base,uom_id) VALUES
 ('pk-1','fm-cleaner','itm-drum200',5,'uom-ea');

-- ---------- Production (Phase 4): equipment ----------
INSERT INTO equipment (id,code,name,equip_type,capacity_qty,capacity_uom_id,status) VALUES
 ('eq-r1','RX-01','Reactor 1 (SS 2 kL)','reactor',2000,'uom-l','available'),
 ('eq-r2','RX-02','Reactor 2 (SS 1 kL)','reactor',1000,'uom-l','available');
