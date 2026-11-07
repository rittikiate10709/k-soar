# คู่มือ: สร้าง Docker Image และอัปโหลดขึ้น GitHub + Docker Hub

คู่มือนี้อธิบายทีละขั้นตอน ตั้งแต่นำโค้ดขึ้น GitHub ให้ GitHub สร้าง Docker image อัตโนมัติ
ส่ง image ขึ้น Docker Hub และ GitHub Container Registry (GHCR) จนถึงนำ image ไปรันบนเซิร์ฟเวอร์โรงพยาบาล

---

## ภาพรวมการทำงาน

```
 เครื่องของคุณ (VS Code)          GitHub                          Registry
 ┌──────────────────┐  git push  ┌──────────────────────┐  push   ┌─────────────────────────┐
 │ โค้ด smart-topology │ ─────────▶ │ Repository           │ ──────▶ │ Docker Hub              │
 └──────────────────┘            │  └ GitHub Actions     │         │  user/smart-topology    │
                                 │     1. ตรวจ syntax     │ ──────▶ │ GHCR                    │
                                 │     2. build image    │         │  ghcr.io/user/smart-... │
                                 │     3. ทดสอบรันจริง      │         └────────────┬────────────┘
                                 │     4. push           │                      │ docker pull
                                 └──────────────────────┘          ┌────────────▼────────────┐
                                                                   │ เซิร์ฟเวอร์โรงพยาบาล        │
                                                                   └─────────────────────────┘
```

**ทำไมใช้ GitHub Actions แทนการ build ในเครื่อง**
- ไม่ต้องติดตั้ง Docker Desktop บน Windows (กินแรมและต้องเปิด WSL2)
- ได้ image ทั้ง `amd64` (เซิร์ฟเวอร์ทั่วไป) และ `arm64` (Raspberry Pi, Mac M-series) พร้อมกัน
- ทุกครั้งที่แก้โค้ดแล้ว `git push` จะได้ image ใหม่อัตโนมัติ และผ่านการทดสอบก่อน push ทุกครั้ง
- Access Token ของ Docker Hub เก็บใน GitHub Secrets ไม่ต้องอยู่ในเครื่องหรือในโค้ด

---

## ส่วนที่ 1: เตรียมเครื่องมือ (ทำครั้งเดียว)

### 1.1 ติดตั้ง Git บน Windows
1. ดาวน์โหลดที่ https://git-scm.com/download/win แล้วติดตั้งโดยกด Next จนจบ
2. **ปิดและเปิด VS Code ใหม่** แล้วทดสอบใน Terminal:
   ```powershell
   git --version
   ```
3. ตั้งชื่อและอีเมลที่จะแสดงในประวัติการแก้ไข (ใช้อีเมลเดียวกับบัญชี GitHub):
   ```powershell
   git config --global user.name  "ชื่อของคุณ"
   git config --global user.email "อีเมลของคุณ@gmail.com"
   ```

### 1.2 สมัครบัญชี
- GitHub: https://github.com/signup
- Docker Hub: https://hub.docker.com/signup
  จดชื่อผู้ใช้ Docker Hub ไว้ (เช่น `kalasinhosp`) เพราะจะเป็นส่วนหนึ่งของชื่อ image `kalasinhosp/smart-topology`

---

## ส่วนที่ 2: สร้าง Repository บน GitHub

1. ไปที่ https://github.com/new
2. กรอก
   - **Repository name:** `smart-topology`
   - **Visibility:** แนะนำ **Private** เพราะเป็นระบบภายในโรงพยาบาล
   - **ไม่ต้องติ๊ก** “Add a README”, “.gitignore”, “license” เพราะในโปรเจกต์มีครบแล้ว (ถ้าติ๊กจะ push ไม่ผ่านในขั้นตอนถัดไป)
3. กด **Create repository** แล้วคัดลอก URL เช่น `https://github.com/<ชื่อผู้ใช้>/smart-topology.git`

---

## ส่วนที่ 3: นำโค้ดขึ้น GitHub

เปิด Terminal ใน VS Code ที่โฟลเดอร์ `smart-topology` (โฟลเดอร์ที่มีไฟล์ `server.js`)

