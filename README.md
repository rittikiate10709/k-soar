# SMART TOPOLOGY — ระบบเฝ้าระวังเครือข่าย (NOC Network Monitoring)

ระบบมอนิเตอร์อุปกรณ์เครือข่ายแบบเว็บ ใช้งานได้จริงในเครือข่ายโรงพยาบาล/องค์กร
ตรวจสอบ Switch, Router, Firewall, Server, PC, กล้อง CCTV, อุปกรณ์การแพทย์ ฯลฯ ด้วย **ICMP Ping** หรือ **TCP Port** แบบอัตโนมัติ

## ความสามารถ

| หมวด | รายละเอียด |
|---|---|
| เข้าสู่ระบบ | หน้า Login, รหัสผ่านเข้ารหัส scrypt, ล็อกชั่วคราวเมื่อกรอกผิด 5 ครั้ง, บังคับเปลี่ยนรหัสผ่านเริ่มต้น |
| ผู้ใช้งาน | 3 ระดับ: `admin` (ทั้งหมด), `operator` (เพิ่ม/แก้ไขอุปกรณ์), `viewer` (ดูอย่างเดียว) |
| อุปกรณ์ | เพิ่ม/แก้ไข/ลบ Switch หรือ IP, กำหนด Uplink เพื่อสร้างแผนผัง, VLAN, ตำแหน่ง, ยี่ห้อ/รุ่น, โหมดบำรุงรักษา |
| นำเข้า/ส่งออก | วาง CSV หรือเลือกไฟล์ .csv เพื่อเพิ่มหลายร้อยรายการ, ส่งออกเป็น CSV (เปิดใน Excel ได้) |
| การตรวจสอบ | ICMP (คำสั่ง `ping` ของเครื่องเซิร์ฟเวอร์) หรือ TCP port (เช่น 3306 HIS/MySQL, 443, 22) ทุก N วินาที |
| Dashboard | SLA Gauge, RTT & Jitter Trend, Availability Trend, Latency Histogram, Status Donut, Critical Path, Top Latency |
| Topology | แผนผังอัตโนมัติตามลำดับชั้น, ลากจัดวางโหนดได้ (บันทึกตำแหน่ง), ซูม/เลื่อน, เส้น LINK DOWN สีแดง |
| แจ้งเตือน | สร้าง Alert อัตโนมัติเมื่ออุปกรณ์ล่ม/ช้า, ปิดเองเมื่อฟื้นตัว, รับทราบ/ปิดเรื่อง, Toast แจ้งทันที |
| Log & รายงาน | บันทึกผลการตรวจลง **MySQL / MariaDB** และหน้ารายงานกราฟเปรียบเทียบ รายวัน/เดือน/ปี, Heatmap วัน×เวลา, วิเคราะห์ปัญหาที่เกิดซ้ำ → **[docs/MYSQL-LOG-TH.md](docs/MYSQL-LOG-TH.md)** |
| ฐานข้อมูล Master/Slave | ตรวจ Replication (IO/SQL thread, Delay), เปรียบเทียบข้อมูลด้วย **Custom Query** ที่กำหนดเอง, เทียบตาราง, แจ้งเตือน → **[docs/DBSYNC-TH.md](docs/DBSYNC-TH.md)** |
| REST API | `/api/v1/*` สำหรับระบบภายนอก, **API Key** (สิทธิ์ viewer/operator/admin/integration, จำกัด IP, rate limit, วันหมดอายุ), CORS, OpenAPI 3 + หน้าทดลองเรียก `/api-docs` → **[docs/API-TH.md](docs/API-TH.md)** |
| สำรอง/กู้คืน | ไฟล์สำรองเก็บ**ทุกค่าที่ตั้งจากหน้าเว็บ** เข้ารหัส AES-256-GCM ได้, สำรองอัตโนมัติรายวัน, กู้คืนแล้วใช้งานต่อได้ทันที → **[docs/BACKUP-TH.md](docs/BACKUP-TH.md)** |
| Wazuh SIEM | ดึงสถานะ Manager/Agents, สถิติ Component, Configuration, SCA + CIS-CAT · ส่งการแจ้งเตือนเข้า Wazuh (`POST /events`) · รับ Alert จาก Wazuh กลับมา → **[docs/WAZUH-TH.md](docs/WAZUH-TH.md)** |
| ทะเบียนคอมพิวเตอร์ | **Agent** Windows/Linux ส่งสเปค (OS, CPU, RAM, ดิสก์, การ์ดจอ, เครือข่าย, ซอฟต์แวร์) อัตโนมัติ, ประวัติการเปลี่ยนแปลง + รายงาน รายวัน/เดือน/ปี/ช่วงวันที่, แจ้งเตือนเมื่อฮาร์ดแวร์ถูกถอด → **[docs/INVENTORY-TH.md](docs/INVENTORY-TH.md)** |
| สแกน IP | กำหนดช่วง IP (CIDR / ช่วง), สแกน ping + TCP, เปรียบเทียบ IP ที่ใช้งานจริงกับทะเบียนคอมพิวเตอร์และอุปกรณ์เครือข่าย, สแกนอัตโนมัติ |
| อื่น ๆ | อัปเดตเรียลไทม์ (Server-Sent Events), โหมดมืด, IP Mask ซ่อน IP ตอนนำเสนอ, รองรับมือถือ |

