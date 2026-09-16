-- Sample data so the dashboard opens in a realistic state. Example data only.

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
 ('itm-cleaner','FG-CLEAN-IND','Industrial cleaner concentrate','finished','uom-l',365,'GHS07 Irritant',0);

INSERT INTO item_uom (id,item_id,uom_id) VALUES
 ('iu-1','itm-caustic','uom-kg'),('iu-2','itm-caustic','uom-g'),
 ('iu-3','itm-sulfacid','uom-l'),('iu-4','itm-solvent','uom-l'),
 ('iu-5','itm-dye','uom-kg'),('iu-6','itm-drum200','uom-ea'),
 ('iu-7','itm-cleaner','uom-l'),('iu-8','itm-cleaner','uom-drum');

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
