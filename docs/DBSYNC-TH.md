# คู่มือ: เฝ้าระวังและเปรียบเทียบฐานข้อมูล Master / Slave

ฟีเจอร์นี้ใช้ดูแลฐานข้อมูลระบบสารสนเทศโรงพยาบาล (เช่น **HOSxP**) ที่มีเครื่องหลัก (**Master**) และเครื่องสำรอง (**Slave/Replica**) ที่ทำ Replication กันอยู่
ระบบจะตรวจทุกรอบ (ค่าเริ่มต้นทุก 60 วินาที) และแสดงผลในแท็บ **“ฐานข้อมูล Master/Slave”**

| ตรวจอะไร | รายละเอียด |
|---|---|
| การเชื่อมต่อ | ทั้งสองเครื่องตอบสนองหรือไม่, เวลาตอบสนอง (ms), เวอร์ชัน, Uptime, จำนวน connection, Queries/วินาที |
| Replication | IO Thread / SQL Thread, **Replication Delay** (Seconds_Behind_Master), binlog position ที่ยังไม่ได้ apply, GTID, ข้อความ error ล่าสุด |
| การตั้งค่าที่เสี่ยง | Slave ไม่ได้เปิด `read_only`, `server_id` ซ้ำกัน, Master ไม่ได้เปิด binary log |
| **Custom Query** | คำสั่ง SQL ที่ผู้ดูแลกำหนดเอง รันทั้งสองเครื่องแล้วเปรียบเทียบผล เช่น จำนวนผู้มารับบริการวันนี้, VN ล่าสุด |
| ตาราง | ตารางที่ขาดหายในฝั่งใดฝั่งหนึ่ง, จำนวนแถว (ประมาณ / นับจริง), ขนาด |

> ทดสอบแล้วกับ **MariaDB 10.11** ที่ทำ Replication จริง (Master → Slave แบบ GTID) ครบ 5 สถานการณ์: ปกติ, Delay สูง, Replication หยุด, ข้อมูลถูกแก้ที่ Slave และเครื่อง Slave ล่ม
> รองรับคำสั่งของ MySQL 5.7 / 8.0 / 8.4 (`SHOW REPLICA STATUS`, `SHOW BINARY LOG STATUS`) และ MariaDB (`SHOW SLAVE STATUS`) โดยเลือกให้อัตโนมัติ

---

## ขั้นที่ 1: อัปเดตโปรแกรม

เวอร์ชันนี้ต้องใช้ไลบรารี `mysql2` (ติดตั้งครั้งเดียว)
```powershell
cd smart-topology
npm install
node server.js
```
ถ้าใช้ Docker ให้ `docker pull` image ใหม่ แล้วรัน container ใหม่ตามคู่มือ DEPLOY-TH.md

---

## ขั้นที่ 2: สร้างผู้ใช้ฐานข้อมูลแบบ “อ่านอย่างเดียว”

> ⚠️ **ห้ามใช้ root หรือผู้ใช้ของโปรแกรม HOSxP** ให้สร้างผู้ใช้ใหม่ที่อ่านได้อย่างเดียว เพื่อป้องกันความผิดพลาดที่อาจกระทบข้อมูลผู้ป่วย

รันบนเครื่อง **Master** ด้วยสิทธิ์ root ผู้ใช้จะถูก Replicate ไปที่ Slave ให้อัตโนมัติ
(สมมติเครื่อง Smart Topology มี IP `172.16.1.50`)

**MySQL 5.7 / 8.x**
```sql
CREATE USER 'nms_ro'@'172.16.1.50' IDENTIFIED BY 'ตั้งรหัสผ่านที่ปลอดภัย';
GRANT SELECT, PROCESS, REPLICATION CLIENT ON *.* TO 'nms_ro'@'172.16.1.50';
FLUSH PRIVILEGES;
```

**MariaDB 10.5 ขึ้นไป** (สิทธิ์ดูสถานะ Replication แยกเป็น `SLAVE MONITOR`)
```sql
CREATE USER 'nms_ro'@'172.16.1.50' IDENTIFIED BY 'ตั้งรหัสผ่านที่ปลอดภัย';
GRANT SELECT, PROCESS, BINLOG MONITOR, SLAVE MONITOR ON *.* TO 'nms_ro'@'172.16.1.50';
FLUSH PRIVILEGES;
```

