#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Smart Topology NOC - Computer Inventory Agent for Linux (Python 3.6+, standard library only)

ส่งสเปคเครื่อง (OS, CPU, RAM, ดิสก์, การ์ดจอ, เครือข่าย, ซอฟต์แวร์) ไปที่
    POST <server>/api/v1/inventory/report   (Authorization: Bearer <API Key ประเภท agent>)

    sudo python3 smart-topology-agent.py                 # ใช้ /etc/smart-topology-agent.json
    python3 smart-topology-agent.py --print              # แสดง JSON ที่เก็บได้ ไม่ส่ง
    sudo python3 smart-topology-agent.py --server https://noc:3000 --key stk_xxx

ควรรันด้วย root เพื่ออ่าน Serial / UUID / รายละเอียด RAM (dmidecode) — ติดตั้งด้วย install-agent.sh
"""
import argparse
import json
import os
import platform
import re
import shutil
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

VERSION = "1.0.0"
CONFIG = "/etc/smart-topology-agent.json"
STATE_DIR = "/var/lib/smart-topology-agent"
LOG = "/var/log/smart-topology-agent.log"


def log(msg, quiet=False):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    if quiet:
        print(line, file=sys.stderr)
        return
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        print(line, file=sys.stderr)


def run(cmd, timeout=20):
    if not shutil.which(cmd[0]):
        return ""
    try:
        return subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout,
                              universal_newlines=True, env=dict(os.environ, LC_ALL="C")).stdout
    except Exception:  # noqa: BLE001
        return ""


def read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read().strip()
    except OSError:
        return ""


def os_info():
    rel = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            rel[k] = v.strip().strip('"')
    boot = ""
    up = read("/proc/uptime").split()
    if up:
        boot = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(time.time() - float(up[0])))
    return {"name": rel.get("PRETTY_NAME") or "%s %s" % (platform.system(), platform.release()),
            "version": rel.get("VERSION_ID", ""), "build": platform.release(), "release": rel.get("VERSION_CODENAME", ""),
            "arch": platform.machine(), "installDate": "", "lastBoot": boot}


def cpu_info():
    txt = read("/proc/cpuinfo")
    model = ""
    phys, cores_per = set(), {}
    for block in txt.split("\n\n"):
        f = dict((k.strip(), v.strip()) for k, v in (l.split(":", 1) for l in block.splitlines() if ":" in l))
        if not f:
            continue
        model = model or f.get("model name") or f.get("Hardware") or f.get("Processor", "")
        pid = f.get("physical id", "0")
        phys.add(pid)
        if "cpu cores" in f:
            cores_per[pid] = int(f["cpu cores"])
    threads = os.cpu_count() or 0
    cores = sum(cores_per.values()) or threads
    mhz = None
    mx = read("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
    if mx.isdigit():
        mhz = int(mx) // 1000
    return {"model": re.sub(r"\s+", " ", model), "cores": cores, "threads": threads, "mhz": mhz, "sockets": len(phys) or 1}


def ram_info():
    total = 0
    m = re.search(r"MemTotal:\s+(\d+)", read("/proc/meminfo"))
    if m:
        total = int(m.group(1)) // 1024
    mods = []
    out = run(["dmidecode", "-t", "17"]) if os.geteuid() == 0 else ""
    for block in out.split("Memory Device")[1:]:
        f = dict((k.strip(), v.strip()) for k, v in (l.split(":", 1) for l in block.splitlines() if ":" in l))
        size = f.get("Size", "")
        mm = re.match(r"(\d+)\s*(MB|GB|TB)", size)
        if not mm:
            continue
        mb = int(mm.group(1)) * {"MB": 1, "GB": 1024, "TB": 1048576}[mm.group(2)]
        sp = re.match(r"(\d+)", f.get("Configured Memory Speed", f.get("Speed", "")) or "")
        mods.append({"sizeMB": mb, "speed": int(sp.group(1)) if sp else None, "type": f.get("Type", ""),
                     "manufacturer": f.get("Manufacturer", ""), "part": f.get("Part Number", ""), "slot": f.get("Locator", "")})
    return total, mods


def disk_info():
    cols = "NAME,MODEL,SIZE,ROTA,TYPE,SERIAL,TRAN"
    rows = []
    out = run(["lsblk", "-J", "-b", "-d", "-o", cols])
    try:
        rows = json.loads(out).get("blockdevices", [])
    except (ValueError, TypeError):
        # util-linux เก่า (CentOS 7) ไม่มี -J → ใช้รูปแบบ KEY="value"
        for line in run(["lsblk", "-P", "-b", "-d", "-o", cols]).splitlines():
            rows.append(dict((k.lower(), v) for k, v in re.findall(r'(\w+)="([^"]*)"', line)))
    disks = []
    for d in rows:
        name = str(d.get("name", ""))
        if d.get("type") != "disk" or name.startswith(("loop", "ram", "zram", "sr", "fd")) or d.get("tran") == "usb":
            continue
        size = round(int(d.get("size") or 0) / 1e9)
        if size < 1:
            continue
        rota = str(d.get("rota")) in ("1", "True", "true")
        t = "NVMe" if name.startswith("nvme") else ("HDD" if rota else "SSD")
        disks.append({"model": (d.get("model") or name).strip(), "sizeGB": size, "type": t,
                      "bus": (d.get("tran") or "").upper(), "serial": (d.get("serial") or "").strip(), "health": ""})
    return disks


def volume_info():
    vols, seen = [], set()
    real = ("ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "ntfs", "f2fs", "jfs", "reiserfs")
    for line in read("/proc/mounts").splitlines():
        p = line.split()
        if len(p) < 3 or p[2] not in real or p[0] in seen:
            continue
        seen.add(p[0])
        try:
            st = os.statvfs(p[1])
        except OSError:
            continue
        size = st.f_blocks * st.f_frsize
        if size < 512 * 1024 * 1024:
            continue
        vols.append({"mount": p[1], "fs": p[2], "label": p[0], "sizeGB": round(size / 1073741824, 1),
                     "freeGB": round(st.f_bavail * st.f_frsize / 1073741824, 1)})
    return vols[:20]


def gpu_info():
    gpus = []
    for line in run(["lspci", "-mm"]).splitlines():
        if re.search(r'"(VGA compatible controller|3D controller|Display controller)"', line):
            parts = re.findall(r'"([^"]*)"', line)
            if len(parts) >= 3:
                gpus.append({"name": ("%s %s" % (parts[1], parts[2])).strip(), "vramMB": None, "driver": ""})
    if not gpus:
        for card in sorted(os.listdir("/sys/class/drm")) if os.path.isdir("/sys/class/drm") else []:
            if re.match(r"card\d+$", card):
                vendor = read("/sys/class/drm/%s/device/vendor" % card)
                gpus.append({"name": "GPU %s" % vendor, "vramMB": None, "driver": ""})
    return gpus


def net_info():
    nets = []
    try:
        data = json.loads(run(["ip", "-j", "addr"]) or "[]")
    except ValueError:
        data = []
    gw = ""
    m = re.search(r"default via (\S+)", run(["ip", "route"]))
    if m:
        gw = m.group(1)
    for i in data:
        name = i.get("ifname", "")
        if name == "lo" or name.startswith(("docker", "veth", "br-", "virbr", "cni", "flannel", "tun", "tap")):
            continue
        ips = [a["local"] for a in i.get("addr_info", []) if a.get("family") == "inet"]
        dhcp = any(a.get("dynamic") for a in i.get("addr_info", []) if a.get("family") == "inet")
        nets.append({"name": name, "mac": i.get("address", ""), "ipv4": ips, "gateway": gw, "dhcp": dhcp})
    if not data:  # ระบบเก่าที่ไม่มี ip -j
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            nets.append({"name": "default", "mac": "", "ipv4": [s.getsockname()[0]], "gateway": gw, "dhcp": None})
            s.close()
        except OSError:
            pass
    return nets


def software_info():
    out = run(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Maintainer}\n"], 60)
    if not out:
        out = run(["rpm", "-qa", "--qf", "%{NAME}\t%{VERSION}-%{RELEASE}\t%{VENDOR}\n"], 60)
    sw = []
    for line in out.splitlines():
        p = line.split("\t")
        if p and p[0]:
            sw.append({"name": p[0], "version": p[1] if len(p) > 1 else "", "publisher": (p[2] if len(p) > 2 else "")[:100]})
    return sw[:3000]


def system_info():
    d = "/sys/class/dmi/id/"
    chassis = read(d + "chassis_type")
    ct = {"3": "desktop", "4": "desktop", "6": "desktop", "7": "desktop", "8": "laptop", "9": "laptop", "10": "laptop", "14": "laptop",
          "17": "server", "23": "server", "1": "vm"}.get(chassis, "")
    return {"manufacturer": read(d + "sys_vendor"), "model": read(d + "product_name"), "serial": read(d + "product_serial"),
            "uuid": read(d + "product_uuid"), "bios": read(d + "bios_version"), "biosDate": read(d + "bios_date"), "chassis": ct}


def agent_id(persist=True):
    path = os.path.join(STATE_DIR, "agent-id")
    v = read(path)
    if re.match(r"^[0-9a-f-]{36}$", v):
        return v
    v = str(uuid.uuid4())
    if persist:
        try:
            os.makedirs(STATE_DIR, exist_ok=True)
            with open(path, "w") as f:
                f.write(v)
        except OSError:
            pass
    return v


def collect(with_software=True, persist=True):
    total, mods = ram_info()
    who = run(["who"]).split()
    inv = {
        "agentId": agent_id(persist), "agentVersion": VERSION, "platform": "linux", "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "hostname": socket.gethostname().split(".")[0], "domain": ".".join(socket.getfqdn().split(".")[1:]),
        "user": who[0] if who else "", "os": os_info(), "cpu": cpu_info(), "ramMB": total, "ramModules": mods,
        "disks": disk_info(), "volumes": volume_info(), "gpus": gpu_info(), "net": net_info(), "system": system_info(),
        "antivirus": [], "monitors": [],
    }
    if with_software:
        inv["software"] = software_info()
    return inv


def main():
    ap = argparse.ArgumentParser(description="Smart Topology inventory agent")
    ap.add_argument("--server")
    ap.add_argument("--key")
    ap.add_argument("--config", default=CONFIG)
    ap.add_argument("--print", action="store_true", help="แสดงข้อมูลที่เก็บได้ ไม่ส่ง")
    ap.add_argument("--insecure", action="store_true", help="ไม่ตรวจใบรับรอง TLS (self-signed)")
    ap.add_argument("--no-software", action="store_true")
    a = ap.parse_args()

    cfg = {"server": "", "key": "", "insecure": False, "software": True}
    try:
        with open(a.config, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    if a.server:
        cfg["server"] = a.server
    if a.key:
        cfg["key"] = a.key
    if a.insecure:
        cfg["insecure"] = True
    if a.no_software:
        cfg["software"] = False

    inv = collect(cfg.get("software", True), persist=not a.print)
    if a.print:
        print(json.dumps(inv, ensure_ascii=False, indent=2))
        return 0
    if not cfg["server"] or not cfg["key"]:
        log("ERROR ยังไม่ได้ตั้งค่า server / key (ดู %s)" % a.config, quiet=True)
        return 2

    body = json.dumps(inv, ensure_ascii=False).encode("utf-8")
    url = cfg["server"].rstrip("/") + "/api/v1/inventory/report"
    ctx = ssl._create_unverified_context() if cfg.get("insecure") and url.startswith("https") else None  # noqa: SLF001
    for attempt in (1, 2, 3):
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json; charset=utf-8", "Authorization": "Bearer " + cfg["key"],
            "User-Agent": "SmartTopology-Agent/%s (linux)" % VERSION})
        try:
            with urllib.request.urlopen(req, timeout=30, context=ctx) as r:
                res = json.loads(r.read().decode("utf-8"))
                log("OK ส่ง %d bytes → asset #%s%s, เปลี่ยนแปลง %s รายการ" % (len(body), res.get("assetId"), " (ใหม่)" if res.get("isNew") else "", res.get("changes")))
                return 0
        except urllib.error.HTTPError as e:
            log("ERROR HTTP %s: %s" % (e.code, e.read()[:300].decode("utf-8", "replace")))
            if e.code in (400, 401, 403):
                return 1
        except Exception as e:  # noqa: BLE001
            log("ERROR ส่งครั้งที่ %d: %s" % (attempt, e))
        time.sleep(5 * attempt)
    return 1


if __name__ == "__main__":
    sys.exit(main())