## ความต้องการของระบบ

- **Node.js 18 ขึ้นไป** และสั่ง `npm install` ครั้งแรก (ติดตั้งไลบรารี `mysql2` สำหรับเก็บ log)
- (ถ้าต้องการเก็บ log/รายงาน) MySQL 5.7+ / 8.x หรือ MariaDB 10.4+
- เครื่องเซิร์ฟเวอร์ต้องอยู่ในเครือข่ายที่ ping อุปกรณ์ได้ และมีคำสั่ง `ping`
  (Windows/macOS มีอยู่แล้ว, Ubuntu: `sudo apt install iputils-ping`)

## ติดตั้งและใช้งาน

### วิธีที่ 1 — รันด้วย Node.js (Windows / Linux / macOS)

```bash
cd smart-topology
npm install      # ครั้งแรกเท่านั้น
node server.js
```
เปิดเบราว์เซอร์ไปที่ `http://<IP-เซิร์ฟเวอร์>:3000`

- ผู้ใช้เริ่มต้น: **admin** / **admin1234** (ระบบจะบังคับให้เปลี่ยนรหัสทันทีที่เข้าระบบ)
- ต้องการข้อมูลตัวอย่าง: `SEED_DEMO=1 node server.js` หรือกดปุ่ม “โหลดข้อมูลตัวอย่าง” ในหน้าแรก

### วิธีที่ 2 — Docker (แนะนำสำหรับเซิร์ฟเวอร์)

```bash
docker run -d --name smart-topology --restart unless-stopped --network host \
  -e ADMIN_PASSWORD='ตั้งรหัสที่ปลอดภัย' -v nms-data:/data \
  <dockerhub-user>/smart-topology:latest
```
หรือ `docker compose up -d` (แก้ชื่อ image ในไฟล์ `docker-compose.yml` ก่อน)

Image สร้างอัตโนมัติด้วย GitHub Actions ทุกครั้งที่ push โค้ด (amd64 + arm64, ผ่านการทดสอบก่อน push)
ขั้นตอนอัปโหลดขึ้น GitHub / Docker Hub แบบละเอียด → **[docs/DEPLOY-TH.md](docs/DEPLOY-TH.md)**

### ให้รันอัตโนมัติเมื่อเปิดเครื่อง (Linux systemd)