| สิทธิ์ | ใช้ทำอะไร |
|---|---|
| `SELECT` | รัน Custom Query และนับแถว |
| `PROCESS` | ดูจำนวน connection / processlist |
| `REPLICATION CLIENT` (MySQL) · `BINLOG MONITOR` (MariaDB) | ดู binlog position ของ Master |
| `REPLICATION CLIENT` (MySQL) · `SLAVE MONITOR` (MariaDB) | ดูสถานะ Replication ของ Slave |

ตรวจสอบว่าผู้ใช้ไปถึง Slave แล้ว (รันบน Slave):
```sql
SELECT user, host FROM mysql.user WHERE user = 'nms_ro';
```
> ถ้า Replication ตั้งค่าแบบไม่รวมฐานข้อมูล `mysql` ให้รันคำสั่งเดียวกันบนเครื่อง Slave ด้วย

---

## ขั้นที่ 3: เปิด Firewall ให้เครื่อง Smart Topology

ทำบน **ทั้งเครื่อง Master และ Slave** (AlmaLinux / Rocky / CentOS):
```bash
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.16.1.50/32" port port="3306" protocol="tcp" accept'
sudo firewall-cmd --reload
```
ทดสอบจากเครื่อง Smart Topology (PowerShell):
```powershell
Test-NetConnection 172.16.1.10 -Port 3306
Test-NetConnection 172.16.1.11 -Port 3306
```

---

## ขั้นที่ 4: ตั้งค่าในหน้าเว็บ

ล็อกอินด้วยบัญชี **admin** → แท็บ **ฐานข้อมูล Master/Slave** → ปุ่ม **ตั้งค่าการเชื่อมต่อ**

### 4.1 ข้อมูลการเชื่อมต่อ (กรอกทั้งฝั่ง Master และ Slave)
| ช่อง | ตัวอย่าง | หมายเหตุ |
|---|---|---|
| IP / Host | `172.16.1.10` (Master) · `172.16.1.11` (Slave) | |
| Port | `3306` | |
| ชื่อผู้ใช้ MySQL | `nms_ro` | ผู้ใช้จากขั้นที่ 2 |
| รหัสผ่าน | | หลังบันทึกจะแสดงเป็น •••••••• (ปล่อยไว้ได้ถ้าไม่เปลี่ยน) |
| ฐานข้อมูลที่เปรียบเทียบ | `hos` | หลังกดทดสอบจะมีรายชื่อฐานข้อมูลให้เลือก |
| SSL/TLS | | ติ๊กเมื่อเซิร์ฟเวอร์บังคับใช้ SSL |

### 4.2 กด “ทดสอบการเชื่อมต่อ” ทีละฝั่ง
ผลที่ควรได้:
- **Master:** `✓ เชื่อมต่อสำเร็จ … binlog: mysql-bin.000123 @ 4567890`
- **Slave:** `✓ เชื่อมต่อสำเร็จ … read_only ON · เป็น Replica ของ 172.16.1.10:3306`

ถ้ามีกรอบสีเหลือง เช่น *“ผู้ใช้นี้มีสิทธิ์เขียน/แก้ไขข้อมูล”* หรือ *“ไม่มีสิทธิ์ดูสถานะ Replication”* ให้แก้สิทธิ์ตามขั้นที่ 2

### 4.3 การตรวจสอบและการแจ้งเตือน
| ช่อง | ค่าแนะนำ | ความหมาย |
|---|---|---|
| ตรวจทุก (วินาที) | `60` | รอบการตรวจสถานะและรัน Custom Query |
| เปรียบเทียบตารางทุก (นาที) | `30` | รอบการเทียบรายการตาราง |
| เกณฑ์เตือน Replication Delay | `30` วินาที | เกินค่านี้ = สถานะ LAG สีเหลือง |
| เกณฑ์วิกฤต | `300` วินาที | เกินค่านี้ = แจ้งเตือนระดับวิกฤต |
| ตารางที่นับแถวจริง | `patient, ovst, ipt` | นับด้วย `COUNT(*)` ทั้งสองฝั่ง ควรระบุเฉพาะตารางสำคัญ |
| เปิดการตรวจอัตโนมัติ | ✓ | |
| ส่งแจ้งเตือนภายนอก | ✓ | ส่งผ่านช่องทางในหน้า ตั้งค่า → การแจ้งเตือนภายนอก (หมอพร้อม / Webhook / Telegram) |