```powershell
# 1) สร้าง git repository ในเครื่อง (ข้ามได้ถ้าโฟลเดอร์มี .git อยู่แล้ว)
git init -b main

# 2) ตรวจว่าไม่มีไฟล์ข้อมูล/คีย์หลุดเข้าไป — ต้องไม่เห็นโฟลเดอร์ data/
git status

# 3) บันทึกการเปลี่ยนแปลง (commit)
git add .
git commit -m "Smart Topology NOC v1.0.0"

# 4) ผูกกับ repository บน GitHub (เปลี่ยน <ชื่อผู้ใช้>)
git remote add origin https://github.com/<ชื่อผู้ใช้>/smart-topology.git

# 5) ส่งขึ้น GitHub
git push -u origin main
```

**คำอธิบาย**
| คำสั่ง | ทำอะไร |
|---|---|
| `git init -b main` | สร้างประวัติการแก้ไขในโฟลเดอร์นี้ โดยใช้ branch ชื่อ `main` |
| `git add .` | เลือกทุกไฟล์ (ยกเว้นที่ระบุใน `.gitignore` เช่น `data/`) |
| `git commit -m` | บันทึกเป็น 1 เวอร์ชันพร้อมข้อความอธิบาย |
| `git remote add origin` | บอกว่าปลายทางบน GitHub อยู่ที่ไหน |
| `git push -u origin main` | อัปโหลดขึ้น GitHub |

ครั้งแรกจะมีหน้าต่างให้ **Sign in with your browser** ให้กดล็อกอิน GitHub แล้วอนุญาต

> ⚠️ **สำคัญ:** โฟลเดอร์ `data/` มีรหัสผ่านที่เข้ารหัสแล้ว และคีย์หมอพร้อม (client-key/secret-key)
> ไฟล์ `.gitignore` กันไม่ให้โฟลเดอร์นี้ขึ้น GitHub แล้ว **ห้ามลบบรรทัด `data/` ออกจาก `.gitignore`**

เมื่อ push เสร็จ ให้เข้าแท็บ **Actions** ใน repository จะเห็น workflow “Build & Publish Docker image” เริ่มทำงานทันที
รอบแรกใช้เวลาประมาณ 3–6 นาที เมื่อเสร็จจะได้ image ที่ GHCR (`ghcr.io/<ชื่อผู้ใช้>/smart-topology`)

---

## ส่วนที่ 4: เชื่อม Docker Hub

### 4.1 สร้าง Access Token บน Docker Hub
ไม่ใช้รหัสผ่านจริงของบัญชี เพราะ Token จำกัดสิทธิ์ได้และยกเลิกได้ทุกเมื่อ

1. ล็อกอิน https://hub.docker.com
2. คลิกรูปโปรไฟล์ → **Account settings** → **Personal access tokens** → **Generate new token**
3. กรอก
   - **Description:** `github-actions-smart-topology`
   - **Access permissions:** **Read & Write**
4. กด **Generate** แล้ว **คัดลอก Token ทันที** (ระบบจะแสดงครั้งเดียว ขึ้นต้นด้วย `dckr_pat_`)

### 4.2 (แนะนำ) สร้าง Repository บน Docker Hub ก่อน
1. **Repositories** → **Create a repository**
2. Name: `smart-topology` · Visibility: **Public** (ฟรีไม่จำกัด) หรือ **Private** (บัญชีฟรีได้ 1 repo)
3. กด **Create**

> ถ้าข้ามขั้นนี้ Docker Hub จะสร้าง repository ให้อัตโนมัติตอน push ครั้งแรก โดยตั้งเป็น Public

### 4.3 ใส่ข้อมูล Docker Hub ใน GitHub
ไปที่ repository บน GitHub → **Settings** → **Secrets and variables** → **Actions**

| แท็บ | กดปุ่ม | Name | Value |
|---|---|---|---|
| **Variables** | New repository variable | `DOCKERHUB_USERNAME` | ชื่อผู้ใช้ Docker Hub เช่น `kalasinhosp` |
| **Secrets** | New repository secret | `DOCKERHUB_TOKEN` | Token `dckr_pat_...` จากข้อ 4.1 |

