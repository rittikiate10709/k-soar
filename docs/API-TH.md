# คู่มือ REST API — เชื่อมต่อ Front-end กับ Back-end และระบบภายนอก (v1.3.0)

Smart Topology ส่งและรับข้อมูลระหว่างหน้าเว็บ (Front-end) กับเซิร์ฟเวอร์ (Back-end) **ผ่าน REST API ในรูปแบบ JSON ทั้งหมด**
หน้าเว็บเองไม่เคยเชื่อมต่อฐานข้อมูลโดยตรง ทุกอย่างวิ่งผ่าน API ชุดเดียวกัน ระบบอื่นในโรงพยาบาลจึงใช้ API ชุดนี้ได้เลยด้วย **API Key**
เช่น Dashboard ผู้บริหาร, สคริปต์ HOSxP, Grafana, Power BI, Line Bot หรือ Wazuh

---

## 1. สถาปัตยกรรม: Front-end ↔ API ↔ Back-end ↔ ฐานข้อมูล

```
┌──────────────────────┐   HTTPS + JSON    ┌────────────────────────────┐        ┌─────────────────────┐
│ Front-end            │ ───────────────▶ │ Back-end (server.js)       │ ─────▶ │ data/db.json        │
│ • หน้าเว็บ Smart      │   Cookie session  │ 1. CORS / Rate limit       │        │ (อุปกรณ์ ผู้ใช้ ตั้งค่า)│
│   Topology (app.js)  │ ◀─────────────── │ 2. ยืนยันตัวตน (Cookie/Key) │        ├─────────────────────┤
│ • ระบบภายนอก          │   Bearer API Key  │ 3. ตรวจสิทธิ์ (role)        │ ─────▶ │ MySQL / MariaDB     │
│   (PHP, Python, BI)  │                   │ 4. ตรวจข้อมูล (validate)    │        │ (log / รายงาน)      │
│ • Wazuh Manager      │                   │ 5. ทำงาน → ส่ง JSON กลับ    │ ─────▶ │ Wazuh API, HIS DB   │
└──────────────────────┘                   └────────────────────────────┘        └─────────────────────┘
```

หลักการที่ใช้ และแนะนำให้ใช้เมื่อสร้าง API ของตัวเอง:

| หลักการ | ใน Smart Topology |
|---|---|
| **แยกชั้น** Front-end ห้ามรู้รหัสผ่านฐานข้อมูล | หน้าเว็บเรียก `/api/...` เท่านั้น เซิร์ฟเวอร์เป็นผู้ต่อ MySQL/Wazuh |
| **Resource + HTTP method** | `GET /devices` อ่าน · `POST /devices` เพิ่ม · `PUT /devices/{id}` แก้ · `DELETE /devices/{id}` ลบ |
| **รูปแบบเดียวกันทุก endpoint** | สำเร็จ = HTTP 2xx + JSON · ผิดพลาด = 4xx/5xx + `{"error":"ข้อความภาษาไทย"}` |
| **มีเวอร์ชัน** | `/api/v1/...` (ถ้าอนาคตเปลี่ยนรูปแบบจะออก `/api/v2` โดยไม่กระทบระบบเดิม) |
| **ยืนยันตัวตนทุกคำขอ** | หน้าเว็บใช้ Cookie `nms_sid` (HttpOnly) · ระบบภายนอกใช้ `Authorization: Bearer stk_…` |
| **สิทธิ์น้อยที่สุด** | Key แต่ละอันกำหนด role, IP ต้นทาง, จำนวนครั้ง/นาที และวันหมดอายุ |
| **ตรวจข้อมูลฝั่งเซิร์ฟเวอร์เสมอ** | ห้ามเชื่อค่าจาก Front-end เช่น IP, port, SQL ต้องผ่านการตรวจก่อนบันทึก |
| **มีเอกสาร** | OpenAPI 3 ที่ `/api/v1/openapi.json` และหน้าทดลองเรียกที่ `/api-docs` |

---

## 2. หน้าตั้งค่าการเชื่อมต่อแบบ API

เมนู **ตั้งค่า → การเชื่อมต่อแบบ API** (เฉพาะ admin)