กด **บันทึกและเริ่มตรวจ** ระบบจะตรวจรอบแรกทันที

---

## ขั้นที่ 5: อ่านหน้า Dashboard

### 5.1 สถานะรวม (ป้ายด้านบน)
| ป้าย | ความหมาย | ควรทำอะไร |
|---|---|---|
| 🟢 **ข้อมูลตรงกัน · SYNC** | Replication ทำงานปกติ และทุก Query ให้ผลตรงกัน | — |
| 🟡 **Replication ล่าช้า · LAG** | Slave ตามหลัง Master เกินเกณฑ์เตือน | ตรวจภาระเครื่อง Slave, network, Query หนักบน Slave |
| 🟡 **ข้อมูลไม่ตรงกัน · DIFF** | Replication ทำงาน แต่ผล Custom Query ต่างกัน | กด “ดูผลลัพธ์” เพื่อดูแถวที่ต่าง อาจมีการแก้ข้อมูลที่ Slave โดยตรง |
| 🔴 **Replication หยุดทำงาน** | IO หรือ SQL Thread ไม่ใช่ `Yes` | ดูข้อความ error ใต้ตัวเลข Delay แล้วแก้ไขที่เครื่อง Slave |
| 🔴 **เชื่อมต่อไม่ได้ · OFFLINE** | เชื่อมต่อเครื่องใดเครื่องหนึ่งไม่ได้ | ตรวจเครื่อง / บริการ mysqld / firewall |
| 🔴 **ไม่ได้ตั้งค่า Replication** | `SHOW REPLICA STATUS` ของ Slave ว่าง | ตรวจว่ากรอก IP Slave ถูกเครื่อง |

### 5.2 การ์ด Master ← → Slave
- **การ์ด Master / Slave:** server_id, read_only (Slave ควรเป็น **ON**), Uptime, Connections, Queries/วินาที, binlog / exec position, GTID
- **การ์ดกลาง:** ตัวเลข **Replication Delay** (เขียว / เหลือง / แดงตามเกณฑ์), ลูกศรเคลื่อนไหวแสดงทิศทางข้อมูล (แดง = หยุด), สถานะ IO/SQL Thread,
  **“ข้อมูลที่ยังไม่ได้ apply”** = binlog position ของ Master ลบด้วย exec position ของ Slave (ถ้า 0 = ตามทันแล้ว ✓)

### 5.3 ปัญหาที่พบ
รายการปัญหาจัดระดับสี 🔴 วิกฤต / 🟡 เตือน / 🔵 ข้อมูล
เมื่อ Replication หยุดหรือช้า ผล Query ที่ไม่ตรงกันจะแสดงเป็นระดับ “ข้อมูล” พร้อมหมายเหตุว่าเป็นผลจากปัญหา Replication เพื่อไม่ให้แจ้งเตือนซ้ำซ้อน

### 5.4 กราฟ
- **Replication Delay:** เลือกช่วง 1 ชม. / 6 ชม. / 24 ชม. / 7 วัน / 30 วัน · แท่งเขียว = ปกติ, ส้ม = เกินเกณฑ์เตือน, แดง = เกินเกณฑ์วิกฤต, **พื้นหลังชมพู = ช่วงที่ Replication หยุดหรือเชื่อมต่อไม่ได้** · เส้นประส้ม = เกณฑ์เตือน
- **เวลาตอบสนองของฐานข้อมูล:** Master (ฟ้า) และ Slave (ม่วง)
- ถ้าตั้งค่า “ฐานข้อมูล MySQL สำหรับเก็บ Log” ไว้ (คู่มือ MYSQL-LOG-TH.md) ประวัติจะเก็บในตาราง `nms_dbsync_log` ดูย้อนหลังได้ 30 วัน
  ถ้าไม่ได้ตั้งค่า ระบบจะแสดงเฉพาะข้อมูลตั้งแต่เปิดโปรแกรม

---

## ขั้นที่ 6: เพิ่ม Custom Query สำหรับเปรียบเทียบข้อมูล

