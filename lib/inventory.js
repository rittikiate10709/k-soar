'use strict';
/**
 * SMART TOPOLOGY — ทะเบียนเครื่องคอมพิวเตอร์ (Hardware / Software Inventory)
 *
 *  - รับรายงานสเปคจาก Agent (Windows PowerShell / Linux Python) ผ่าน POST /api/v1/inventory/report
 *  - จับคู่เครื่องด้วย agentId → UUID+Serial → MAC → ชื่อเครื่อง
 *  - เปรียบเทียบกับค่าล่าสุดแล้วบันทึก "ประวัติการเปลี่ยนแปลง" (OS, CPU, RAM, ดิสก์, การ์ดจอ, เครือข่าย, ซอฟต์แวร์)
 *  - รายงานการเปลี่ยนแปลง รายวัน / รายเดือน / รายปี / ช่วงวันที่กำหนดเอง
 *  เก็บข้อมูลในไฟล์ DATA_DIR/inventory.json (แยกจาก db.json เพื่อไม่ให้ไฟล์หลักใหญ่)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHANGE_CAP = 50000;
const CATS = {
  new: 'ลงทะเบียนใหม่', os: 'ระบบปฏิบัติการ', hardware: 'ฮาร์ดแวร์', network: 'เครือข่าย',
  software: 'ซอฟต์แวร์', firmware: 'BIOS / Firmware', info: 'ข้อมูลทะเบียน', removed: 'ลบออกจากทะเบียน',
};
const STATUSES = ['active', 'spare', 'repair', 'retired'];
const ADMIN_FIELDS = ['assetTag', 'department', 'location', 'owner', 'note', 'purchaseDate', 'warrantyEnd', 'status', 'deviceId'];

function defaultSettings() {
  return { intervalMin: 60, staleDays: 3, lowDiskPct: 10, trackSoftware: true, trackIp: true, alertHardware: true };
}
function defaultData() { return { settings: defaultSettings(), assets: [], changes: [], seq: { asset: 0, change: 0 } }; }

/* ------------------------------------------------------------------ helpers */
const S = (v, n = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
const N = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const BAD_UUID = /^(0{8}-0{4}-0{4}-0{4}-0{12}|f{8}-f{4}-f{4}-f{4}-f{12}|03000200-0400-0500-0006-000700080009)$/i;
const BAD_SERIAL = /^(|0+|none|default string|to be filled by o\.e\.m\.|system serial number|not specified|n\/a|123456789|chassis serial number)$/i;
const normMac = (m) => { const h = String(m || '').replace(/[^0-9a-f]/gi, '').toLowerCase(); return h.length === 12 && !/^0+$/.test(h) ? h.match(/../g).join(':') : ''; };
const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s || ''));
const gb = (mb) => (mb == null ? '—' : mb >= 1024 ? `${Math.round(mb / 1024 * 10) / 10} GB` : `${mb} MB`);