### 2.1 การตั้งค่าทั่วไป
| ช่อง | ความหมาย |
|---|---|
| อนุญาตให้ระบบภายนอกเชื่อมต่อด้วย API Key | ปิดสวิตช์ = Key ทุกอันใช้ไม่ได้ทันที (หน้าเว็บปกติยังใช้งานได้) |
| Base URL | ที่อยู่ที่ระบบภายนอกต้องเรียก เช่น `https://noc.hospital.go.th/api/v1` |
| จำนวนครั้ง/นาที ต่อ Key | ค่าเริ่มต้น 120 · เกินแล้วได้ HTTP **429** พร้อม header `Retry-After` |
| อยู่หลัง Reverse Proxy | เปิดเมื่อวาง Nginx/Caddy ด้านหน้า เพื่อให้ระบบใช้ IP จริงจาก `X-Forwarded-For` ตรวจ IP allowlist (**ห้ามเปิดถ้าไม่มี proxy** เพราะผู้เรียกปลอม header ได้) |
| CORS | ชื่อเว็บไซต์ (origin) ที่อนุญาตให้ JavaScript ในเบราว์เซอร์เรียก API ข้ามโดเมน เช่น `https://dashboard.hospital.go.th` · เรียกจากเซิร์ฟเวอร์/สคริปต์ไม่ต้องตั้ง |

### 2.2 สร้าง API Key — ทีละขั้นตอน
1. กด **สร้าง API Key**
2. ตั้งชื่อตามระบบที่จะใช้ เช่น `Dashboard ผู้บริหาร`
3. เลือกสิทธิ์
   | สิทธิ์ | ทำอะไรได้ |
   |---|---|
   | `viewer` อ่านอย่างเดียว | ดึงสถานะ อุปกรณ์ แจ้งเตือน รายงาน ฐานข้อมูล Wazuh (**แนะนำสำหรับเกือบทุกระบบ**) |
   | `operator` อ่าน + แก้ไข | เพิ่ม/แก้ไข/ลบอุปกรณ์, ตรวจทันที, รับทราบ/ปิดแจ้งเตือน |
   | `admin` | ทุกอย่าง **ยกเว้น** จัดการผู้ใช้, API Key, ตั้งค่า API, กู้คืนข้อมูล (สงวนไว้ให้คนที่ login เท่านั้น) |
   | `integration` | ส่ง Alert เข้า `/integrations/wazuh` ได้อย่างเดียว (สำหรับ Wazuh Manager) |
   | `agent` | ส่งสเปคเครื่องเข้า `/inventory/report` ได้อย่างเดียว (สำหรับ Agent บนเครื่องลูกข่าย) |
4. (แนะนำ) จำกัด IP ต้นทาง เช่น `172.16.1.30` หรือ `10.0.0.0/8` คั่นด้วยจุลภาค
5. กำหนดอายุ (วัน) · 0 = ไม่หมดอายุ
6. กด **สร้าง Key** → ระบบแสดง Key `stk_…` **ครั้งเดียว** ให้คัดลอกเก็บทันที
   (ระบบเก็บเฉพาะค่า SHA-256 ของ Key ถ้าทำหายต้องสร้างใหม่)
7. ตาราง API Keys แสดงเวลาที่ใช้ล่าสุด, IP ล่าสุด, จำนวนครั้ง · กด **ปิด** เพื่อระงับชั่วคราว หรือ 🗑 เพื่อลบถาวร

### 2.3 หน้าเอกสาร / ทดลองเรียก `/api-docs`
- เปิดจากปุ่ม **เอกสาร API / ทดลองเรียก**
- แสดงทุก endpoint แยกหมวด พร้อมพารามิเตอร์และตัวอย่าง body
- ใส่ Key ในช่องด้านบน แล้วกด **ทดลองเรียก** เพื่อดูผลจริง (ถ้าเว้นว่างจะใช้ session ที่ login อยู่)
- ปุ่ม **คัดลอกคำสั่ง curl** ได้คำสั่งพร้อมใช้

---

## 3. Endpoint หลัก