### 6.1 เริ่มจากตัวอย่าง (แนะนำ)
กด **เพิ่มจากตัวอย่าง** → ติ๊กรายการ → **เพิ่มรายการที่เลือก**

| ตัวอย่าง | SQL | ใช้ตรวจ |
|---|---|---|
| จำนวนผู้มารับบริการวันนี้ | `SELECT COUNT(*) FROM ovst WHERE vstdate = CURDATE()` | Slave รับข้อมูลวันนี้ครบหรือไม่ |
| VN ล่าสุด | `SELECT MAX(vn) FROM ovst` | Slave ตามทัน visit ล่าสุดหรือไม่ |
| ผู้มารับบริการวันนี้ แยกแผนก | `SELECT o.main_dep, k.department, COUNT(*) … GROUP BY …` | เปรียบเทียบรายแผนก (แบบตาราง) |
| จำนวนผู้ป่วยทั้งหมด (HN) | `SELECT COUNT(*) FROM patient` | ทุก 30 นาที |
| รายการยา/ค่าบริการวันนี้ | `SELECT COUNT(*) FROM opitemrece WHERE rxdate = CURDATE()` | |
| ผู้ป่วยในที่ยังไม่จำหน่าย | `SELECT COUNT(*) FROM ipt WHERE dchdate IS NULL` | |
| นาฬิกาของเครื่อง | `SELECT UNIX_TIMESTAMP()` (ยอมให้ต่าง ±5) | เวลาเครื่องไม่ตรงกัน (NTP) |
| Checksum ตารางขนาดเล็ก | `CHECKSUM TABLE kskdepartment` | ตรวจว่าข้อมูลทุกแถวตรงกันจริง |

> ชื่อตาราง/ฟิลด์อ้างอิงโครงสร้าง HOSxP มาตรฐาน หลังเพิ่มแล้วให้กด ✏️ → **ทดสอบ Query** เพื่อตรวจกับฐานข้อมูลจริงของโรงพยาบาล

### 6.2 เพิ่ม Query เอง
กด **เพิ่ม Query** แล้วกรอก:

| ช่อง | คำอธิบาย |
|---|---|
| ชื่อที่แสดงบน Dashboard | เช่น “จำนวน Lab วันนี้” |
| คำสั่ง SQL | ใช้ได้เฉพาะ `SELECT`, `WITH`, `SHOW`, `EXPLAIN`, `DESCRIBE`, `CHECKSUM TABLE` ครั้งละ 1 คำสั่ง |
| รูปแบบผลลัพธ์ | **ค่าเดียว** = ใช้แถวแรก คอลัมน์แรก · **ตาราง** = เทียบทุกแถว โดยใช้ **คอลัมน์แรกเป็นคีย์** (แสดงได้สูงสุด 500 แถว) |
| รันที่เครื่อง | **ทั้งสองเครื่องแล้วเปรียบเทียบ** · หรือ **เฉพาะ Master / Slave** (แสดงผลอย่างเดียว ไม่เทียบ) |
| ยอมให้ต่างกันได้ (±) | ใช้กับค่าตัวเลข **ทั้งแบบค่าเดียวและแบบตาราง (ทุกช่อง)** เช่น `2` = ต่างกันไม่เกิน 2 ถือว่าปกติ (เผื่อ Delay ไม่กี่วินาที) |
| ฐานข้อมูล | เว้นว่าง = ใช้ฐานข้อมูลที่ตั้งค่าไว้ |
| รันทุก (นาที) | `0` = ทุกรอบการตรวจ · Query ที่หนักควรตั้ง 15–60 นาที |
| เวลาสูงสุดต่อครั้ง | Query ที่เกินเวลาจะถูกยกเลิก (ค่าเริ่มต้น 15 วินาที) |

กด **ทดสอบ Query** เพื่อรันบนทั้งสองเครื่องทันทีและดูผลเปรียบเทียบก่อนบันทึก

