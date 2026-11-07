# คู่มือทะเบียนเครื่องคอมพิวเตอร์ (Agent) และสแกน IP — v1.4.0

v1.4.0 เพิ่ม 2 ส่วน

| ส่วน | ทำอะไร |
|---|---|
| **ทะเบียนคอมพิวเตอร์** | Agent บนเครื่องลูกข่าย (Windows / Linux) ส่งสเปคเข้า Smart Topology อัตโนมัติ ได้แก่ OS + เวอร์ชัน, CPU, RAM (รายสล็อต), ฮาร์ดดิสก์ (รุ่น/ขนาด/SSD-HDD-NVMe/Serial), พื้นที่ไดรฟ์, การ์ดจอ, การ์ดเครือข่าย (IP/MAC), ยี่ห้อ/รุ่น/Serial เครื่อง, BIOS, Antivirus, จอภาพ, ซอฟต์แวร์ที่ติดตั้ง · ทุกการเปลี่ยนแปลงเก็บเป็น log และออกรายงาน **รายวัน / รายเดือน / รายปี / ช่วงวันที่ที่กำหนดเอง** |
| **สแกน IP** | กำหนดช่วง IP ที่จะสแกน (CIDR หรือ ช่วงเริ่ม–สิ้นสุด) แล้วนับ IP ที่ใช้งานจริง เทียบกับทะเบียนคอมพิวเตอร์และอุปกรณ์เครือข่าย เพื่อหาเครื่องที่ไม่อยู่ในทะเบียน และเครื่องในทะเบียนที่หายไป |

```
 เครื่องลูกข่าย (Windows / Linux)                      Smart Topology                          
 ┌──────────────────────────┐  POST /api/v1/inventory/report   ┌──────────────────────────────┐
 │ smart-topology-agent      │ ───────────────────────────────▶ │ จับคู่เครื่อง → เทียบค่าเดิม     │──▶ inventory.json
 │ (Task Scheduler / systemd)│  Bearer stk_… (API Key: agent)   │ → บันทึกการเปลี่ยนแปลง          │──▶ MySQL nms_asset_change
 │ ทุก 60 นาที + หลังเปิดเครื่อง │                                  │ → แจ้งเตือนถ้าฮาร์ดแวร์ถูกถอด    │──▶ แจ้งเตือน / หมอพร้อม
 └──────────────────────────┘                                   └──────────────┬───────────────┘
                                                      สแกน IP (ping + TCP) ◀────┘ เทียบกับทะเบียน
```

---

## ส่วนที่ 1 — ทะเบียนเครื่องคอมพิวเตอร์

### 1.1 สร้าง API Key สำหรับ Agent (ทำครั้งเดียว)
1. เมนู **ทะเบียนคอมพิวเตอร์ → ติดตั้ง Agent → สร้าง Agent Key + คำสั่งติดตั้ง** (admin)
   (หรือ ตั้งค่า → การเชื่อมต่อแบบ API → สร้าง API Key → สิทธิ์ “Agent เครื่องลูกข่าย”)
2. ตั้งอายุ 0 = ไม่หมดอายุ · ถ้าต้องการจำกัด IP ให้ใส่ช่วง IP ของเครื่องลูกข่าย เช่น `172.16.0.0/16`
3. ระบบแสดง Key `stk_…` พร้อมคำสั่งติดตั้งที่ใส่ Key ให้แล้ว — **คัดลอกเก็บไว้** (แสดงครั้งเดียว)

> Key ประเภท agent ส่งรายงานสเปคได้อย่างเดียว อ่านข้อมูลอื่นไม่ได้ (เรียก endpoint อื่นได้ HTTP 403) จึงใช้ Key เดียวกันทุกเครื่องได้
> ถ้า Key รั่ว: ปิด Key เดิม สร้างใหม่ แล้วติดตั้งทับ (install-agent จะเขียน config ใหม่)

### 1.2 ติดตั้ง Agent บน Windows (ทีละเครื่อง)
รองรับ Windows 7 SP1 (ต้องติดตั้ง WMF 5.1) / 8.1 / 10 / 11 / Server 2012 R2 ขึ้นไป