- **Variable** = ค่าที่ไม่ลับ แสดงใน log ได้
- **Secret** = ค่าลับ GitHub เข้ารหัสไว้ ไม่มีใครเห็นได้แม้แต่เจ้าของ (แก้ไขได้อย่างเดียว)

### 4.4 สั่ง build ใหม่
GitHub → **Actions** → **Build & Publish Docker image** → **Run workflow** → **Run workflow**

เมื่อเสร็จ (เครื่องหมาย ✅ สีเขียว) ให้เปิดหน้า run นั้น ในส่วน **Summary** จะเห็นรายชื่อ image เช่น
```
ghcr.io/<ชื่อผู้ใช้>/smart-topology:latest
docker.io/kalasinhosp/smart-topology:latest
docker.io/kalasinhosp/smart-topology:sha-1a2b3c4
```

---

## ส่วนที่ 5: workflow ทำอะไรบ้าง (ไฟล์ `.github/workflows/docker-publish.yml`)

| ขั้นตอน | รายละเอียด |
|---|---|
| Syntax check | ตรวจว่าไฟล์ JavaScript ไม่มี syntax ผิด |
| Build test image | สร้าง image สำหรับ amd64 |
| **Smoke test** | รัน container จริง → เปิดหน้า Login → ล็อกอินผ่าน API → ตรวจว่าไม่ได้รันเป็น root → ทดสอบ `ping` **ถ้าข้อใดไม่ผ่านจะไม่ push** |
| Login registry | ล็อกอิน GHCR (อัตโนมัติ) และ Docker Hub (ถ้าตั้งค่าแล้ว) |
| Metadata | กำหนดแท็กของ image ตามตารางด้านล่าง |
| Build & push | สร้าง `linux/amd64` + `linux/arm64` แล้วอัปโหลด |

**แท็กที่ได้**
| เหตุการณ์ | แท็กที่ได้ | ใช้เมื่อ |
|---|---|---|
| push เข้า `main` | `latest`, `sha-1a2b3c4` | เวอร์ชันล่าสุด |
| push tag `v1.2.0` | `1.2.0`, `1.2` | ระบบจริง ควรระบุเวอร์ชันชัดเจน |
| เปิด Pull Request | build + ทดสอบ (ไม่ push) | ตรวจโค้ดก่อนรวม |

---

## ส่วนที่ 6: ออกเวอร์ชันใหม่ (Release)

```powershell
git add .
git commit -m "เพิ่มฟีเจอร์ ..."
git push                      # ได้ :latest ใหม่

git tag v1.1.0                # ตั้งหมายเลขเวอร์ชัน
git push origin v1.1.0        # ได้ :1.1.0 และ :1.1
```
หลักการตั้งเลข `vหลัก.รอง.แก้ไข`: แก้บั๊ก → `v1.0.1`, เพิ่มฟีเจอร์ → `v1.1.0`, เปลี่ยนแปลงใหญ่ → `v2.0.0`

---

## ส่วนที่ 7: นำ image ไปใช้งานบนเซิร์ฟเวอร์

### 7.1 Linux (แนะนำ: Ubuntu Server)
```bash
# ติดตั้ง Docker (ครั้งเดียว)
curl -fsSL https://get.docker.com | sudo sh

# ดาวน์โหลดและรัน
sudo docker run -d --name smart-topology \
  --restart unless-stopped \
  --network host \
  -e ADMIN_PASSWORD='ตั้งรหัสที่ปลอดภัย' \
  -v nms-data:/data \
  kalasinhosp/smart-topology:latest
```
| ตัวเลือก | ความหมาย |
|---|---|
| `-d` | รันเบื้องหลัง |
| `--restart unless-stopped` | เปิดเองอัตโนมัติเมื่อเครื่องรีบูต |
| `--network host` | ใช้เครือข่ายของเครื่องโดยตรง ทำให้ ping อุปกรณ์ใน LAN ได้แม่นยำที่สุด (เปิดที่พอร์ต 3000) |
| `-e ADMIN_PASSWORD` | รหัส admin **ครั้งแรกเท่านั้น** (ถ้ามีข้อมูลอยู่แล้วจะไม่เปลี่ยน) |
| `-v nms-data:/data` | เก็บฐานข้อมูลไว้ใน volume ชื่อ `nms-data` อัปเดต image แล้วข้อมูลไม่หาย |