### 6.3 การอ่านผลบนการ์ด Query
- **ค่าเดียว:** แสดงค่าของ Master | Slave และ **ส่วนต่าง** (Master − Slave) พร้อมกราฟเล็กแสดงส่วนต่างย้อนหลัง
- **ตาราง 2 คอลัมน์ (ชื่อ, ค่า):** แสดงรายแถว Master | Slave | ส่วนต่าง บนการ์ดเลย (เช่น จำนวนแถวรายตาราง)
- **ตารางทั่วไป:** “ตรงกัน X · ต่างกัน Y · เฉพาะ Master Z · เฉพาะ Slave W” → กด **ดูผลลัพธ์** จะเห็นแถวที่ค่าต่างกันวางเทียบกัน (Master สีฟ้า / Slave สีม่วง)
- ขอบซ้ายของการ์ด: เขียว = ตรงกัน, แดง = ไม่ตรงกัน, ส้ม = Query ผิดพลาด

### 6.4 เคล็ดลับการเขียน Query ที่ดี
1. **จำกัดช่วงข้อมูล** เช่น `WHERE vstdate = CURDATE()` ใช้คอลัมน์ที่มี index เพื่อไม่ให้กระทบเครื่อง Master
2. ข้อมูลที่เปลี่ยนตลอดเวลา (เช่น visit วันนี้) จะต่างกันชั่วคราวตาม Delay ให้ตั้ง **ยอมให้ต่างกันได้** เล็กน้อย ระบบจะแจ้งเตือนเมื่อพบติดกัน 2 รอบเท่านั้น
3. ข้อมูลที่ควรตรงกันเสมอ (เช่น ข้อมูลเมื่อวาน) ให้ตั้ง ±0:
   `SELECT COUNT(*) FROM ovst WHERE vstdate = CURDATE() - INTERVAL 1 DAY`
4. `CHECKSUM TABLE` อ่านทั้งตาราง ใช้กับ **ตารางขนาดเล็ก** เท่านั้น (เช่น ตาราง master data)

### 6.5 ความปลอดภัยของ Custom Query
ระบบป้องกัน 4 ชั้น:
1. ตรวจคำสั่งก่อนบันทึก: อนุญาตเฉพาะคำสั่งอ่าน, ห้ามหลายคำสั่ง (`;`), ห้าม `INTO OUTFILE`, `FOR UPDATE`, `SLEEP()`, `LOAD_FILE()`
2. รันใน `START TRANSACTION READ ONLY` และ `ROLLBACK` ทุกครั้ง
3. จำกัดเวลาด้วย `max_execution_time` (MySQL) / `max_statement_time` (MariaDB)
4. ผู้ใช้ฐานข้อมูลมีแค่สิทธิ์ SELECT (ขั้นที่ 2)

เฉพาะ **admin** เพิ่ม/แก้ไข Query ได้ ผู้ใช้ระดับอื่นเห็นผลลัพธ์แต่ไม่เห็นคำสั่ง SQL

---

## ขั้นที่ 6.6: ย้ายจากสคริปต์ PHP เดิม (index.php) มาใช้ Smart Topology

สคริปต์ `index.php` เดิมนับแถว (`COUNT(*)`) 12 ตาราง ทั้ง Master และ Slave แล้วส่งข้อความเข้าหมอพร้อมตามเวลา 09:05, 12:10, 16:10
ใน Smart Topology ทำได้ครบโดยไม่ต้องใช้ PHP:

| index.php เดิม | Smart Topology |
|---|---|
| 24 คำสั่ง (`$conn` 12 + `$conns_0_3` 12) | **Custom Query แบบตาราง 1 รายการ** รันทั้งสองเครื่องพร้อมกัน |
| เทียบด้วยตาเองจากข้อความ | เทียบอัตโนมัติทุกตาราง ✅/❌ พร้อมส่วนต่าง และแจ้งเตือนเมื่อไม่ตรงกัน |
| `CURLOPT_URL` + `client-key` / `secret-key` ในไฟล์ | ตั้งค่าครั้งเดียวที่ ตั้งค่า → การแจ้งเตือนภายนอก (คีย์ถูกซ่อน ไม่อยู่ในโค้ด) |
| เปิดหน้าเว็บทิ้งไว้ / ตั้ง cron ให้เรียกไฟล์ | **รายงานสรุปตามเวลา** ในหน้าตั้งค่า Master/Slave |
| ข้อความ `ovst_M : … / ovst_S : …` | รูปแบบเดิม + ✅/❌ (หมอพร้อมแบบ Flex แสดงเป็นการ์ดตาราง) |