```ini
# /etc/systemd/system/smart-topology.service
[Unit]
Description=Smart Topology NOC
After=network.target

[Service]
WorkingDirectory=/opt/smart-topology
ExecStart=/usr/bin/node server.js
Environment=PORT=3000
Restart=always

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now smart-topology
```
บน Windows ใช้ [NSSM](https://nssm.cc) หรือ `pm2` เพื่อให้ทำงานเป็น Service

## ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `PORT` | `3000` | พอร์ตของเว็บ |
| `HOST` | `0.0.0.0` | IP ที่รับการเชื่อมต่อ |
| `DATA_DIR` | `./data` | ที่เก็บฐานข้อมูล `db.json` |
| `ADMIN_PASSWORD` | `admin1234` | รหัส admin ตอนติดตั้งครั้งแรก |
| `COOKIE_SECURE` | — | ตั้งเป็น `1` เมื่อเปิดผ่าน HTTPS |
| `TRUST_PROXY` | — | ตั้งเป็น `1` เมื่ออยู่หลัง Reverse Proxy (ใช้ IP จาก `X-Forwarded-For` ตรวจ API Key) |
| `SEED_DEMO` | — | ตั้งเป็น `1` เพื่อสร้างอุปกรณ์ตัวอย่างเมื่อฐานข้อมูลว่าง |
| `NMS_MYSQL_HOST` / `_PORT` / `_USER` / `_PASSWORD` / `_DATABASE` | — | ตั้งค่า MySQL ล่วงหน้า (ใช้ครั้งแรกเท่านั้น ภายหลังแก้ที่หน้าเว็บ) |

## รูปแบบไฟล์ CSV สำหรับนำเข้า

```csv
name,ip,type,vendor,model,location,vlan,uplink,tcp_port
Core Switch,10.0.0.1,core,Cisco,C9300-24T,ห้อง Server,1,,
SW-OPD-01,10.0.31.2,switch,Aruba,1930 24G,OPD ชั้น 1,31,Core Switch,
HIS Database,10.250.0.10,database,Dell,R750,Data Center,250,Core Switch,3306
```
- `type`: isp, firewall, router, core, switch, ap, server, vm, database, client, laptop, camera, printer, medical, kiosk, iot, other
- `uplink`: ชื่อหรือ IP ของอุปกรณ์ต้นทาง (ต้องอยู่ก่อนในไฟล์หรือมีในระบบแล้ว)
- `tcp_port`: ใส่เมื่อต้องการตรวจแบบ TCP แทน ICMP

## หลักการตัดสินสถานะ

- **ปกติ (Online)** — ตอบสนองภายในเกณฑ์ latency (ค่าเริ่มต้น 100 ms)
- **ควรระวัง (Warning)** — ตอบสนองแต่ช้ากว่าเกณฑ์
- **ออฟไลน์ (Offline)** — ไม่ตอบสนอง 2 รอบติดกัน (กันการแจ้งเตือนหลอก)
- **บำรุงรักษา** — ยังตรวจแต่ไม่แจ้งเตือน · **ปิดการตรวจ** — ไม่ตรวจเลย
- อุปกรณ์ที่ติ๊ก “Critical Path” เมื่อล่มจะเป็นระดับ **Critical**, อุปกรณ์อื่นเป็น **Warning**

## การแจ้งเตือนภายนอก (หมอพร้อม MOPH Notify / Webhook / Telegram)

ตั้งค่าที่เมนู **ตั้งค่า → การแจ้งเตือนภายนอก** (เฉพาะ admin)

1. กดเปิดสวิตช์ “เปิดใช้งาน”
2. กด **+ MOPH** แล้วกรอก `client-key` และ `secret-key` ที่ได้จากระบบหมอพร้อม (เมนูหน่วยบริการ → MOPH Notify)
   URL เริ่มต้นคือ `https://morpromt2f.moph.go.th/api/notify/send`
3. กด **ทดสอบส่ง** เพื่อดูว่าข้อความเข้ากลุ่ม LINE หรือไม่ จากนั้นกด **บันทึก**

| ตัวเลือก | ความหมาย |
|---|---|
| แจ้งเมื่อ Down | ส่งเมื่ออุปกรณ์ไม่ตอบ 2 รอบติดกัน |
| แจ้งเมื่อกลับมา | ส่งพร้อมระยะเวลาที่ใช้งานไม่ได้ (ส่งเฉพาะอุปกรณ์ที่เคยแจ้งว่าล่ม) |
| แจ้งเมื่อ Latency สูง | ส่งเมื่อช้ากว่าเกณฑ์ที่ตั้งไว้ |
| เฉพาะ Critical Path | ส่งเฉพาะอุปกรณ์ที่ติ๊ก “อุปกรณ์สำคัญ” |
| ไม่แจ้งอุปกรณ์ปลายทาง | ถ้า Core Switch ล่มแล้วอุปกรณ์ใต้ Switch ล่มตามด้วย จะส่งข้อความเดียว พร้อมบอกว่ากระทบอีกกี่เครื่อง |
| แจ้งซ้ำทุก N นาที | ส่งเตือนซ้ำหากยังไม่กลับมา หยุดเมื่อกด “รับทราบ” ในหน้าการแจ้งเตือน |
| ลิงก์ระบบ NOC | ใส่แล้วข้อความจะมีปุ่ม “เปิดระบบ NOC” |

- ปิดการแจ้งเตือนรายเครื่องได้ที่ “แก้ไขอุปกรณ์” → ติ๊กออก “ส่งแจ้งเตือนภายนอก”
- อุปกรณ์ในโหมดบำรุงรักษาจะไม่ถูกส่งแจ้งเตือน
- เหตุการณ์ในรอบตรวจเดียวกันจะถูกรวมเป็นข้อความเดียว (แสดงสูงสุด 10 เครื่องต่อข้อความ)
- ถ้าส่งไม่สำเร็จ (เครือข่ายขัดข้อง/HTTP 5xx) ระบบจะลองส่งซ้ำ 1 ครั้งหลัง 5 วินาที และบันทึกผลไว้ใน “ประวัติการส่งล่าสุด”
- คีย์ถูกเก็บใน `data/db.json` และแสดงบนหน้าเว็บแบบซ่อน (`••••1234`) **อย่าใส่คีย์ลงในโค้ดหรือ Git**

**ข้อกำหนดเครือข่าย:** เครื่องที่รันระบบต้องออกอินเทอร์เน็ตไปยัง `morpromt2f.moph.go.th` พอร์ต 443 ได้
ถ้าโรงพยาบาลบังคับใช้ Proxy ให้ใช้ Node.js 24 ขึ้นไป แล้วตั้งค่า `HTTPS_PROXY=http://proxy:port` และ `NODE_USE_ENV_PROXY=1`

**Webhook:** ส่ง `POST` แบบ JSON `{event, title, text, content, site, time, devices[]}` พร้อม Header ที่กำหนดเองได้
ใช้ต่อกับ n8n, Google Chat, Discord (ช่อง `content`), Slack (ช่อง `text`) หรือระบบของโรงพยาบาลได้

## ความปลอดภัยที่แนะนำ

1. เปลี่ยนรหัส admin ทันที และสร้างบัญชีแยกรายบุคคล
2. เปิดใช้ผ่าน HTTPS (เช่นวาง Nginx / Caddy หน้าเว็บ) แล้วตั้ง `COOKIE_SECURE=1`
3. จำกัดการเข้าถึงพอร์ต 3000 ให้เฉพาะเครือข่ายภายใน / VLAN ของฝ่ายไอที
4. เปิด “สำรองอัตโนมัติ” (ตั้งค่า → สำรองและกู้คืนข้อมูล) และดาวน์โหลดไฟล์สำรองแบบเข้ารหัสเก็บไว้นอกเครื่อง
5. API Key ให้สิทธิ์น้อยที่สุดที่พอใช้งาน (ส่วนใหญ่ `viewer`) และจำกัด IP ต้นทาง

## ต่อยอดในอนาคต

~~เก็บประวัติลงฐานข้อมูล~~ ✅ ทำแล้ว (MySQL)
ข้อมูล Throughput (Mbps), CPU/RAM ของ Server และสถานะพอร์ตของ Switch ต้องอ่านผ่าน **SNMP** ซึ่งสามารถเพิ่มเป็นวิธีตรวจที่ 3 ได้ในฟังก์ชัน `checkDevice()` ของ `server.js`
ช่องทางแจ้งเตือนใหม่ (เช่น Email) เพิ่มได้ที่ฟังก์ชัน `sendChannel()`

## โครงสร้างไฟล์

```
smart-topology/
├── server.js            # API, Login/Session, ระบบตรวจสอบ, แจ้งเตือน, SSE
├── lib/mysqlLog.js      # เขียน log ลง MySQL + คำนวณรายงาน
├── lib/dbSync.js        # เฝ้าระวัง/เปรียบเทียบฐานข้อมูล Master–Slave
├── lib/apiGateway.js    # API Key, IP allowlist, rate limit, CORS
├── lib/backup.js        # สร้าง/เข้ารหัส/ตรวจ/กู้คืนไฟล์สำรอง
├── lib/wazuh.js         # Wazuh Server API client (ดึงข้อมูล + ส่ง events)
├── lib/openapi.js       # เอกสาร OpenAPI 3 ของ REST API
├── lib/inventory.js     # ทะเบียนคอมพิวเตอร์ + ประวัติการเปลี่ยนแปลง + รายงาน
├── lib/ipscan.js        # สแกน IP ตามช่วงที่กำหนด
├── sql/schema.sql       # โครงสร้างฐานข้อมูล (สร้างอัตโนมัติจากหน้าเว็บได้)
├── public/
│   ├── login.html       # หน้าเข้าสู่ระบบ
│   ├── index.html       # หน้าหลัก NOC
│   ├── api-docs.html    # เอกสาร API + ทดลองเรียก
│   ├── css/app.css · api-docs.css
│   ├── js/ common.js · illus.js · login.js · app.js · reports.js · dbsync.js · admin.js · wazuh.js · inventory.js · ipscan.js · api-docs.js
│   ├── agent/windows/   smart-topology-agent.ps1 · install-agent.ps1 · install-agent.cmd
│   ├── agent/linux/     smart-topology-agent.py · install-agent.sh
│   └── integrations/wazuh/  custom-smarttopology (สคริปต์ integration) · smart_topology_rules.xml
├── Dockerfile · docker-compose.yml · .dockerignore
├── .github/workflows/docker-publish.yml   # CI: build → test → push image
├── docs/DEPLOY-TH.md    # คู่มือ GitHub + Docker Hub
├── docs/MYSQL-LOG-TH.md # คู่มือเก็บ log ลง MySQL และหน้ารายงาน
├── docs/DBSYNC-TH.md    # คู่มือฐานข้อมูล Master/Slave
├── docs/API-TH.md       # คู่มือ REST API / API Key
├── docs/BACKUP-TH.md    # คู่มือสำรองและกู้คืน
├── docs/WAZUH-TH.md     # คู่มือเชื่อมต่อ Wazuh
├── docs/INVENTORY-TH.md # คู่มือทะเบียนคอมพิวเตอร์ / Agent / สแกน IP
└── data/                # สร้างอัตโนมัติ: db.json (ผู้ใช้ อุปกรณ์ ตั้งค่า) · inventory.json · ipscan.json · backups/
```
