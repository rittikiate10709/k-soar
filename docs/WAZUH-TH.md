# คู่มือเชื่อมต่อ Wazuh SIEM (Wazuh Server API / RESTful API) — v1.3.0

Smart Topology เชื่อมกับ Wazuh ได้ **3 ทิศทาง**

| # | ทิศทาง | ใช้ทำอะไร | วิธี |
|---|---|---|---|
| ① | Smart Topology **ดึง** จาก Wazuh | สถานะ Manager/Daemons, Agents, **สถิติ Component** (analysisd, remoted, alerts รายชั่วโมง), **Configuration**, ผลตรวจ **SCA (CIS Benchmark)** และ **CIS-CAT** | Wazuh Server API พอร์ต 55000 (JWT) |
| ② | Smart Topology **ส่ง** เข้า Wazuh | การแจ้งเตือนอุปกรณ์ล่ม/ช้า/ฐานข้อมูลไม่ sync กลายเป็น alert ใน Wazuh Dashboard | `POST /events` (Wazuh 4.6+) + ไฟล์ rule |
| ③ | Wazuh **ส่ง** มา Smart Topology | Alert ระดับสูง (เช่น brute force, ransomware, FIM) ขึ้นหน้าแจ้งเตือน NOC และส่งต่อหมอพร้อม/LINE | Wazuh custom integration → `POST /api/v1/integrations/wazuh` |

```
          ① GET  /manager/*, /agents, /sca, /ciscat  (JWT)
 ┌────────────────────┐ ───────────────────────────────▶ ┌──────────────────────┐
 │  Smart Topology    │ ② POST /events {"events":[…]}    │  Wazuh Manager       │
 │  NOC  :3000        │ ───────────────────────────────▶ │  API :55000          │
 │                    │ ◀─────────────────────────────── │  integratord         │
 └────────────────────┘ ③ POST /api/v1/integrations/wazuh └──────────────────────┘
                          (Bearer API Key ประเภท integration)
```

ทดสอบกับ Wazuh 4.14 (รูปแบบข้อมูลตามเอกสาร Wazuh Server API) ใช้ได้กับ 4.x · ข้อ ② ต้องเป็น Wazuh **4.6 ขึ้นไป**

---

## ขั้นที่ 1 — เตรียม Wazuh Manager

### 1.1 เปิด Firewall พอร์ต 55000 ให้เฉพาะเครื่อง Smart Topology
บนเครื่อง Wazuh Manager (AlmaLinux / RHEL)
```bash
sudo firewall-cmd --permanent --new-zone=noc 2>/dev/null
sudo firewall-cmd --permanent --zone=noc --add-source=172.16.1.20/32      # IP เครื่อง Smart Topology
sudo firewall-cmd --permanent --zone=noc --add-port=55000/tcp
sudo firewall-cmd --reload
```
ทดสอบจากเครื่อง Smart Topology:
```bash
curl -k -u wazuh-wui:<รหัส> -X POST "https://WAZUH-IP:55000/security/user/authenticate?raw=true"
# ได้ข้อความยาว ๆ (JWT token) = เชื่อมต่อได้
```

### 1.2 สร้างผู้ใช้ API เฉพาะสำหรับ Smart Topology (แนะนำ — ไม่ใช้ wazuh / wazuh-wui)
ทำบนเครื่อง Manager ด้วยผู้ใช้ `wazuh` (administrator) ครั้งเดียว