### ขั้นตอน
1. ตั้งค่าการเชื่อมต่อ Master / Slave (ขั้นที่ 4) — ใช้ IP เดียวกับใน `connection.php` (`$db` = Master, `$dbs` = Slave) แต่ใช้ผู้ใช้แบบอ่านอย่างเดียว
2. แท็บ ฐานข้อมูล Master/Slave → **เพิ่มจากตัวอย่าง** → กลุ่ม **“จากไฟล์ index.php (HOSxP)”** เลือก:
   - **จำนวนแถว 12 ตาราง HOSxP** — เหมือน index.php ทุกประการ (ยอมให้ต่าง ±5 เพราะมีข้อมูลเข้าระหว่างนับ, รันทุก 60 นาที)
   - **ข้อมูลวันนี้ แยกตาราง** — นับเฉพาะวันนี้ เบามาก ตรวจได้ทุกนาที
   - **ข้อมูลถึงเมื่อวาน (ต้องตรงกัน 100%)** — ข้อมูลย้อนหลังต้องเท่ากันเป๊ะ ถ้าต่างแม้ 1 แถวแปลว่า Slave ข้อมูลไม่ครบ
3. กด ✏️ ที่แต่ละ Query → **ทดสอบ Query** เพื่อตรวจชื่อคอลัมน์วันที่กับฐานข้อมูลจริง (เช่น `opitemrece.rxdate`, `ipt.regdate`, `lab_head.order_date`)
4. **ตั้งค่าการเชื่อมต่อ** → ส่วน “รายงานสรุปตามเวลา” ใส่ `09:05, 12:10, 16:10` → ติ๊ก **เปิดส่งรายงานตามเวลา** → บันทึก
   (ติ๊ก “ส่งเฉพาะเมื่อพบข้อมูลไม่ตรงกัน” ถ้าไม่ต้องการข้อความทุกรอบ)
5. กดปุ่ม **ส่งรายงาน** บนหน้า Dashboard เพื่อดูตัวอย่างข้อความและทดลองส่ง 1 ครั้ง
6. เมื่อได้รับข้อความในหมอพร้อมแล้ว **ปิด cron / ลบไฟล์ index.php เดิม** เพื่อไม่ให้ส่งซ้ำ และ**ขอ client-key / secret-key ชุดใหม่** เนื่องจากคีย์เดิมอยู่ในไฟล์ PHP แบบข้อความธรรมดา

### SQL ที่ใช้ (คัดลอกไปใช้กับ “เพิ่ม Query” ได้)
**จำนวนแถว 12 ตาราง** (รูปแบบ: ตาราง · ยอมให้ต่าง ±5 · รันทุก 60 นาที · เวลาสูงสุด 120 วินาที)
```sql
SELECT 'ovst' AS tbl, COUNT(*) AS total FROM ovst
UNION ALL SELECT 'vn_stat', COUNT(*) FROM vn_stat
UNION ALL SELECT 'an_stat', COUNT(*) FROM an_stat
UNION ALL SELECT 'opdscreen', COUNT(*) FROM opdscreen
UNION ALL SELECT 'opitemrece', COUNT(*) FROM opitemrece
UNION ALL SELECT 'ipt', COUNT(*) FROM ipt
UNION ALL SELECT 'ovstdiag', COUNT(*) FROM ovstdiag
UNION ALL SELECT 'lab_order', COUNT(*) FROM lab_order
UNION ALL SELECT 'lab_head', COUNT(*) FROM lab_head
UNION ALL SELECT 'er_regist', COUNT(*) FROM er_regist
UNION ALL SELECT 'patient', COUNT(*) FROM patient
UNION ALL SELECT 'person', COUNT(*) FROM person
```
**ข้อมูลวันนี้** (รูปแบบ: ตาราง · ±3 · ทุกรอบ)
```sql
SELECT 'ovst' AS tbl, COUNT(*) AS today FROM ovst WHERE vstdate = CURDATE()
UNION ALL SELECT 'vn_stat', COUNT(*) FROM vn_stat WHERE vstdate = CURDATE()
UNION ALL SELECT 'opdscreen', COUNT(*) FROM opdscreen WHERE vstdate = CURDATE()
UNION ALL SELECT 'opitemrece', COUNT(*) FROM opitemrece WHERE rxdate = CURDATE()
UNION ALL SELECT 'ovstdiag', COUNT(*) FROM ovstdiag WHERE vstdate = CURDATE()
UNION ALL SELECT 'er_regist', COUNT(*) FROM er_regist WHERE vstdate = CURDATE()
UNION ALL SELECT 'ipt', COUNT(*) FROM ipt WHERE regdate = CURDATE()
UNION ALL SELECT 'lab_head', COUNT(*) FROM lab_head WHERE order_date = CURDATE()
```
**ข้อมูลถึงเมื่อวาน** — ใช้ SQL เดียวกับ “ข้อมูลวันนี้” แต่เปลี่ยน `= CURDATE()` เป็น `< CURDATE()` (รูปแบบ: ตาราง · ±0 · ทุก 60 นาที)