/** ทำความสะอาดรายงานจาก agent ให้เป็นโครงสร้างเดียวกันเสมอ */
function normalize(r) {
  if (!r || typeof r !== 'object') throw new Error('รูปแบบรายงานไม่ถูกต้อง');
  const os = r.os || {}, cpu = r.cpu || {}, sys = r.system || {};
  const hostname = S(r.hostname, 100);
  if (!hostname) throw new Error('รายงานไม่มีชื่อเครื่อง (hostname)');
  const ramModules = arr(r.ramModules, 32).map((m) => ({ sizeMB: N(m.sizeMB), speed: N(m.speed), type: S(m.type, 20), manufacturer: S(m.manufacturer, 60), part: S(m.part, 60), slot: S(m.slot, 40) }));
  const modSum = ramModules.reduce((a, m) => a + (m.sizeMB || 0), 0);
  const disks = arr(r.disks, 32).map((d) => ({ model: S(d.model, 100), sizeGB: N(d.sizeGB) == null ? null : Math.round(N(d.sizeGB)), type: S(d.type, 12), bus: S(d.bus, 16), serial: S(d.serial, 60), health: S(d.health, 20) }));
  const volumes = arr(r.volumes, 40).map((v) => ({ mount: S(v.mount, 60), fs: S(v.fs, 16), label: S(v.label, 60), sizeGB: N(v.sizeGB), freeGB: N(v.freeGB) }));
  const gpus = arr(r.gpus, 8).map((g) => ({ name: S(g.name, 120), vramMB: N(g.vramMB), driver: S(g.driver, 40) }));
  const net = arr(r.net, 16).map((n) => ({ name: S(n.name, 120), mac: normMac(n.mac), ipv4: arr(n.ipv4, 8).map((x) => S(x, 15)).filter(isIPv4), gateway: S(n.gateway, 15), dhcp: n.dhcp == null ? null : !!n.dhcp }));
  const software = arr(r.software, 3000).map((s) => ({ name: S(s.name, 160), version: S(s.version, 60), publisher: S(s.publisher, 100) })).filter((s) => s.name);
  const ips = [...new Set(net.flatMap((n) => n.ipv4))].filter((x) => !x.startsWith('127.') && !x.startsWith('169.254.'));
  return {
    agentId: S(r.agentId, 64), agentVersion: S(r.agentVersion, 20), platform: S(r.platform, 20),
    hostname, domain: S(r.domain, 100), user: S(r.user, 100),
    os: { name: S(os.name, 120), version: S(os.version, 40), build: S(os.build, 40), release: S(os.release, 20), arch: S(os.arch, 20), installDate: S(os.installDate, 30), lastBoot: S(os.lastBoot, 30) },
    cpu: { model: S(cpu.model, 120).replace(/\s+/g, ' '), cores: N(cpu.cores), threads: N(cpu.threads), mhz: N(cpu.mhz), sockets: N(cpu.sockets) || 1 },
    ramMB: modSum || (N(r.ramMB) == null ? null : Math.round(N(r.ramMB))), ramModules, disks, volumes, gpus, net,
    system: { manufacturer: S(sys.manufacturer, 80), model: S(sys.model, 100), serial: BAD_SERIAL.test(S(sys.serial, 60)) ? '' : S(sys.serial, 60),
      uuid: BAD_UUID.test(S(sys.uuid, 40)) ? '' : S(sys.uuid, 40).toLowerCase(), bios: S(sys.bios, 60), biosDate: S(sys.biosDate, 30), chassis: S(sys.chassis, 30) },
    antivirus: arr(r.antivirus, 6).map((a) => ({ name: S(a.name, 80), enabled: a.enabled == null ? null : !!a.enabled, updated: a.updated == null ? null : !!a.updated })),
    monitors: arr(r.monitors, 6).map((m) => ({ name: S(m.name, 80), serial: S(m.serial, 40) })),
    software, ips, macs: [...new Set(net.map((n) => n.mac).filter(Boolean))],
    hasSoftware: Array.isArray(r.software),
  };
}