```bash
API=https://localhost:55000
TOKEN=$(curl -sk -u wazuh:<รหัส-admin> -X POST "$API/security/user/authenticate?raw=true")
H=(-sk -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# 1) policy อ่านข้อมูล Manager / Cluster + ส่ง events
curl "${H[@]}" -X POST $API/security/policies -d '{
  "name":"smart_topology_manager",
  "policy":{"actions":["manager:read","cluster:read","cluster:status","event:ingest"],"resources":["*:*:*"],"effect":"allow"}}'

# 2) policy อ่านข้อมูล Agents / SCA / CIS-CAT
curl "${H[@]}" -X POST $API/security/policies -d '{
  "name":"smart_topology_agents",
  "policy":{"actions":["agent:read","sca:read","ciscat:read"],"resources":["agent:id:*"],"effect":"allow"}}'

# 3) role + ผูก policy   (แทน <P1>,<P2> ด้วย id ที่ได้จากข้อ 1–2 · ดูได้จาก GET /security/policies)
curl "${H[@]}" -X POST $API/security/roles -d '{"name":"smart_topology"}'
curl "${H[@]}" -X POST "$API/security/roles/<ROLE_ID>/policies?policy_ids=<P1>,<P2>"

# 4) user + ผูก role   (รหัสผ่าน 8–64 ตัว ต้องมีตัวใหญ่ ตัวเล็ก ตัวเลข และอักขระพิเศษ)
curl "${H[@]}" -X POST $API/security/users -d '{"username":"smart-topology","password":"N0c#Kalasin2026"}'
curl "${H[@]}" -X POST "$API/security/users/<USER_ID>/roles?role_ids=<ROLE_ID>"

# 5) ตรวจสิทธิ์ของผู้ใช้ใหม่
T2=$(curl -sk -u 'smart-topology:N0c#Kalasin2026' -X POST "$API/security/user/authenticate?raw=true")
curl -sk -H "Authorization: Bearer $T2" "$API/security/users/me/policies?pretty=true"
```
> ถ้าไม่ต้องการส่ง events เข้า Wazuh (ข้อ ②) ให้ตัด `event:ingest` ออก
> ถ้าต้องการเร็ว ๆ เพื่อทดสอบ สามารถผูก role สำเร็จรูป `readonly` แทนข้อ 1–3 ได้ (แต่จะไม่มี `event:ingest`)
> ทำผ่านหน้า Wazuh Dashboard ได้เช่นกัน: ☰ → **Server management → Security** → Policies / Roles / Users

---

## ขั้นที่ 2 — ตั้งค่าใน Smart Topology (ดึงข้อมูล ①)

เมนู **Wazuh SIEM → ตั้งค่า** (admin) แท็บ **1. Wazuh API**

| ช่อง | ตัวอย่าง | หมายเหตุ |
|---|---|---|
| เปิดการดึงข้อมูล | ✔ | |
| URL ของ Wazuh Server API | `https://172.16.1.30:55000` | ไม่ใช่ URL ของ Dashboard (443) |
| ชื่อผู้ใช้ / รหัสผ่าน | `smart-topology` / `…` | รหัสผ่านเก็บในเซิร์ฟเวอร์ แสดงเป็น •••••••• |
| ตรวจสอบใบรับรอง TLS | ปิด | Wazuh ติดตั้งมาพร้อม self-signed certificate · เปิดเมื่อใช้ใบรับรองที่ออกโดย CA ภายใน |
| ดึงข้อมูลทุก (นาที) | 5 | |
| ดึงผล SCA/CIS-CAT สูงสุด | 20 เครื่อง/รอบ | ลดลงถ้ามี Agent หลายร้อยเครื่อง |
| แจ้งเตือนเมื่อ Agent ขาดการเชื่อมต่อ | ✔ | สร้างการแจ้งเตือน “Wazuh agent … ขาดการเชื่อมต่อ” และปิดเองเมื่อกลับมา |

1. กด **ทดสอบการเชื่อมต่อ** → ต้องได้ “✓ เชื่อมต่อสำเร็จ — Wazuh v4.x.x”
2. กด **บันทึก** → ระบบดึงข้อมูลทันที