### ทำไมไม่ใช้ ±0 กับจำนวนแถวทั้งหมด
ตารางอย่าง `ovst`, `opitemrece` มีข้อมูลเข้าตลอดเวลา และ Slave รับข้อมูลช้ากว่า Master เล็กน้อย (Replication Delay)
การนับทั้งสองเครื่องแม้ห่างกันไม่ถึงวินาทีก็อาจต่างกัน 1–2 แถว จึงตั้ง ±5 ไว้กันแจ้งเตือนหลอก
ส่วนการตรวจว่า “ข้อมูลครบจริง” ให้ใช้ Query **ถึงเมื่อวาน** ซึ่งต้องตรงกัน 100%

> ⏱️ `COUNT(*)` ทั้งตารางของ `opitemrece` / `ovstdiag` ที่มีหลายสิบล้านแถว อาจใช้เวลาหลายสิบวินาทีและเพิ่มภาระเครื่อง Master
> จึงตั้งให้รันทุก 60 นาที (ระบบจะรันใหม่ทุกครั้งที่ส่งรายงานตามเวลาด้วย) ห้ามตั้งเป็น 0 (ทุกรอบ) กับ Query นี้

---

## ขั้นที่ 7: เปรียบเทียบตาราง

ส่วนล่างของหน้าเปรียบเทียบรายการตารางในฐานข้อมูลที่ตั้งค่า (เช่น `hos`) ตามรอบ หรือกดปุ่ม **เปรียบเทียบตาราง**
- **ไม่มีใน Slave / ไม่มีใน Master:** ตารางที่ถูกสร้างฝั่งเดียว (อาจถูกกรองด้วย `replicate-ignore-table` หรือสร้างตรงที่ Slave)
- **แถว (ประมาณ):** จาก `information_schema` ซึ่ง InnoDB ประมาณค่า จึง **ต่างกันได้แม้ข้อมูลตรงกัน** ใช้ดูแนวโน้มเท่านั้น
- **นับจริง:** เฉพาะตารางที่ระบุในช่อง “ตารางที่นับแถวจริง” ถ้าไม่เท่ากันจะขึ้น 🔴 “จำนวนแถวต่างกัน”
- ปุ่ม **เฉพาะที่ต้องตรวจสอบ** / **ทั้งหมด** และช่องค้นหาชื่อตาราง

---

## ขั้นที่ 8: การแจ้งเตือน

เมื่อเปิด “ส่งแจ้งเตือนภายนอก” ระบบจะส่งผ่านช่องทางเดียวกับการแจ้งเตือนอุปกรณ์ (หมอพร้อม / Webhook / Telegram)

| เหตุการณ์ | ระดับ |
|---|---|
| เชื่อมต่อ Master หรือ Slave ไม่ได้ | วิกฤต |
| Replication หยุด (IO/SQL Thread ไม่ใช่ Yes) | วิกฤต |
| Delay เกินเกณฑ์วิกฤต / เกณฑ์เตือน | วิกฤต / เตือน |
| ผล Custom Query ไม่ตรงกัน | เตือน |
| Slave ไม่ได้เปิด read_only, server_id ซ้ำ, Master ปิด binlog | เตือน / วิกฤต |

- ต้องพบปัญหา **ติดกัน 2 รอบ** ก่อนแจ้ง เพื่อกันการแจ้งเตือนหลอก
- เมื่อปัญหาหายจะส่งข้อความ 🟢 “กลับมาปกติ” พร้อมระยะเวลาที่เกิดปัญหา
- รายการแจ้งเตือนทั้งหมดดูได้ที่แท็บ **การแจ้งเตือน** (ชื่ออุปกรณ์ “ฐานข้อมูล HIS (Master/Slave)”)