| Method | Path (`/api/v1` +) | สิทธิ์ | คำอธิบาย |
|---|---|---|---|
| GET | `/health` | ไม่ต้องใช้ Key | สถานะระบบ (ใช้กับ Uptime monitor / load balancer) |
| GET | `/openapi.json` | ไม่ต้องใช้ Key | เอกสาร OpenAPI 3 |
| GET | `/me` | ทุก Key | ตรวจว่า Key ใช้ได้ และสิทธิ์อะไร |
| GET | `/state` | viewer | ภาพรวมทั้งหมดแบบเดียวกับหน้า Dashboard |
| GET | `/events` | viewer | Server-Sent Events อัปเดตเรียลไทม์ |
| GET | `/devices?status=offline&type=switch&q=OPD&history=1` | viewer | รายการอุปกรณ์ (กรองได้) |
| POST | `/devices` | operator | เพิ่มอุปกรณ์ |
| PUT / DELETE | `/devices/{id}` | operator | แก้ไข / ลบอุปกรณ์ |
| POST | `/devices/{id}/check` | operator | สั่งตรวจทันที |
| POST | `/devices/bulk` | operator | เพิ่มหลายรายการ (CSV) |
| GET | `/export.csv` | viewer | ส่งออก CSV |
| GET | `/alerts?status=active&severity=critical&since=…&limit=100` | viewer | รายการแจ้งเตือน |
| POST | `/alerts/{id}/ack` · `/alerts/{id}/resolve` | operator | รับทราบ / ปิดเรื่อง |
| GET | `/reports?mode=day\|month\|year` | viewer | รายงานจาก MySQL |
| GET | `/dbsync` · `/dbsync/history?hours=24` | viewer | สถานะ Master/Slave |
| GET | `/wazuh` | viewer | ข้อมูลที่ดึงจาก Wazuh |
| POST | `/integrations/wazuh` | integration | รับ Alert จาก Wazuh |
| POST | `/inventory/report` | agent | Agent ส่งสเปคเครื่อง |
| GET | `/inventory` · `/inventory/changes` · `/inventory/software` | viewer | ทะเบียนคอมพิวเตอร์ / รายงานการเปลี่ยนแปลง |
| GET | `/ipscan` · `/ipscan/ranges/{id}` | viewer | ผลสแกน IP เทียบทะเบียน |

ทุก response ที่ใช้ Key จะมี header `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

### รหัสผลลัพธ์
| HTTP | ความหมาย |
|---|---|
| 200 / 201 | สำเร็จ |
| 400 | ข้อมูลไม่ถูกต้อง (ดู `error`) |
| 401 | ไม่มี Key / Key ผิด / หมดอายุ / ถูกปิด |
| 403 | สิทธิ์ไม่พอ หรือ IP ไม่อยู่ในรายการที่อนุญาต |
| 404 | ไม่พบข้อมูล |
| 429 | เรียกเกินกำหนด รอตาม `Retry-After` วินาที |

---

## 4. ตัวอย่างการเรียกใช้

### 4.1 curl
```bash
KEY=stk_xxxxxxxxxxxxxxxx
BASE=https://noc.hospital.go.th/api/v1

curl -H "Authorization: Bearer $KEY" $BASE/me
curl -H "Authorization: Bearer $KEY" "$BASE/devices?status=offline"
curl -H "Authorization: Bearer $KEY" "$BASE/alerts?status=active&severity=critical"

# เพิ่มอุปกรณ์ (Key สิทธิ์ operator)
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"name":"SW ตึกผู้ป่วยใน ชั้น 3","ip":"10.10.3.1","type":"switch","parentId":2,"vlan":"30","location":"IPD 3"}' \
  $BASE/devices

# อัปเดตเรียลไทม์
curl -N -H "Authorization: Bearer $KEY" $BASE/events
```
> ทุกคำขอที่ไม่ใช่ GET ต้องส่ง `Content-Type: application/json`

### 4.2 JavaScript (เว็บอื่นในโรงพยาบาล — ต้องใส่ origin ใน CORS ก่อน)
```js
const BASE = 'https://noc.hospital.go.th/api/v1';
const KEY = 'stk_xxxx';   // ใช้ Key viewer เท่านั้น เพราะโค้ดฝั่งเบราว์เซอร์ใครก็เห็น