### สิ่งที่แสดงในหน้า Wazuh SIEM และ API ที่ใช้
| ส่วนของหน้า | Wazuh API endpoint | สิทธิ์ |
|---|---|---|
| ยืนยันตัวตน (JWT อายุ 900 วินาที ต่ออายุอัตโนมัติ) | `POST /security/user/authenticate?raw=true` | — |
| เวอร์ชัน / API | `GET /` · `GET /manager/info` | manager:read |
| Daemons (running/stopped) | `GET /manager/status` | manager:read |
| ตรวจไฟล์ ossec.conf | `GET /manager/configuration/validation` | manager:read |
| Cluster | `GET /cluster/status` | cluster:status |
| Agents ทำงาน/ขาดการเชื่อมต่อ | `GET /agents/summary/status` · `GET /agents` | agent:read |
| **สถิติ Component** analysisd / remoted (events, queue usage, dropped, TCP sessions) | `GET /manager/daemons/stats?daemons_list=wazuh-analysisd,wazuh-remoted` (สำรอง: `/manager/stats/analysisd`, `/manager/stats/remoted`) | manager:read |
| กราฟ Alerts/Events รายชั่วโมงวันนี้ | `GET /manager/stats` | manager:read |
| **ค่า Configuration** (เลือก section เช่น global, syscheck, sca, vulnerability-detection) | `GET /manager/configuration?section=…` | manager:read (admin ของ Smart Topology เท่านั้น) |
| **SCA** คะแนนต่อ policy, ข้อที่ผ่าน/ไม่ผ่าน พร้อมเหตุผลและวิธีแก้ | `GET /sca/{agent_id}` · `GET /sca/{agent_id}/checks/{policy_id}?result=failed` | sca:read |
| **CIS-CAT** | `GET /ciscat/{agent_id}/results` | ciscat:read |

**อ่านผล SCA / CIS-CAT**
- คะแนน ≥ 80% เขียว · 60–79% เหลือง · < 60% แดง
- กด **รายละเอียด** ที่เครื่อง → **ดูข้อที่ไม่ผ่าน** จะเห็นหัวข้อ CIS (เช่น 5.2.10 SSH root login) เหตุผล และวิธีแก้ไข ใช้วางแผนปรับ hardening ทีละข้อ
- **SCA** มากับ Wazuh agent อยู่แล้ว · **CIS-CAT** ต้องติดตั้ง CIS-CAT Pro (ต้องมี license CIS SecureSuite) และ Java บน agent แล้วเปิด `<wodle name="cis-cat">` — ถ้าไม่ได้ติดตั้งคอลัมน์ CIS-CAT จะเป็น “—”

---

## ขั้นที่ 3 — ส่งการแจ้งเตือนเข้า Wazuh (②)

### 3.1 ติดตั้งไฟล์ rule บน Wazuh Manager
Wazuh รับ event ได้ แต่จะสร้าง alert ก็ต่อเมื่อมี rule ตรงกัน
1. ดาวน์โหลด `smart_topology_rules.xml` (ลิงก์อยู่ในหน้าตั้งค่า แท็บ 2 หรือ `https://NOC/integrations/wazuh/smart_topology_rules.xml`)
2. บนเครื่อง Manager
   ```bash
   sudo cp smart_topology_rules.xml /var/ossec/etc/rules/
   sudo chown wazuh:wazuh /var/ossec/etc/rules/smart_topology_rules.xml
   sudo chmod 660 /var/ossec/etc/rules/smart_topology_rules.xml
   sudo /var/ossec/bin/wazuh-analysisd -t          # ตรวจไฟล์ ไม่มี error
   sudo systemctl restart wazuh-manager
   ```
3. ทดสอบ rule ด้วย `wazuh-logtest`
   ```bash
   sudo /var/ossec/bin/wazuh-logtest
   # วางบรรทัดนี้แล้ว Enter
   {"integration":"smart-topology","st":{"event":"alert_raised","severity":"critical","kind":"down","message":"Core Switch (10.0.0.1) ไม่ตอบสนอง ICMP","device":{"id":4,"name":"Core Switch","ip":"10.0.0.1"}}}
   # ต้องเห็น  id: '100505'  level: '12'  description: 'Smart Topology (critical): ...'
   ```

| Rule | Level | เงื่อนไข |
|---|---|---|
| 100500 | 0 | event ทั้งหมดจาก Smart Topology (rule แม่) |
| 100501 | 3 | แก้ไขแล้ว (`alert_resolved`) |
| 100502 | 3 | ทดสอบการเชื่อมต่อ |
| 100503 | 5 | info |
| 100504 | 8 | warning (latency สูง, Replication ล่าช้า) |
| 100505 | 12 | critical (อุปกรณ์ล่ม, Replication หยุด) |

> ถ้าเลข rule 100500–100505 ชนกับ rule ภายในของโรงพยาบาล ให้เปลี่ยนเลขในไฟล์ (ช่วง 100000–120000 สำหรับ custom rule)