### 7.2 ใช้ docker compose
แก้บรรทัด `image:` ในไฟล์ `docker-compose.yml` ให้เป็นชื่อ image ของคุณ แล้วสั่ง
```bash
docker compose pull
docker compose up -d
```

### 7.3 Windows (Docker Desktop)
`--network host` ใช้ไม่ได้บน Windows ให้เปิดพอร์ตแทน:
```powershell
docker run -d --name smart-topology --restart unless-stopped -p 3000:3000 -v nms-data:/data kalasinhosp/smart-topology:latest
```

### 7.4 กรณี Repository เป็น Private
ต้องล็อกอินก่อน pull:
```bash
docker login                                     # Docker Hub: ใส่ชื่อผู้ใช้ + Access Token
docker login ghcr.io -u <ชื่อผู้ใช้ GitHub>         # GHCR: ใส่ Personal Access Token ที่มีสิทธิ์ read:packages
```

---

## ส่วนที่ 8: การดูแลระบบประจำวัน

```bash
docker logs -f smart-topology          # ดู log แบบสด (Ctrl+C เพื่อออก)
docker ps                              # ดูสถานะ (HEALTHY = ปกติ)

# อัปเดตเป็นเวอร์ชันใหม่ (ข้อมูลอยู่ใน volume ไม่หาย)
docker pull kalasinhosp/smart-topology:latest
docker rm -f smart-topology
#   แล้วสั่ง docker run ชุดเดิมจากข้อ 7.1 อีกครั้ง  (หรือ docker compose pull && docker compose up -d)

# สำรองฐานข้อมูล
docker cp smart-topology:/data/db.json ./backup-$(date +%F).json

# กู้คืน
docker cp ./backup-2026-11-02.json smart-topology:/data/db.json && docker restart smart-topology
```

---

## ส่วนที่ 9: แก้ปัญหาที่พบบ่อย

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `git push` ขึ้น `rejected (fetch first)` | ตอนสร้าง repo ติ๊ก “Add README” ไว้ แก้ด้วย `git pull origin main --rebase --allow-unrelated-histories` แล้ว push ใหม่ |
| Actions ขึ้นสีแดงที่ “Log in to Docker Hub” | Token ผิดหรือหมดอายุ หรือ Token ไม่มีสิทธิ์ Write ให้สร้างใหม่แล้วแก้ Secret `DOCKERHUB_TOKEN` |
| Actions ขึ้นสีแดงที่ “Smoke test” | โค้ดมีปัญหา กดดู log ของขั้นนั้น จะเห็นข้อความ error จากเซิร์ฟเวอร์ |
| GHCR push ไม่ได้ (`denied`) | Settings → Actions → General → Workflow permissions → เลือก **Read and write permissions** |
| Summary บอกว่ายังไม่ได้ push ไป Docker Hub | ยังไม่ได้ตั้ง `DOCKERHUB_USERNAME` (แท็บ Variables) หรือ `DOCKERHUB_TOKEN` (แท็บ Secrets) |
| Container หยุดทันที log ว่า “ไม่มีสิทธิ์เขียนโฟลเดอร์ข้อมูล” | mount โฟลเดอร์ของเครื่อง เช่น `-v ./data:/data` ที่เป็นของ root ให้ใช้ named volume `-v nms-data:/data` หรือสั่ง `sudo chown -R 1000:1000 ./data` |
| ทุกอุปกรณ์ขึ้น Offline แต่ ping จากเครื่องได้ | บน Windows/Mac ใช้ `-p 3000:3000` (container ping ผ่าน NAT ได้) หรือ security policy ตัด `NET_RAW` ไว้ ให้เพิ่ม `--cap-add NET_RAW` |
| ส่งหมอพร้อมไม่ได้ “หมดเวลาเชื่อมต่อ” | Firewall ไม่อนุญาตให้ออก `morpromt2f.moph.go.th:443` |

---