async function noc(path, opt = {}) {
  const r = await fetch(BASE + path, { ...opt, headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || r.status);
  return j;
}
const { devices } = await noc('/devices?status=offline');
document.querySelector('#down').textContent = `อุปกรณ์ล่ม ${devices.length} ตัว`;
```
> ถ้าเป็นหน้าเว็บสาธารณะ แนะนำให้เรียกผ่าน Back-end ของเว็บนั้น (ข้อ 4.3) แทน จะได้ไม่เปิดเผย Key

### 4.3 PHP (เช่น ระบบรายงานของโรงพยาบาลที่ใช้ PHP อยู่แล้ว)
```php
<?php
function noc_api($path, $method = 'GET', $body = null) {
    $ch = curl_init('https://noc.hospital.go.th/api/v1' . $path);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_HTTPHEADER     => ['Authorization: Bearer ' . getenv('NOC_API_KEY'), 'Content-Type: application/json'],
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body, JSON_UNESCAPED_UNICODE));
    $res = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    $j = json_decode($res, true);
    if ($code >= 400) throw new Exception($j['error'] ?? "HTTP $code");
    return $j;
}
$alerts = noc_api('/alerts?status=active');
foreach ($alerts['alerts'] as $a) echo $a['severity'] . ' : ' . $a['message'] . "\n";
```
> เก็บ Key ใน environment variable หรือไฟล์ config นอก web root ห้ามเขียนลงโค้ดที่ขึ้น git

### 4.4 Python
```python
import os, requests
BASE = "https://noc.hospital.go.th/api/v1"
H = {"Authorization": f"Bearer {os.environ['NOC_API_KEY']}"}

r = requests.get(f"{BASE}/devices", params={"status": "offline"}, headers=H, timeout=10)
r.raise_for_status()
for d in r.json()["devices"]:
    print(d["name"], d["ip"], d["status"])
```

### 4.5 Power BI / Excel
Get Data → **Web** → Advanced → URL `https://…/api/v1/devices` → HTTP request header `Authorization` = `Bearer stk_…`

---

## 5. ถ้าจะสร้าง API ของตัวเองเพื่อเชื่อมฐานข้อมูล (แนวทาง)

ตัวอย่างโครงสร้าง endpoint ที่อ่านจาก MySQL อย่างปลอดภัย (Node.js + mysql2):
```js
// GET /api/v1/visits?date=2026-11-05   →   { date, total, rows:[...] }
if (p === '/api/visits' && m === 'GET') {
  need(user, 'viewer');                                   // 1) ตรวจสิทธิ์
  const date = q.get('date') || today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw bad('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');   // 2) ตรวจข้อมูล
  const [rows] = await pool.execute(                       // 3) ใช้ placeholder (?) เสมอ ป้องกัน SQL injection
    'SELECT main_dep, COUNT(*) AS n FROM ovst WHERE vstdate = ? GROUP BY main_dep', [date]);
  return send(res, 200, { date, total: rows.reduce((a, r) => a + r.n, 0), rows });   // 4) ส่ง JSON
}
```
ข้อควรจำ
1. ผู้ใช้ฐานข้อมูลของ API ให้สิทธิ์ `SELECT` เฉพาะตารางที่ต้องใช้ (ห้ามใช้ root / ผู้ใช้ของ HOSxP)
2. ใช้ placeholder `?` ทุกครั้ง ห้ามต่อ string SQL จากค่าที่ผู้ใช้ส่งมา
3. จำกัดจำนวนแถว (`LIMIT`) และตั้ง timeout ของ query
4. ส่งเฉพาะคอลัมน์ที่จำเป็น โดยเฉพาะข้อมูลผู้ป่วยตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล
5. เปิดใช้ผ่าน HTTPS เสมอเมื่อส่ง Key ข้ามเครือข่าย

---

## 6. ความปลอดภัยของ API Key
- Key ถูกเก็บเป็น SHA-256 hash ใน `data/db.json` (ไม่มีใครดูย้อนกลับได้ รวมถึง admin)
- Key ไม่สามารถ: เปลี่ยนรหัสผ่าน, จัดการผู้ใช้, สร้าง/ลบ Key, แก้ตั้งค่า API, กู้คืนข้อมูล
- Key ประเภท `integration` ใช้ได้เฉพาะ `/integrations/wazuh` และ `/me`
- ถ้าสงสัยว่า Key รั่ว: กด **ปิด** หรือ **ลบ** ทันที แล้วสร้างใหม่ ดู “IP ล่าสุด” เพื่อตรวจสอบย้อนหลัง
