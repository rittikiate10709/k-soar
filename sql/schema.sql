-- =====================================================================
--  SMART TOPOLOGY — MySQL schema สำหรับเก็บ log การ monitor
--  รองรับ MySQL 5.7+, MySQL 8.x และ MariaDB 10.4+
--
--  วิธีที่ 1 (อัตโนมัติ): หน้า ตั้งค่า → ฐานข้อมูล MySQL → “สร้างฐานข้อมูลและตาราง”
--  วิธีที่ 2 (ด้วยมือ):   mysql -u root -p < sql/schema.sql
--  ถ้าใช้ชื่อฐานข้อมูลอื่น ให้แก้ smart_topology ใน 2 บรรทัดด้านล่าง
-- =====================================================================

CREATE DATABASE IF NOT EXISTS smart_topology
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE smart_topology;

-- ---------------------------------------------------------------------
-- 1) ทะเบียนอุปกรณ์ (ระบบซิงก์ให้อัตโนมัติ ใช้ JOIN ชื่ออุปกรณ์ในรายงาน)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_device (
  device_id    INT UNSIGNED      NOT NULL,
  code         VARCHAR(40)       NULL,
  name         VARCHAR(120)      NOT NULL,
  ip           VARCHAR(253)      NOT NULL,
  method       VARCHAR(8)        NOT NULL DEFAULT 'icmp'  COMMENT 'icmp | tcp',
  port         SMALLINT UNSIGNED NULL,
  type         VARCHAR(20)       NULL      COMMENT 'switch, router, server, ...',
  vendor       VARCHAR(40)       NULL,
  model        VARCHAR(120)      NULL,
  location     VARCHAR(160)      NULL,
  vlan         VARCHAR(20)       NULL,
  parent_id    INT UNSIGNED      NULL      COMMENT 'Uplink',
  is_critical  TINYINT(1)        NOT NULL DEFAULT 0,
  is_deleted   TINYINT(1)        NOT NULL DEFAULT 0  COMMENT '1 = ถูกลบออกจากระบบแล้ว (เก็บไว้ให้รายงานย้อนหลัง)',
  updated_at   DATETIME          NOT NULL,
  PRIMARY KEY (device_id),
  KEY idx_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ทะเบียนอุปกรณ์ที่ monitor';

-- ---------------------------------------------------------------------
-- 2) Log ดิบ: 1 แถว = การตรวจ 1 ครั้ง (ข้อมูลเยอะที่สุด ลบอัตโนมัติตามจำนวนวันที่ตั้งไว้)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_check_log (
  id           BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  device_id    INT UNSIGNED      NOT NULL,
  checked_at   DATETIME(3)       NOT NULL,
  status       VARCHAR(12)       NOT NULL  COMMENT 'online | warning | offline',
  success      TINYINT(1)        NOT NULL  COMMENT '1 = ตอบสนอง, 0 = ไม่ตอบ (loss)',
  latency_ms   DECIMAL(10,2)     NULL,
  PRIMARY KEY (id),
  KEY idx_time (checked_at),
  KEY idx_dev_time (device_id, checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ผลการตรวจทุกครั้ง (raw log)';

-- ---------------------------------------------------------------------
-- 3) สรุปราย 5 นาที ต่ออุปกรณ์ (ใช้กราฟรายวัน)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_stats_5min (
  device_id    INT UNSIGNED      NOT NULL,
  bucket       DATETIME          NOT NULL  COMMENT 'เวลาเริ่มช่วง 5 นาที',
  checks       INT UNSIGNED      NOT NULL DEFAULT 0  COMMENT 'จำนวนครั้งที่ตรวจ',
  ok_count     INT UNSIGNED      NOT NULL DEFAULT 0  COMMENT 'ตอบสนอง',
  lost_count   INT UNSIGNED      NOT NULL DEFAULT 0  COMMENT 'ไม่ตอบสนอง (packet loss)',
  down_count   INT UNSIGNED      NOT NULL DEFAULT 0  COMMENT 'ครั้งที่สถานะ = offline',
  warn_count   INT UNSIGNED      NOT NULL DEFAULT 0  COMMENT 'ครั้งที่ latency เกินเกณฑ์',
  down_sec     INT UNSIGNED      NOT NULL DEFAULT 0  COMMENT 'วินาทีที่ offline (ประมาณ)',
  sum_latency  DOUBLE            NOT NULL DEFAULT 0  COMMENT 'ผลรวม latency (หาร ok_count = ค่าเฉลี่ย)',
  min_latency  DECIMAL(10,2)     NULL,
  max_latency  DECIMAL(10,2)     NULL,
  PRIMARY KEY (device_id, bucket),
  KEY idx_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='สถิติรวมทุก 5 นาที';

-- ---------------------------------------------------------------------
-- 4) สรุปรายชั่วโมง ต่ออุปกรณ์ (ใช้กราฟรายเดือน / รายปี)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_stats_hourly (
  device_id    INT UNSIGNED      NOT NULL,
  bucket       DATETIME          NOT NULL  COMMENT 'เวลาเริ่มชั่วโมง',
  checks       INT UNSIGNED      NOT NULL DEFAULT 0,
  ok_count     INT UNSIGNED      NOT NULL DEFAULT 0,
  lost_count   INT UNSIGNED      NOT NULL DEFAULT 0,
  down_count   INT UNSIGNED      NOT NULL DEFAULT 0,
  warn_count   INT UNSIGNED      NOT NULL DEFAULT 0,
  down_sec     INT UNSIGNED      NOT NULL DEFAULT 0,
  sum_latency  DOUBLE            NOT NULL DEFAULT 0,
  min_latency  DECIMAL(10,2)     NULL,
  max_latency  DECIMAL(10,2)     NULL,
  PRIMARY KEY (device_id, bucket),
  KEY idx_bucket (bucket)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='สถิติรวมรายชั่วโมง';

-- ---------------------------------------------------------------------
-- 5) เหตุการณ์เปลี่ยนสถานะ (ล่ม / กลับมา / ช้า) พร้อมระยะเวลา
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_event_log (
  id           BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  device_id    INT UNSIGNED      NOT NULL,
  event        VARCHAR(16)       NOT NULL  COMMENT 'down | up | slow | normal | maintenance',
  from_status  VARCHAR(12)       NULL,
  to_status    VARCHAR(12)       NOT NULL,
  started_at   DATETIME(3)       NOT NULL  COMMENT 'เวลาที่สถานะก่อนหน้าเริ่ม (event=up คือเวลาที่เริ่มล่ม)',
  event_at     DATETIME(3)       NOT NULL,
  duration_sec INT UNSIGNED      NULL      COMMENT 'ระยะเวลาของสถานะก่อนหน้า (event=up คือเวลาที่ล่ม)',
  latency_ms   DECIMAL(10,2)     NULL,
  PRIMARY KEY (id),
  KEY idx_time (event_at),
  KEY idx_dev_time (device_id, event_at),
  KEY idx_event_time (event, event_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='เหตุการณ์เปลี่ยนสถานะ';

-- ---------------------------------------------------------------------
-- 6) ประวัติการตรวจฐานข้อมูล Master / Slave (Replication)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_dbsync_log (
  id           BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  checked_at   DATETIME(3)       NOT NULL,
  status       VARCHAR(12)       NOT NULL  COMMENT 'sync | lag | diff | broken | offline | norepl | warning',
  lag_sec      INT               NULL      COMMENT 'Seconds_Behind_Master',
  master_ms    DECIMAL(10,2)     NULL      COMMENT 'เวลาตอบสนองของ Master',
  slave_ms     DECIMAL(10,2)     NULL      COMMENT 'เวลาตอบสนองของ Slave',
  gap_bytes    BIGINT            NULL      COMMENT 'binlog position ที่ Slave ยังตามไม่ทัน',
  diff_count   INT               NOT NULL DEFAULT 0  COMMENT 'จำนวน Query ที่ผลไม่ตรงกัน',
  detail       TEXT              NULL      COMMENT 'รายละเอียดปัญหา',
  PRIMARY KEY (id),
  KEY idx_time (checked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ประวัติการตรวจ Replication Master/Slave';

-- ---------------------------------------------------------------------
-- 7) ประวัติการเปลี่ยนแปลงทะเบียนเครื่องคอมพิวเตอร์ (Agent / กรอกเอง)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nms_asset_change (
  id           BIGINT UNSIGNED   NOT NULL  COMMENT 'เลขที่รายการ (ตรงกับ inventory.json)',
  changed_at   DATETIME(3)       NOT NULL,
  asset_id     INT UNSIGNED      NOT NULL,
  hostname     VARCHAR(100)      NOT NULL,
  department   VARCHAR(100)      NULL,
  category     VARCHAR(12)       NOT NULL  COMMENT 'new | os | hardware | network | software | firmware | info | removed',
  field        VARCHAR(40)       NOT NULL,
  label        VARCHAR(100)      NOT NULL,
  old_value    VARCHAR(1000)     NULL,
  new_value    VARCHAR(1000)     NULL,
  changed_by   VARCHAR(100)      NULL,
  PRIMARY KEY (id),
  KEY idx_time (changed_at),
  KEY idx_asset (asset_id, changed_at),
  KEY idx_cat_time (category, changed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='ประวัติการเปลี่ยนแปลงสเปคเครื่องคอมพิวเตอร์';

-- ---------------------------------------------------------------------
-- 8) View สรุปรายวัน (สำหรับ Excel / Power BI / Grafana)
-- ---------------------------------------------------------------------
CREATE OR REPLACE VIEW v_nms_daily AS
SELECT DATE(h.bucket)                                        AS log_date,
       h.device_id,
       d.name                                                AS device_name,
       d.ip,
       d.type,
       d.location,
       SUM(h.checks)                                         AS checks,
       SUM(h.lost_count)                                     AS lost,
       ROUND(100 * SUM(h.lost_count) / NULLIF(SUM(h.checks), 0), 2)                     AS loss_pct,
       ROUND(100 * (SUM(h.checks) - SUM(h.down_count)) / NULLIF(SUM(h.checks), 0), 3)  AS availability_pct,
       SUM(h.down_sec)                                       AS down_sec,
       ROUND(SUM(h.sum_latency) / NULLIF(SUM(h.ok_count), 0), 2)                       AS avg_latency_ms,
       MAX(h.max_latency)                                    AS max_latency_ms
FROM nms_stats_hourly h
LEFT JOIN nms_device d ON d.device_id = h.device_id
GROUP BY DATE(h.bucket), h.device_id, d.name, d.ip, d.type, d.location;