### 3.2 เปิดการส่งใน Smart Topology
**Wazuh SIEM → ตั้งค่า → แท็บ 2. ส่ง Event เข้า Wazuh**
1. ติ๊ก **ส่งการแจ้งเตือนของ Smart Topology เข้า Wazuh**
2. เลือกระดับขั้นต่ำ (`warning` แนะนำ)
3. **บันทึก** แล้วกด **ส่ง Event ทดสอบ** บนแถบด้านบน → ควรได้ “All events were forwarded to analisysd”
4. ใน Wazuh Dashboard → **Threat Hunting / Discover** ค้น `rule.groups: smart_topology` หรือ `data.integration: smart-topology`

รายละเอียดทางเทคนิค
- ใช้ `POST /events` body `{"events":["<json string>", …]}` (สูงสุด 100 event ต่อคำขอ, 30 คำขอต่อนาทีตามข้อจำกัดของ Wazuh)
- Smart Topology รวมส่งทุก 10 วินาที ถ้า Wazuh ไม่ตอบจะเก็บคิวไว้ส่งใหม่ (ดู “Event ที่ส่งเข้า Wazuh” ในหน้า)
- Alert ที่มาจาก Wazuh เอง (ข้อ ③) จะ**ไม่ถูกส่งกลับ** ป้องกันวนซ้ำ

ตัวอย่าง event ที่ส่ง
```json
{"integration":"smart-topology","st":{"event":"alert_raised","severity":"critical","original_severity":"critical","kind":"down",
 "message":"Core Switch (10.0.0.1) ไม่ตอบสนอง ICMP","device":{"id":4,"name":"Core Switch","ip":"10.0.0.1"},
 "alert_id":120,"site":"โรงพยาบาลกาฬสินธุ์","time":"2026-11-05T02:00:00.000Z"}}
```

---

## ขั้นที่ 4 — รับ Alert จาก Wazuh (③)

### 4.1 สร้าง API Key ประเภท Integration
**Wazuh SIEM → ตั้งค่า → แท็บ 3. รับ Alert จาก Wazuh → สร้าง Key สำหรับ Wazuh**
ระบบจะแสดง Key พร้อมโค้ด `<integration>` ที่ใส่ Key ให้แล้ว คัดลอกเก็บไว้
(Key ประเภทนี้ส่ง Alert เข้าได้อย่างเดียว อ่าน/แก้ข้อมูลอื่นไม่ได้ · แนะนำจำกัด IP เป็น IP ของ Wazuh Manager)

### 4.2 ติดตั้งสคริปต์บน Wazuh Manager
```bash
# ดาวน์โหลดจาก Smart Topology
curl -o /var/ossec/integrations/custom-smarttopology https://NOC-IP:3000/integrations/wazuh/custom-smarttopology
sudo chmod 750 /var/ossec/integrations/custom-smarttopology
sudo chown root:wazuh /var/ossec/integrations/custom-smarttopology
```
- ชื่อไฟล์ต้องขึ้นต้นด้วย `custom-` ตามข้อกำหนดของ Wazuh
- สคริปต์ใช้ Python ที่มากับ Wazuh (`/var/ossec/framework/python/bin/python3`) ไม่ต้องติดตั้งเพิ่ม
- ถ้า Smart Topology ใช้ HTTPS แบบ self-signed ให้แก้ `VERIFY_TLS = False` ในสคริปต์

### 4.3 เพิ่มใน `/var/ossec/etc/ossec.conf` (ภายใน `<ossec_config>`)
```xml
<integration>
  <name>custom-smarttopology</name>
  <hook_url>https://NOC-IP:3000/api/v1/integrations/wazuh</hook_url>
  <api_key>stk_xxxxxxxxxxxxxxxx</api_key>
  <level>7</level>
  <alert_format>json</alert_format>
</integration>
```
ส่งเฉพาะบาง rule/กลุ่มได้ เช่น `<group>authentication_failed,syscheck,</group>` หรือ `<rule_id>5712,100900</rule_id>`

```bash
sudo systemctl restart wazuh-manager
sudo tail -f /var/ossec/logs/integrations.log      # ดูผลการส่ง: "→ HTTP 200"
```