## ความปลอดภัย (ทบทวน)
1. **ห้าม** commit โฟลเดอร์ `data/`, ไฟล์ `.env` หรือใส่คีย์ลงในโค้ด
2. ใช้ Access Token แทนรหัสผ่าน และตั้งชื่อ Token ให้รู้ว่าใช้ที่ไหน จะได้ยกเลิกได้ตรงตัว
3. Image รันด้วยผู้ใช้ `node` (ไม่ใช่ root) และให้สิทธิ์ `ping` เฉพาะ `cap_net_raw`
4. ถ้า image เป็น Public ภายในไม่มีข้อมูลลับ (ข้อมูลทั้งหมดถูกสร้างตอนรันใน volume `/data`)

---

## อัปเกรดเป็น v1.3.0 (REST API · Backup · Wazuh)

1. **ดาวน์โหลดไฟล์สำรองก่อนอัปเกรดเสมอ** (เวอร์ชันเก่าที่ยังไม่มีเมนูสำรอง: `docker cp smart-topology:/data/db.json ./db-before-1.3.json`)
2. อัปเดต image ตามปกติ
   ```bash
   docker pull ghcr.io/<owner>/smart-topology:1.3.0
   docker rm -f smart-topology
   docker run -d --name smart-topology --restart unless-stopped --network host --cap-add NET_RAW \
     -e TZ=Asia/Bangkok -v nms-data:/data ghcr.io/<owner>/smart-topology:1.3.0
   ```
3. ไฟล์สำรองอัตโนมัติจะอยู่ใน volume เดิมที่ `/data/backups` (ไม่ต้อง mount เพิ่ม)
4. ถ้าวาง Nginx/Caddy ไว้หน้า Smart Topology และจะใช้ API Key แบบจำกัด IP ให้เปิด “อยู่หลัง Reverse Proxy” ในหน้า ตั้งค่า → การเชื่อมต่อแบบ API (หรือ `-e TRUST_PROXY=1`) และให้ proxy ส่ง `X-Forwarded-For`
5. ถ้าเชื่อม Wazuh: เครื่อง Smart Topology ต้องออกไปที่พอร์ต **55000** ของ Wazuh Manager ได้ และ Wazuh Manager ต้องเข้ามาที่พอร์ต **3000** (หรือ 443 ของ proxy) ได้ ถ้าจะรับ Alert จาก Wazuh
   ```bash
   sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="<IP Wazuh>/32" port port="3000" protocol="tcp" accept'
   sudo firewall-cmd --reload
   ```

คู่มือเพิ่มเติม: [API-TH.md](API-TH.md) · [BACKUP-TH.md](BACKUP-TH.md) · [WAZUH-TH.md](WAZUH-TH.md)

---

## อัปเกรดเป็น v1.4.0 (ทะเบียนคอมพิวเตอร์ · Agent · สแกน IP)

1. ดาวน์โหลดไฟล์สำรองก่อน (ตั้งค่า → สำรองและกู้คืนข้อมูล)
2. อัปเดต image เป็น `:1.4.0` ตามขั้นตอนเดิม (ข้อมูลใหม่อยู่ใน volume `/data`: `inventory.json`, `ipscan.json`)
3. เปิด Firewall ให้เครื่องลูกข่ายส่งรายงานเข้าพอร์ตของ Smart Topology ได้ (เช่น 3000 หรือ 443 ของ proxy)
   ```bash
   sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.16.0.0/16" port port="3000" protocol="tcp" accept'
   sudo firewall-cmd --reload
   ```
4. การสแกน IP ใช้ ping + TCP จากเซิร์ฟเวอร์ — container ต้องรันด้วย `--network host --cap-add NET_RAW` (เหมือนเดิม) เพื่อให้ ping และอ่าน MAC ได้
5. ถ้าใช้ MySQL log ตาราง `nms_asset_change` จะถูกสร้างอัตโนมัติเมื่อเชื่อมต่อ (ผู้ใช้ MySQL ต้องมีสิทธิ์ CREATE หรือกด “สร้างตาราง” ในหน้าตั้งค่า MySQL)

คู่มือ: [INVENTORY-TH.md](INVENTORY-TH.md)