/* ---------------------------------------------------------- diff (old → new) */
const diskKey = (d) => d.serial || `${d.model}|${d.sizeGB}`;
const diskTxt = (d) => `${d.model || 'Disk'} ${d.sizeGB != null ? `${d.sizeGB} GB` : ''} ${d.type || ''}`.replace(/\s+/g, ' ').trim();
const gpuTxt = (g) => `${g.name}${g.vramMB ? ` (${gb(g.vramMB)})` : ''}`;
const osTxt = (o) => [o.name, o.release, o.build ? `build ${o.build}` : ''].filter(Boolean).join(' ');
function setDiff(oldL, newL, keyFn, txtFn) {
  const o = new Map(oldL.map((x) => [keyFn(x), x])), n = new Map(newL.map((x) => [keyFn(x), x]));
  return { added: [...n.keys()].filter((k) => !o.has(k)).map((k) => txtFn(n.get(k))), removed: [...o.keys()].filter((k) => !n.has(k)).map((k) => txtFn(o.get(k))) };
}
function diffSpec(a, s, opt) {
  const ch = [];
  const add = (cat, field, label, oldV, newV, extra) => ch.push({ cat, field, label, old: oldV == null ? '' : String(oldV), new: newV == null ? '' : String(newV), ...extra });
  if (a.hostname !== s.hostname) add('info', 'hostname', 'ชื่อเครื่อง', a.hostname, s.hostname);
  if ((a.domain || '') !== s.domain && s.domain) add('info', 'domain', 'Domain / Workgroup', a.domain, s.domain);
  const ao = a.os || {};
  if (ao.name !== s.os.name || ao.release !== s.os.release) add('os', 'os', 'ระบบปฏิบัติการ', osTxt(ao), osTxt(s.os), { major: ao.name !== s.os.name });
  else if (ao.build !== s.os.build || ao.version !== s.os.version) add('os', 'os.build', 'อัปเดต OS (build)', `${ao.version || ''} ${ao.build || ''}`.trim(), `${s.os.version} ${s.os.build}`.trim());
  const ac = a.cpu || {};
  if (ac.model !== s.cpu.model && s.cpu.model) add('hardware', 'cpu', 'CPU', ac.model, s.cpu.model, { severity: 'warning' });
  else if (ac.cores != null && s.cpu.cores != null && ac.cores !== s.cpu.cores) add('hardware', 'cpu.cores', 'จำนวนคอร์ CPU', ac.cores, s.cpu.cores);
  if (a.ramMB != null && s.ramMB != null && Math.abs(a.ramMB - s.ramMB) >= 256) {
    add('hardware', 'ram', s.ramMB > a.ramMB ? 'RAM เพิ่มขึ้น' : 'RAM ลดลง', gb(a.ramMB), gb(s.ramMB), { severity: s.ramMB < a.ramMB ? 'warning' : undefined });
  }
  const dd = setDiff(a.disks || [], s.disks, diskKey, diskTxt);
  dd.added.forEach((t) => add('hardware', 'disk', 'ติดตั้งดิสก์', '', t));
  dd.removed.forEach((t) => add('hardware', 'disk', 'ถอด / เปลี่ยนดิสก์', t, '', { severity: 'warning' }));
  const gd = setDiff(a.gpus || [], s.gpus, (g) => g.name, gpuTxt);
  gd.added.forEach((t) => add('hardware', 'gpu', 'การ์ดจอ (เพิ่ม/เปลี่ยน)', '', t));
  gd.removed.forEach((t) => add('hardware', 'gpu', 'การ์ดจอ (ถอดออก)', t, ''));
  const as = a.system || {};
  if (as.serial && s.system.serial && as.serial !== s.system.serial) add('hardware', 'serial', 'Serial number เครื่อง', as.serial, s.system.serial, { severity: 'warning' });
  if ((as.model || '') !== s.system.model && as.model && s.system.model) add('hardware', 'model', 'รุ่นเครื่อง / เมนบอร์ด', as.model, s.system.model, { severity: 'warning' });
  if (as.bios && s.system.bios && as.bios !== s.system.bios) add('firmware', 'bios', 'BIOS version', as.bios, s.system.bios);
  const md = setDiff((a.macs || []).map((m) => ({ m })), s.macs.map((m) => ({ m })), (x) => x.m, (x) => x.m);
  md.added.forEach((t) => add('network', 'mac', 'การ์ดเครือข่าย (MAC ใหม่)', '', t));
  md.removed.forEach((t) => add('network', 'mac', 'การ์ดเครือข่าย (MAC หายไป)', t, ''));
  if (opt.trackIp && (a.ips || []).join(',') !== s.ips.join(',') && s.ips.length) add('network', 'ip', 'IP Address', (a.ips || []).join(', '), s.ips.join(', '));
  if (opt.trackSoftware && s.hasSoftware && Array.isArray(a.software) && a.software.length) {
    const o = new Map(a.software.map((x) => [x.name, x.version])), n = new Map(s.software.map((x) => [x.name, x.version]));
    const out = [];
    const sw = (k, v) => (v && !k.includes(v) ? `${k} ${v}` : k);
    for (const [k, v] of n) { if (!o.has(k)) out.push(['software', 'sw.install', 'ติดตั้งโปรแกรม', '', sw(k, v)]); else if (o.get(k) !== v) out.push(['software', 'sw.update', 'อัปเดตโปรแกรม', sw(k, o.get(k)), sw(k, v)]); }
    for (const [k, v] of o) if (!n.has(k)) out.push(['software', 'sw.remove', 'ถอนการติดตั้งโปรแกรม', sw(k, v), '']);
    out.slice(0, 300).forEach((x) => add(...x));
    if (out.length > 300) add('software', 'sw.more', 'ซอฟต์แวร์เปลี่ยนอีก', '', `${out.length - 300} รายการ`);
  }
  return ch;
}