### 4.4 ตั้งเงื่อนไขใน Smart Topology (แท็บ 3)
| ช่อง | ค่าแนะนำ | ความหมาย |
|---|---|---|
| รับเฉพาะ rule level ≥ | 7 | ต่ำกว่านี้บันทึกในรายการแต่ไม่สร้างการแจ้งเตือน |
| ส่งแจ้งเตือนภายนอก เมื่อ level ≥ | 12 | ส่งต่อหมอพร้อม / LINE / Telegram |
| ปิดอัตโนมัติเมื่อไม่พบซ้ำภายใน | 60 นาที | |

การแปลงระดับ: level ≥ 12 → **วิกฤต** · 7–11 → **เตือน** · ต่ำกว่า → **ข้อมูล**
Alert ที่ IP ของ agent ตรงกับอุปกรณ์ใน Smart Topology จะผูกกับอุปกรณ์นั้น (เห็นในหน้า detail ของอุปกรณ์)
Alert ซ้ำ (rule + agent เดิม) จะรวมเป็นรายการเดียวพร้อมนับจำนวนครั้ง ไม่แจ้งเตือนรัว

### 4.5 ทดสอบโดยไม่ต้องรอเหตุการณ์จริง
```bash
cat > /tmp/test-alert.json <<'EOF'
{"timestamp":"2026-11-05T09:00:00.000+0700","rule":{"level":10,"description":"sshd: brute force trying to get access to the system.","id":"5712","groups":["syslog","sshd","authentication_failures"]},
 "agent":{"id":"001","name":"his-db-master","ip":"172.16.1.10"},"id":"1730772000.1","location":"/var/log/secure"}
EOF
sudo /var/ossec/integrations/custom-smarttopology /tmp/test-alert.json stk_xxxxxxxx https://NOC-IP:3000/api/v1/integrations/wazuh
tail -1 /var/ossec/logs/integrations.log
```
เปิดหน้า **การแจ้งเตือน** ของ Smart Topology จะเห็น `[Wazuh L10] sshd: brute force …` และในหน้า Wazuh SIEM ส่วน “Alert ที่รับจาก Wazuh”

---

## แก้ปัญหา
| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| เชื่อมต่อไม่ได้ (ECONNREFUSED / timeout) | ตรวจ IP/พอร์ต 55000, firewall ข้อ 1.1, `systemctl status wazuh-manager` |
| ใบรับรอง TLS ไม่ผ่าน | ปิด “ตรวจสอบใบรับรอง TLS” หรือใช้ใบรับรองที่ออกโดย CA ที่เซิร์ฟเวอร์เชื่อถือ |
| ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง (401) | ทดสอบด้วย curl ข้อ 1.1 · ผู้ใช้ถูกล็อกชั่วคราวหลังกรอกผิดหลายครั้ง (ค่า `max_login_attempts` ของ API) |
| บางส่วนขึ้น “สิทธิ์ไม่พอ” (403) | ผู้ใช้ API ขาด action นั้น ตรวจด้วย `GET /security/users/me/policies` |
| ส่ง Event ไม่สำเร็จ 404/405 | Wazuh เก่ากว่า 4.6 ไม่มี `POST /events` — อัปเกรด Wazuh หรือปิดการส่ง |
| ส่ง Event สำเร็จแต่ไม่เห็น alert | ยังไม่ได้ติดตั้ง rule ข้อ 3.1 หรือ level ต่ำกว่าเกณฑ์ที่ Dashboard แสดง |
| integrations.log: HTTP 401 | Key ผิด/ถูกปิด/หมดอายุ |
| integrations.log: HTTP 403 | Key ไม่ใช่ประเภท integration หรือ IP ของ Manager ไม่อยู่ใน allowlist ของ Key |
| integrations.log ไม่มีอะไรเลย | ชื่อสคริปต์ไม่ตรง `<name>`, สิทธิ์ไฟล์ไม่ถูก, หรือยังไม่ restart manager · ตรวจ `ossec.log` |

## อ้างอิง
- Wazuh Server API — Getting started: https://documentation.wazuh.com/current/user-manual/api/getting-started.html
- Wazuh RBAC reference: https://documentation.wazuh.com/current/user-manual/api/rbac/reference.html
- Wazuh API reference: https://documentation.wazuh.com/current/user-manual/api/reference.html
- Integration with external APIs: https://documentation.wazuh.com/current/user-manual/manager/integration-with-external-apis.html