---

## ขั้นที่ 9: ดูประวัติด้วย SQL (ถ้าเปิดเก็บ Log ลง MySQL)
```sql
-- ช่วงที่ Replication มีปัญหาใน 7 วันล่าสุด
SELECT checked_at, status, lag_sec, detail
FROM nms_dbsync_log
WHERE status <> 'sync' AND checked_at >= NOW() - INTERVAL 7 DAY
ORDER BY checked_at DESC;

-- Delay สูงสุดรายชั่วโมง
SELECT DATE_FORMAT(checked_at, '%Y-%m-%d %H:00') AS hr, MAX(lag_sec) AS max_lag, AVG(slave_ms) AS avg_slave_ms
FROM nms_dbsync_log GROUP BY hr ORDER BY hr DESC LIMIT 48;
```
> ถ้าฐานข้อมูล Log (`smart_topology`) อยู่บนเครื่อง Master ของ HOSxP ข้อมูล Log จะถูก Replicate ไปที่ Slave ด้วย (ทำงานได้ปกติ)
> แนะนำให้ใช้เครื่อง MySQL แยกสำหรับ Log หรือเพิ่ม `replicate-wild-ignore-table = smart_topology.%` ที่ Slave

---

## แก้ปัญหาที่พบบ่อย

| ข้อความ / อาการ | สาเหตุและวิธีแก้ |
|---|---|
| **ยังไม่ได้ติดตั้งไลบรารี mysql2** | สั่ง `npm install` ในโฟลเดอร์โปรแกรม แล้วเปิดโปรแกรมใหม่ |
| **ไม่มีสิทธิ์ดูสถานะ Replication บนเครื่อง Slave** | MySQL: `GRANT REPLICATION CLIENT ON *.*` · MariaDB 10.5+: `GRANT SLAVE MONITOR ON *.*` (ดูขั้นที่ 2) แล้วกด **ตรวจสอบทันที** |
| **ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง หรือไม่ได้รับอนุญาตจาก IP นี้** | ผู้ใช้สร้างไว้กับ IP อื่น ให้ตรวจ `SELECT user, host FROM mysql.user` และสร้างให้ตรงกับ IP เครื่อง Smart Topology |
| **เชื่อมต่อไม่ได้ (ECONNREFUSED) / หมดเวลาเชื่อมต่อ** | Firewall (ขั้นที่ 3) หรือ MySQL ตั้ง `bind-address = 127.0.0.1` |
| **Replication หยุดทำงาน — SQL thread: No** | ดูข้อความ error (เช่น `Duplicate entry`) บนเครื่อง Slave ด้วย `SHOW SLAVE STATUS\G` แล้วแก้ตามสาเหตุ ห้ามข้าม error โดยไม่ตรวจสอบข้อมูล |
| **IO thread: Connecting** | Slave เชื่อมต่อ Master ไม่ได้ (รหัสผ่านผู้ใช้ replication, firewall, network) |
| **Delay — (ไม่มีตัวเลข)** | SQL Thread หยุด จึงไม่มีค่า Seconds_Behind_Master |
| **Slave ไม่ได้เปิด read_only** | ตั้ง `read_only = 1` (และ `super_read_only = 1` ใน MySQL 8) ใน my.cnf ของ Slave เพื่อป้องกันการเขียนข้อมูลตรงที่ Slave |
| **ข้อมูลไม่ตรงกัน แต่ Delay = 0** | มีการแก้ข้อมูลที่ Slave โดยตรง หรือมีตารางที่ไม่ได้ Replicate · กด “ดูผลลัพธ์” เพื่อหาแถวที่ต่าง แล้วพิจารณา re-sync ด้วย pt-table-checksum / pt-table-sync |
| **นาฬิกาของเครื่องไม่ตรงกัน** | ตั้ง NTP: `sudo dnf install chrony && sudo systemctl enable --now chronyd` |
| **Query ทำงานนานเกินเวลาที่กำหนด** | เพิ่มเงื่อนไขให้ใช้ index, ตั้ง “รันทุก” ให้ห่างขึ้น หรือเพิ่ม “เวลาสูงสุดต่อครั้ง” |