/* ------------------------------------------------------------------ factory */
module.exports = function createInventory({ dataDir, onChanges = () => {}, log = console }) {
  const FILE = path.join(dataDir, 'inventory.json');
  let D = defaultData();
  let timer = null;

  function load() {
    try {
      if (fs.existsSync(FILE)) {
        const x = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        D = Object.assign(defaultData(), x);
        D.settings = Object.assign(defaultSettings(), x.settings);
        D.seq = Object.assign({ asset: 0, change: 0 }, x.seq);
      }
    } catch (e) { log.warn('[inventory] อ่าน inventory.json ไม่ได้:', e.message); }
  }
  function saveNow() {
    clearTimeout(timer); timer = null;
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(D));
    fs.renameSync(tmp, FILE);
  }
  function save() { if (!timer) timer = setTimeout(() => { try { saveNow(); } catch (e) { log.warn('[inventory] บันทึกไม่ได้:', e.message); } }, 2000); }

  function pushChanges(asset, list, by) {
    const at = Date.now();
    const rows = list.map((c) => ({ id: ++D.seq.change, at, assetId: asset.id, host: asset.hostname, dept: asset.department || '', by: by || 'agent', ...c }));
    D.changes.push(...rows);
    if (D.changes.length > CHANGE_CAP) D.changes.splice(0, D.changes.length - CHANGE_CAP);
    if (rows.length) onChanges(rows, asset);
    return rows;
  }
  function findAsset(s, ip) {
    const A = D.assets;
    return (s.agentId && A.find((a) => a.agentId === s.agentId))
      || (s.system.uuid && s.system.serial && A.find((a) => a.system && a.system.uuid === s.system.uuid && a.system.serial === s.system.serial))
      || (s.macs.length && A.find((a) => !a.agentId && (a.macs || []).some((m) => s.macs.includes(m))))
      || A.find((a) => !a.agentId && a.hostname && a.hostname.toLowerCase() === s.hostname.toLowerCase())
      || (ip && A.find((a) => !a.agentId && a.source === 'manual' && (a.ips || []).includes(ip)));
  }
  const SPEC_KEYS = ['agentId', 'agentVersion', 'platform', 'hostname', 'domain', 'user', 'os', 'cpu', 'ramMB', 'ramModules', 'disks', 'volumes', 'gpus', 'net', 'system', 'antivirus', 'monitors', 'ips', 'macs'];

  /** รับรายงานจาก agent */
  function ingest(report, { ip = '', by = 'agent' } = {}) {
    const s = normalize(report);
    const opt = D.settings;
    let a = findAsset(s, ip), isNew = false, changes = [];
    const now = Date.now();
    if (!a) {
      isNew = true;
      a = { id: ++D.seq.asset, source: 'agent', status: 'active', assetTag: '', department: '', location: '', owner: '', note: '', purchaseDate: '', warrantyEnd: '', deviceId: null, firstSeen: now };
      D.assets.push(a);
    } else {
      const wasManual = a.source === 'manual' && !a.agentId;
      changes = wasManual ? [] : diffSpec(a, s, opt);
      if (wasManual) changes.push({ cat: 'info', field: 'agent', label: 'เชื่อม Agent กับรายการที่ลงทะเบียนเอง', old: '', new: `${s.hostname} (${s.platform || 'agent'})` });
    }
    for (const k of SPEC_KEYS) a[k] = s[k];
    if (s.hasSoftware) { if (opt.trackSoftware) { a.software = s.software; a.softwareAt = now; } else delete a.software; }
    a.source = 'agent'; a.lastSeen = now; a.lastIp = ip; a.reports = (a.reports || 0) + 1;
    const rows = pushChanges(a, isNew ? [{ cat: 'new', field: 'asset', label: 'ลงทะเบียนเครื่องใหม่ (Agent)', old: '', new: summaryLine(a) }] : changes, by);
    save();
    return { asset: a, isNew, changes: rows };
  }
  function summaryLine(a) {
    return [a.hostname, osTxt(a.os || {}), a.cpu && a.cpu.model, a.ramMB ? `RAM ${gb(a.ramMB)}` : '', (a.disks || []).map(diskTxt).join(' + ')].filter(Boolean).join(' · ');
  }

  /* ------------------------------------------------ ลงทะเบียน / แก้ไขโดยเจ้าหน้าที่ */
  function cleanAdmin(b, old = {}) {
    const o = {};
    for (const k of ADMIN_FIELDS) {
      if (b[k] === undefined) continue;
      if (k === 'status') { if (!STATUSES.includes(b.status)) throw new Error('สถานะไม่ถูกต้อง'); o.status = b.status; }
      else if (k === 'deviceId') o.deviceId = b.deviceId === '' || b.deviceId == null ? null : parseInt(b.deviceId, 10) || null;
      else if (k === 'purchaseDate' || k === 'warrantyEnd') { const v = S(b[k], 10); if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('วันที่ต้องเป็นรูปแบบ YYYY-MM-DD'); o[k] = v; }
      else o[k] = S(b[k], k === 'note' ? 500 : 100);
    }
    if (o.assetTag && D.assets.some((a) => a !== old && a.assetTag && a.assetTag.toLowerCase() === o.assetTag.toLowerCase())) throw new Error(`เลขครุภัณฑ์ ${o.assetTag} มีอยู่ในทะเบียนแล้ว`);
    return o;
  }
  const LABEL = { assetTag: 'เลขครุภัณฑ์', department: 'หน่วยงาน', location: 'สถานที่', owner: 'ผู้รับผิดชอบ', note: 'หมายเหตุ', purchaseDate: 'วันที่ซื้อ', warrantyEnd: 'หมดประกัน', status: 'สถานะ', deviceId: 'ผูกกับอุปกรณ์เครือข่าย' };
  /** spec ที่กรอกเองสำหรับเครื่องที่ยังไม่มี agent */
  function manualSpec(b) {
    const o = {};
    if (b.hostname !== undefined) { o.hostname = S(b.hostname, 100); if (!o.hostname) throw new Error('กรุณากรอกชื่อเครื่อง'); }
    if (b.ip !== undefined) { const ip = S(b.ip, 15); if (ip && !isIPv4(ip)) throw new Error('IP Address ไม่ถูกต้อง'); o.ips = ip ? [ip] : []; }
    if (b.mac !== undefined) { const m = normMac(b.mac); if (b.mac && !m) throw new Error('MAC Address ไม่ถูกต้อง'); o.macs = m ? [m] : []; }
    if (b.osName !== undefined) o.os = { name: S(b.osName, 120), version: S(b.osVersion, 40), build: '', release: S(b.osRelease, 20), arch: S(b.osArch, 20) };
    if (b.cpuModel !== undefined) o.cpu = { model: S(b.cpuModel, 120), cores: N(b.cpuCores), threads: N(b.cpuThreads), mhz: null, sockets: 1 };
    if (b.ramGB !== undefined) o.ramMB = N(b.ramGB) == null || b.ramGB === '' ? null : Math.round(N(b.ramGB) * 1024);
    if (b.diskText !== undefined) o.disks = S(b.diskText, 300).split(/[,+\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 8).map((x) => { const m = x.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/i); return { model: x, sizeGB: m ? Math.round(Number(m[1]) * (/tb/i.test(m[2]) ? 1000 : 1)) : null, type: /nvme/i.test(x) ? 'NVMe' : /ssd/i.test(x) ? 'SSD' : /hdd/i.test(x) ? 'HDD' : '', bus: '', serial: '' }; });
    if (b.gpuName !== undefined) o.gpus = S(b.gpuName, 120) ? [{ name: S(b.gpuName, 120), vramMB: null, driver: '' }] : [];
    if (b.manufacturer !== undefined || b.model !== undefined || b.serial !== undefined) o.system = { manufacturer: S(b.manufacturer, 80), model: S(b.model, 100), serial: S(b.serial, 60), uuid: '', bios: '' };
    return o;
  }
  function addManual(b, by) {
    const sp = manualSpec({ hostname: b.hostname, ip: b.ip || '', mac: b.mac || '', osName: b.osName || '', osVersion: b.osVersion, osRelease: b.osRelease, osArch: b.osArch,
      cpuModel: b.cpuModel || '', cpuCores: b.cpuCores, ramGB: b.ramGB, diskText: b.diskText || '', gpuName: b.gpuName || '', manufacturer: b.manufacturer, model: b.model, serial: b.serial });
    const a = { id: ++D.seq.asset, source: 'manual', status: 'active', assetTag: '', department: '', location: '', owner: '', note: '', purchaseDate: '', warrantyEnd: '', deviceId: null,
      firstSeen: Date.now(), lastSeen: null, volumes: [], net: [], ramModules: [], antivirus: [], monitors: [], ...sp, ...cleanAdmin(b) };
    D.assets.push(a);
    pushChanges(a, [{ cat: 'new', field: 'asset', label: 'ลงทะเบียนเครื่องใหม่ (กรอกเอง)', old: '', new: summaryLine(a) }], by);
    save();
    return a;
  }
  function update(id, b, by) {
    const a = D.assets.find((x) => x.id === id);
    if (!a) return null;
    const adm = cleanAdmin(b, a);
    const ch = [];
    for (const [k, v] of Object.entries(adm)) if (String(a[k] ?? '') !== String(v ?? '')) { ch.push({ cat: 'info', field: k, label: LABEL[k], old: a[k] ?? '', new: v ?? '' }); a[k] = v; }
    if (a.source === 'manual') {
      const sp = manualSpec(b);
      const before = JSON.parse(JSON.stringify(a));
      Object.assign(a, sp);
      ch.push(...diffSpec(before, { ...a, os: a.os || {}, cpu: a.cpu || {}, system: a.system || {}, disks: a.disks || [], gpus: a.gpus || [], macs: a.macs || [], ips: a.ips || [], software: [], hasSoftware: false, domain: a.domain || '' }, { trackIp: true }));
    }
    pushChanges(a, ch, by);
    save();
    return a;
  }
  function remove(id, by) {
    const a = D.assets.find((x) => x.id === id);
    if (!a) return false;
    D.assets = D.assets.filter((x) => x !== a);
    pushChanges(a, [{ cat: 'removed', field: 'asset', label: 'ลบออกจากทะเบียน', old: summaryLine(a), new: '' }], by);
    save();
    return true;
  }

  /* ------------------------------------------------------------------ views */
  function stateOf(a, now = Date.now()) {
    if (a.status && a.status !== 'active') return a.status;
    if (a.source === 'manual' && !a.lastSeen) return 'manual';
    const age = now - (a.lastSeen || 0);
    if (age <= Math.max(2, D.settings.intervalMin * 2.5) * 60000) return 'online';
    if (age > D.settings.staleDays * 86400000) return 'stale';
    return 'idle';
  }
  function lowDisk(a) {
    return (a.volumes || []).filter((v) => v.sizeGB > 1 && v.freeGB != null && (v.freeGB / v.sizeGB) * 100 < D.settings.lowDiskPct).map((v) => v.mount);
  }
  function listView(a) {
    const { software, net, ramModules, volumes, monitors, ...rest } = a;
    return { ...rest, state: stateOf(a), lowDisk: lowDisk(a), swCount: software ? software.length : null, diskGB: (a.disks || []).reduce((s, d) => s + (d.sizeGB || 0), 0),
      ip: (a.ips || []).includes(a.lastIp) ? a.lastIp : (a.ips || [])[0] || a.lastIp || '', mac: (a.macs || [])[0] || '' };
  }
  function detail(id) {
    const a = D.assets.find((x) => x.id === id);
    if (!a) return null;
    return { asset: { ...a, state: stateOf(a), lowDisk: lowDisk(a) }, changes: D.changes.filter((c) => c.assetId === id).slice(-500).reverse() };
  }
  function bucketCount(list, keyFn) { const m = {}; list.forEach((a) => { const k = keyFn(a) || 'ไม่ทราบ'; m[k] = (m[k] || 0) + 1; }); return Object.entries(m).sort((x, y) => y[1] - x[1]).map(([k, n]) => ({ k, n })); }
  function ramBucket(mb) { if (!mb) return null; const g = mb / 1024; return g < 3 ? '≤ 2 GB' : g < 6 ? '4 GB' : g < 10 ? '8 GB' : g < 20 ? '16 GB' : g < 40 ? '32 GB' : '64 GB ขึ้นไป'; }
  function osShort(a) { const n = (a.os && a.os.name) || ''; const m = n.match(/Windows (Server )?(\d+|XP|Vista|7|8\.1|8|10|11)/i); if (m) return `Windows ${m[1] ? 'Server ' : ''}${m[2]}`; return n.replace(/ GNU\/Linux| LTS.*/g, '').split(' ').slice(0, 2).join(' ') || null; }
  function stats() {
    const A = D.assets.filter((a) => a.status !== 'retired');
    const now = Date.now();
    const st = { total: D.assets.length, inUse: A.length, online: 0, idle: 0, stale: 0, manual: 0, agent: 0, lowDisk: 0, noAv: 0 };
    A.forEach((a) => { const s = stateOf(a, now); if (st[s] != null) st[s]++; if (a.source === 'agent') st.agent++; if (lowDisk(a).length) st.lowDisk++; if (a.source === 'agent' && a.platform === 'windows' && Array.isArray(a.antivirus) && !a.antivirus.some((v) => v.enabled)) st.noAv++; });
    st.os = bucketCount(A, osShort);
    st.ram = bucketCount(A.filter((a) => a.ramMB), (a) => ramBucket(a.ramMB));
    st.diskType = bucketCount(A.flatMap((a) => (a.disks || []).map((d) => ({ t: d.type || 'ไม่ทราบ' }))), (x) => x.t);
    st.cpu = bucketCount(A.filter((a) => a.cpu && a.cpu.model), (a) => { const m = a.cpu.model; const x = m.match(/(i[3579]|Ryzen \d|Xeon|Celeron|Pentium|Athlon|Core 2|Ultra \d)/i); return x ? x[1].replace(/^i/, 'Core i') : m.split(' ').slice(0, 2).join(' '); }).slice(0, 8);
    st.dept = bucketCount(A, (a) => a.department).slice(0, 12);
    const day = 86400000;
    st.changes24h = D.changes.filter((c) => c.at > now - day).length;
    st.changes7d = D.changes.filter((c) => c.at > now - 7 * day).length;
    return st;
  }

  /* ------------------------------------------------------------------ report */
  const p2 = (n) => String(n).padStart(2, '0');
  const dkey = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  /** ช่วงเวลาของรายงาน: mode = day | month | year | range */
  function rangeOf(q) {
    const mode = ['day', 'month', 'year', 'range'].includes(q.mode) ? q.mode : 'month';
    const now = new Date();
    let start, end, unit;
    if (mode === 'day') { const d = q.date && /^\d{4}-\d{2}-\d{2}$/.test(q.date) ? new Date(`${q.date}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), now.getDate()); start = d; end = new Date(+d + 86400000); unit = 'hour'; }
    else if (mode === 'month') { const m = /^(\d{4})-(\d{2})$/.exec(q.date || ''); start = m ? new Date(+m[1], +m[2] - 1, 1) : new Date(now.getFullYear(), now.getMonth(), 1); end = new Date(start.getFullYear(), start.getMonth() + 1, 1); unit = 'day'; }
    else if (mode === 'year') { const y = /^\d{4}$/.test(q.date || '') ? +q.date : now.getFullYear(); start = new Date(y, 0, 1); end = new Date(y + 1, 0, 1); unit = 'month'; }
    else {
      const ok = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
      if (!ok(q.from) || !ok(q.to)) throw new Error('กรุณาเลือกวันที่เริ่มต้นและสิ้นสุด');
      start = new Date(`${q.from}T00:00:00`); end = new Date(+new Date(`${q.to}T00:00:00`) + 86400000);
      if (end <= start) throw new Error('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มต้น');
      if (end - start > 3 * 366 * 86400000) throw new Error('ช่วงวันที่ต้องไม่เกิน 3 ปี');
      unit = end - start <= 93 * 86400000 ? 'day' : 'month';
    }
    return { mode, start, end, unit, prevStart: mode === 'range' ? new Date(+start - (end - start)) : mode === 'day' ? new Date(+start - 86400000) : mode === 'month' ? new Date(start.getFullYear(), start.getMonth() - 1, 1) : new Date(start.getFullYear() - 1, 0, 1) };
  }
  function buckets(r) {
    const out = [];
    let t = new Date(r.start);
    while (t < r.end) {
      let next, label;
      if (r.unit === 'hour') { next = new Date(+t + 3600000); label = `${p2(t.getHours())}:00`; }
      else if (r.unit === 'day') { next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1); label = r.mode === 'month' ? String(t.getDate()) : `${t.getDate()} ${TH_M[t.getMonth()]}`; }
      else { next = new Date(t.getFullYear(), t.getMonth() + 1, 1); label = r.mode === 'year' ? TH_M[t.getMonth()] : `${TH_M[t.getMonth()]} ${String(t.getFullYear() + 543).slice(2)}`; }
      out.push({ start: +t, end: +next, label, counts: {}, total: 0 });
      t = next;
    }
    return out;
  }
  function report(q) {
    const r = rangeOf(q);
    const cats = q.cat ? String(q.cat).split(',').filter((c) => CATS[c]) : null;
    const s = String(q.q || '').toLowerCase().trim();
    const match = (c) => (!cats || cats.includes(c.cat)) && (!q.assetId || c.assetId === Number(q.assetId)) && (!q.dept || (c.dept || '') === q.dept)
      && (!s || `${c.host} ${c.label} ${c.old} ${c.new} ${c.by}`.toLowerCase().includes(s));
    const inR = D.changes.filter((c) => c.at >= +r.start && c.at < +r.end && match(c));
    const prev = D.changes.filter((c) => c.at >= +r.prevStart && c.at < +r.start && match(c));
    const B = buckets(r);
    inR.sort((a, b) => a.at - b.at || a.id - b.id);
    let bi = 0;
    for (const c of inR) { while (bi < B.length - 1 && c.at >= B[bi].end) bi++; const b = B[bi]; b.counts[c.cat] = (b.counts[c.cat] || 0) + 1; b.total++; }
    const byCat = {}, prevCat = {};
    inR.forEach((c) => { byCat[c.cat] = (byCat[c.cat] || 0) + 1; });
    prev.forEach((c) => { prevCat[c.cat] = (prevCat[c.cat] || 0) + 1; });
    const hostMap = new Map();
    inR.forEach((c) => { const h = hostMap.get(c.assetId) || { assetId: c.assetId, host: c.host, dept: c.dept, n: 0, cats: {} }; h.n++; h.cats[c.cat] = (h.cats[c.cat] || 0) + 1; hostMap.set(c.assetId, h); });
    const fieldMap = {};
    inR.forEach((c) => { fieldMap[c.label] = (fieldMap[c.label] || 0) + 1; });
    const limit = Math.min(5000, Math.max(1, parseInt(q.limit, 10) || 1000));
    return {
      mode: r.mode, unit: r.unit, start: +r.start, end: +r.end, prevStart: +r.prevStart, cats: CATS,
      total: inR.length, prevTotal: prev.length, byCat, prevCat, assetsChanged: hostMap.size,
      newAssets: byCat.new || 0, hardware: byCat.hardware || 0,
      buckets: B.map(({ label, start, counts, total }) => ({ label, start, counts, total })),
      topAssets: [...hostMap.values()].sort((a, b) => b.n - a.n).slice(0, 15),
      topFields: Object.entries(fieldMap).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([label, n]) => ({ label, n })),
      rows: inR.slice(-limit).reverse(), truncated: inR.length > limit,
    };
  }

  return {
    CATS, STATUSES, load, save, saveNow, ingest, addManual, update, remove, detail, listView, stats, report, stateOf,
    get data() { return D; },
    set data(x) { D = Object.assign(defaultData(), x || {}); D.settings = Object.assign(defaultSettings(), (x || {}).settings); D.seq = Object.assign({ asset: 0, change: 0 }, (x || {}).seq); saveNow(); },
    get settings() { return D.settings; },
    setSettings(b) {
      const s = D.settings;
      if (b.intervalMin !== undefined) s.intervalMin = Math.max(5, Math.min(1440, parseInt(b.intervalMin, 10) || 60));
      if (b.staleDays !== undefined) s.staleDays = Math.max(1, Math.min(365, parseInt(b.staleDays, 10) || 3));
      if (b.lowDiskPct !== undefined) s.lowDiskPct = Math.max(1, Math.min(50, parseInt(b.lowDiskPct, 10) || 10));
      ['trackSoftware', 'trackIp', 'alertHardware'].forEach((k) => { if (b[k] !== undefined) s[k] = !!b[k]; });
      save();
      return s;
    },
    findByIp: (ip) => D.assets.filter((a) => a.lastIp === ip || (a.ips || []).includes(ip)),
    byMac: () => { const m = new Map(); D.assets.forEach((a) => (a.macs || []).forEach((x) => m.set(x, a))); return m; },
    newAgentId: () => crypto.randomUUID(),
  };
};
module.exports.CATS = CATS;
module.exports.defaultData = defaultData;
module.exports.normalize = normalize;