1. คลิกขวา Start → **Windows PowerShell (Admin)** / **Terminal (Admin)**
2. วางคำสั่งที่ได้จากข้อ 1.1 เช่น
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing https://noc.hospital.local:3000/agent/windows/install-agent.ps1 -OutFile $env:TEMP\st-install.ps1; & $env:TEMP\st-install.ps1 -Server https://noc.hospital.local:3000 -Key stk_xxxxxxxx"
   ```
3. สคริปต์จะ
   - คัดลอก Agent ไปที่ `C:\ProgramData\SmartTopology\smart-topology-agent.ps1`
   - เขียน `config.json` (server + key) และจำกัดสิทธิ์โฟลเดอร์ให้เฉพาะ SYSTEM / Administrators
   - สร้าง Scheduled Task 2 รายการ (รันเป็น SYSTEM): **SmartTopology Agent** ทุก 60 นาที และ **SmartTopology Agent (Startup)** หลังเปิดเครื่อง 2 นาที
   - ส่งรายงานครั้งแรกทันที แล้วแสดงผลจาก `agent.log`
4. เปิดหน้า **ทะเบียนคอมพิวเตอร์** จะเห็นเครื่องขึ้นมาภายในไม่กี่วินาที

ตัวเลือกของ `install-agent.ps1`
| พารามิเตอร์ | ความหมาย |
|---|---|
| `-IntervalMinutes 60` | รอบการส่ง (5–1439 นาที) |
| `-SkipCertCheck` | Smart Topology ใช้ HTTPS แบบ self-signed |
| `-NoSoftware` | ไม่ส่งรายการซอฟต์แวร์ |
| `-Uninstall` | ถอนการติดตั้ง (ลบ Task + โฟลเดอร์) |

ทดสอบโดยไม่ส่งข้อมูล: `powershell -ExecutionPolicy Bypass -File C:\ProgramData\SmartTopology\smart-topology-agent.ps1 -Print`

### 1.3 ติดตั้งทั้งโรงพยาบาลด้วย GPO (Active Directory)
1. ดาวน์โหลด 3 ไฟล์จากหน้า ติดตั้ง Agent: `install-agent.cmd`, `install-agent.ps1`, `smart-topology-agent.ps1`
2. แก้ `install-agent.cmd` 2 บรรทัด
   ```bat
   set SERVER=https://noc.hospital.local:3000
   set KEY=stk_xxxxxxxx
   ```
3. วางทั้ง 3 ไฟล์ในโฟลเดอร์แชร์ที่ **Domain Computers อ่านได้** เช่น `\\KLSH\NETLOGON\smart-topology\`
4. Group Policy Management → สร้าง GPO ผูกกับ OU ของเครื่องลูกข่าย →
   **Computer Configuration → Policies → Windows Settings → Scripts (Startup/Shutdown) → Startup → Add**
   - Script Name: `\\KLSH\NETLOGON\smart-topology\install-agent.cmd`
   - Script Parameters: `/gpo`
5. เครื่องจะติดตั้งเองตอนเปิดเครื่องครั้งถัดไป (`/gpo` = ข้ามถ้าติดตั้งแล้ว และไม่รอกดปุ่ม) · ทดสอบเครื่องเดียวด้วย `gpupdate /force` แล้ว restart

> ไม่มี AD: คัดลอก 3 ไฟล์ลง USB / แชร์ไดรฟ์ แล้วคลิกขวา `install-agent.cmd` → Run as administrator

### 1.4 ติดตั้ง Agent บน Linux
Ubuntu / Debian / AlmaLinux / Rocky (Python 3.6+, systemd)
```bash
curl -fsSL https://noc.hospital.local:3000/agent/linux/install-agent.sh -o /tmp/st-install.sh
sudo sh /tmp/st-install.sh --server https://noc.hospital.local:3000 --key stk_xxxxxxxx [--interval 60] [--insecure]
# แนะนำ: sudo dnf install dmidecode pciutils   (อ่าน RAM รายสล็อต และการ์ดจอ)
```
- ติดตั้งที่ `/usr/local/bin/smart-topology-agent`, config `/etc/smart-topology-agent.json` (สิทธิ์ 600)
- systemd timer `smart-topology-agent.timer` · ดูผล `systemctl list-timers` และ `/var/log/smart-topology-agent.log`
- ทดสอบ `python3 /usr/local/bin/smart-topology-agent --print` · ถอน `sudo sh install-agent.sh --uninstall`

### 1.5 ข้อมูลที่ Agent เก็บ
| หมวด | Windows (WMI/CIM + Registry) | Linux |
|---|---|---|
| OS | Win32_OperatingSystem + DisplayVersion (22H2/23H2) + UBR | /etc/os-release, kernel |
| CPU | Win32_Processor (รุ่น, คอร์, เธรด, MHz) | /proc/cpuinfo |
| RAM | Win32_PhysicalMemory (ขนาด/ชนิด DDR/ความเร็ว/ยี่ห้อ/สล็อต) | /proc/meminfo, dmidecode -t 17 |
| ดิสก์ | MSFT_PhysicalDisk (SSD/HDD/NVMe, Serial, สุขภาพ) — ไม่นับ USB | lsblk |
| พื้นที่ไดรฟ์ | Win32_LogicalDisk | /proc/mounts + statvfs |
| การ์ดจอ | Win32_VideoController + VRAM จาก Registry | lspci |
| เครือข่าย | Win32_NetworkAdapterConfiguration | ip -j addr |
| เครื่อง | ยี่ห้อ, รุ่น, Serial, UUID, BIOS, ชนิด (Desktop/Laptop) | /sys/class/dmi/id |
| อื่น ๆ | Antivirus (SecurityCenter2), จอภาพ (WmiMonitorID), ผู้ใช้ที่ล็อกอิน, Domain | ผู้ใช้ที่ล็อกอิน |
| ซอฟต์แวร์ | Uninstall Registry (64/32-bit) | dpkg / rpm |

**การจับคู่เครื่อง:** agentId (สร้างครั้งแรกเก็บใน `agent-id`) → UUID + Serial → MAC → ชื่อเครื่อง · เปลี่ยนชื่อเครื่อง / เปลี่ยน IP ยังเป็นรายการเดิม

### 1.6 หน้า “รายการเครื่อง”
- การ์ดสรุป: เครื่องที่ใช้งาน, Agent ออนไลน์, **ขาดการรายงาน** (เกิน N วัน — เครื่องเสีย/ย้าย/ถอด Agent), การเปลี่ยนแปลง 24 ชม. / 7 วัน
- กราฟสัดส่วน OS / CPU / RAM / ชนิดดิสก์ — ใช้วางแผนจัดซื้อ เช่น จำนวนเครื่อง RAM 4 GB, ยังใช้ HDD, ยังเป็น Windows 7
- ตาราง: ค้นหา / กรองสถานะ / หน่วยงาน / เรียง · ป้ายแดง “C: ใกล้เต็ม” เมื่อพื้นที่ว่างน้อยกว่าที่ตั้งไว้
- คลิกเครื่อง → รายละเอียดสเปคทั้งหมด, ซอฟต์แวร์, **ไทม์ไลน์การเปลี่ยนแปลง**
- **แก้ไขทะเบียน**: เลขครุภัณฑ์, หน่วยงาน, สถานที่, ผู้รับผิดชอบ, วันที่ซื้อ, หมดประกัน, สถานะ (ใช้งาน/สำรอง/ส่งซ่อม/จำหน่าย), ผูกกับอุปกรณ์เครือข่าย — การแก้ไขก็ถูกบันทึกในประวัติ
- **ลงทะเบียนเอง**: เครื่องที่ติดตั้ง Agent ไม่ได้ (เช่น เครื่องควบคุมเครื่องมือแพทย์, Windows XP) — เมื่อติดตั้ง Agent ภายหลัง ระบบจะเชื่อมกับรายการเดิมด้วยชื่อเครื่อง/MAC/IP
- **CSV**: ส่งออกทะเบียนทั้งหมดเปิดใน Excel

### 1.7 รายงานการเปลี่ยนแปลง
เมนู **ทะเบียนคอมพิวเตอร์ → รายงานการเปลี่ยนแปลง**
1. เลือก **รายวัน** (กราฟรายชั่วโมง), **รายเดือน** (รายวัน), **รายปี** (รายเดือน) หรือ **กำหนดช่วงวันที่** (ไม่เกิน 3 เดือน = รายวัน, มากกว่านั้น = รายเดือน, สูงสุด 3 ปี)
2. ปุ่ม ◀ ▶ เลื่อนช่วงก่อน/ถัดไป · กรองหน่วยงาน · ค้นหา · กดป้ายหมวดเพื่อเลือกเฉพาะหมวด
3. ผลที่ได้
   - การ์ด: จำนวนการเปลี่ยนแปลง (เทียบช่วงก่อนหน้า %), จำนวนเครื่องที่เปลี่ยน, ลงทะเบียนใหม่, ฮาร์ดแวร์เปลี่ยน
   - กราฟแท่งซ้อนตามหมวด (ลงทะเบียนใหม่ · OS · ฮาร์ดแวร์ · เครือข่าย · ซอฟต์แวร์ · BIOS · ข้อมูลทะเบียน · ลบออก)
   - เครื่องที่เปลี่ยนแปลงบ่อยที่สุด, ประเภทการเปลี่ยนแปลงที่พบมาก, รายการทั้งหมด (ค่าเดิม → ค่าใหม่)
4. **CSV** ดาวน์โหลดรายการ (สูงสุด 5,000 รายการต่อครั้ง)

ตัวอย่างการเปลี่ยนแปลงที่ตรวจจับได้
| หมวด | ตัวอย่าง |
|---|---|
| ระบบปฏิบัติการ | Windows 10 → Windows 11, อัปเดต build 19045.4291 → 19045.5011 |
| ฮาร์ดแวร์ | RAM 8 GB → 16 GB, **RAM ลดลง** (แจ้งเตือน), ติดตั้ง/ถอดดิสก์, เปลี่ยน CPU, การ์ดจอ, Serial/รุ่นเครื่องเปลี่ยน |
| เครือข่าย | IP เปลี่ยน, การ์ดเครือข่าย (MAC) ใหม่ |
| ซอฟต์แวร์ | ติดตั้ง / ถอน / อัปเดตโปรแกรม |
| BIOS | อัปเดต BIOS |

การเปลี่ยนแปลงที่อาจเป็นการถอดอุปกรณ์ (RAM ลดลง, ถอดดิสก์, เปลี่ยน CPU/Serial/เมนบอร์ด) จะสร้าง**การแจ้งเตือน**และส่งต่อช่องทางหมอพร้อม/LINE ที่ตั้งไว้ (ปิดได้ในหน้าตั้งค่า)

### 1.8 ค้นหาซอฟต์แวร์
พิมพ์ชื่อโปรแกรม เช่น `HOSxP`, `AnyDesk`, `TeamViewer` → เห็นทุกเครื่องที่ติดตั้ง + สรุปจำนวนต่อเวอร์ชัน ใช้ตรวจเวอร์ชันที่ยังไม่อัปเดต หรือโปรแกรมควบคุมระยะไกลที่ไม่ได้รับอนุญาต

### 1.9 การจัดเก็บ log
- เก็บใน `DATA_DIR/inventory.json` (ประวัติล่าสุด 50,000 รายการ) และรวมอยู่ในไฟล์สำรองข้อมูล
- ถ้าเปิด **MySQL log** ไว้ ทุกการเปลี่ยนแปลงจะถูกเขียนลงตาราง `nms_asset_change` ด้วย (สร้างอัตโนมัติ) — เก็บได้ไม่จำกัด และใช้ทำรายงานต่อด้วย Excel / Power BI
  ```sql
  -- สรุปการเปลี่ยนแปลงรายเดือนแยกหมวด ปี 2569
  SELECT DATE_FORMAT(changed_at,'%Y-%m') AS ym, category, COUNT(*) n
  FROM nms_asset_change WHERE changed_at >= '2026-01-01' AND changed_at < '2027-01-01'
  GROUP BY ym, category ORDER BY ym;

  -- เครื่องที่ RAM ลดลงในช่วงวันที่ที่กำหนด
  SELECT changed_at, hostname, department, old_value, new_value FROM nms_asset_change
  WHERE field='ram' AND label LIKE 'RAM ลดลง%' AND changed_at BETWEEN '2026-10-01' AND '2026-10-31 23:59:59';
  ```

### 1.10 ตั้งค่า (ทะเบียนคอมพิวเตอร์ → ติดตั้ง Agent → ตั้งค่า)
| ค่า | เริ่มต้น | ความหมาย |
|---|---|---|
| รอบการส่งรายงาน | 60 นาที | ใช้คำนวณ “ออนไลน์” (รายงานภายใน 2.5 รอบ) |
| ขาดการรายงานเมื่อเกิน | 3 วัน | |
| ดิสก์ใกล้เต็มเมื่อว่างน้อยกว่า | 10% | |
| เก็บรายการซอฟต์แวร์ | เปิด | |
| บันทึกการเปลี่ยน IP | เปิด | ปิดได้ถ้า DHCP ทำให้ IP เปลี่ยนบ่อย |
| แจ้งเตือนเมื่อฮาร์ดแวร์ถูกถอด/เปลี่ยน | เปิด | |

---

## ส่วนที่ 2 — สแกน IP

### 2.1 เพิ่มช่วง IP
เมนู **สแกน IP → เพิ่มช่วง IP** (admin)
| ช่อง | ตัวอย่าง |
|---|---|
| ชื่อช่วง | `VLAN 10 — OPD ชั้น 1` |
| VLAN | `10` |
| ช่วง IP | `172.16.10.0/24` · `172.16.10.10-172.16.10.200` · `172.16.10.10-200` |

- CIDR /16 ถึง /32 (ไม่นับ network / broadcast) · สูงสุด 4,096 IP ต่อช่วง, รวมทุกช่วง 16,384 IP
- พิมพ์ช่วงแล้วระบบแสดงทันทีว่ามีกี่ IP

### 2.2 สแกน
- **สแกนทุกช่วง** หรือปุ่ม ⛶ ของแต่ละช่วง (operator) — แสดงความคืบหน้าและหยุดได้
- วิธีตรวจ: **ICMP ping** ก่อน ถ้าไม่ตอบจะลองเชื่อมต่อ **TCP port** (ค่าเริ่มต้น 445, 3389, 135, 139, 22, 80, 443, 9100, 554, 8080) เพราะ Windows Firewall มักปิด ping
- หาชื่อเครื่องจาก DNS (reverse lookup) และ MAC จากตาราง ARP (ได้เฉพาะ subnet เดียวกับเซิร์ฟเวอร์ — Docker ต้องใช้ `--network host`)
- เวลาโดยประมาณ: /24 (254 IP) ประมาณ 5–15 วินาที
- **สแกนอัตโนมัติ**: ตั้งค่า → ทุก 1–12 ชั่วโมง หรือวันละครั้งตามเวลา (แนะนำนอกเวลาราชการ เช่น 01:00 เพื่อดูเครื่องที่ไม่ปิด หรือ 10:00 เพื่อนับเครื่องที่ใช้งานจริง)

> ⚠️ แจ้งทีม Network/Security ก่อนสแกน เพราะ Firewall/IPS บางรุ่นอาจมองว่าเป็น port scan · ลด “จำนวน IP ที่สแกนพร้อมกัน” ถ้าถูกบล็อก

### 2.3 อ่านผลการเปรียบเทียบ
| ค่า | ความหมาย |
|---|---|
| IP ที่ใช้งานจริง | IP ที่ตอบ ping หรือ TCP |
| ทะเบียนคอมพิวเตอร์ | จำนวนเครื่องในทะเบียน (ไม่รวมสถานะจำหน่าย) และจำนวนที่พบตอนสแกน |
| **ไม่อยู่ในทะเบียน** | IP ที่ใช้งานแต่ไม่ตรงกับทะเบียนคอมพิวเตอร์หรืออุปกรณ์เครือข่าย → ลงทะเบียน หรือตรวจสอบว่าเป็นเครื่องแปลกปลอม |
| **อยู่ในทะเบียนแต่ไม่พบ** | เครื่องที่ IP อยู่ในช่วงนี้แต่ไม่ตอบ → ปิดเครื่อง, ย้าย, เปลี่ยน IP หรือเสีย |
| อัตราการใช้ | IP ที่ใช้ ÷ IP ทั้งหมดในช่วง (เกิน 90% = DHCP pool ใกล้เต็ม) |
| IP ใหม่ / หายไป | เทียบกับการสแกนครั้งก่อน |

ปุ่ม **ดูผล** ของแต่ละช่วง
- **แผนผัง IP** สีตามการจับคู่: เขียว = ทะเบียนคอมพิวเตอร์, ฟ้า = อุปกรณ์เครือข่าย, ส้ม = ไม่อยู่ในทะเบียน, แดง = ทะเบียนแต่ไม่พบ, เทา = ว่าง
- กรองรายการ แล้วกด **ลงทะเบียนคอม** (เปิดฟอร์มพร้อม IP/MAC/ชื่อ) หรือ **เพิ่มเป็นอุปกรณ์** (เพิ่มเข้าระบบ monitor)
- **CSV** ส่งออกผลการสแกนพร้อมการจับคู่

---

## API ที่เกี่ยวข้อง (`/api/v1`)
| Method | Path | สิทธิ์ |
|---|---|---|
| POST | `/inventory/report` | agent |
| GET | `/inventory?q=&state=&dept=` | viewer |
| GET | `/inventory/assets/{id}` | viewer |
| POST / PUT / DELETE | `/inventory/assets[/{id}]` | operator / admin |
| GET | `/inventory/changes?mode=day\|month\|year\|range&date=&from=&to=&cat=&dept=` | viewer |
| GET | `/inventory/changes.csv` · `/inventory/export.csv` | viewer |
| GET | `/inventory/software?q=` | viewer |
| GET | `/ipscan` · `/ipscan/ranges/{id}` · `/ipscan/ranges/{id}/export.csv` | viewer |
| POST | `/ipscan/run` · `/ipscan/cancel` | operator |
| POST / PUT / DELETE | `/ipscan/ranges[/{id}]` · PUT `/ipscan/settings` | admin |

## แก้ปัญหา
| อาการ | วิธีแก้ |
|---|---|
| agent.log: `HTTP 401` | Key ผิด / ถูกปิด / หมดอายุ |
| agent.log: `HTTP 403` | Key ไม่ใช่ประเภท agent หรือ IP เครื่องไม่อยู่ใน allowlist ของ Key |
| agent.log: `Could not establish trust relationship` / SSL | ใช้ `-SkipCertCheck` (หรือ `--insecure`) หรือติดตั้งใบรับรอง CA ภายในบนเครื่องลูกข่าย |
| Windows 7: สคริปต์ไม่ทำงาน | ติดตั้ง WMF 5.1 (PowerShell 5.1) และ .NET 4.5+ (สำหรับ TLS 1.2) |
| เครื่องขึ้นซ้ำ 2 รายการ | เครื่องโคลนจาก image เดียวกันโดยคัดลอก `C:\ProgramData\SmartTopology\agent-id` มาด้วย → ลบไฟล์ `agent-id` บนเครื่องโคลนแล้วรันใหม่ · ลบรายการที่ซ้ำในทะเบียน |
| ไม่มีรายการซอฟต์แวร์ | ปิด “เก็บรายการซอฟต์แวร์” อยู่ หรือติดตั้งด้วย `-NoSoftware` |
| สแกนแล้ว IP ใช้งาน 100% ทั้งที่ไม่จริง | มีอุปกรณ์ตอบแทน (Proxy ARP / Firewall) — ลบพอร์ตที่ Firewall ตอบออกจากรายการ TCP port |
| สแกนไม่เจอเครื่อง Windows | Firewall ปิดทั้ง ping และพอร์ต → เปิด ICMP Echo ผ่าน GPO หรือเพิ่มพอร์ตที่เปิดอยู่ |
| ไม่มี MAC ในผลสแกน | เซิร์ฟเวอร์อยู่คนละ subnet (ปกติ) — ใช้ IP + ทะเบียนจาก Agent จับคู่แทน |
