'use strict';
/**
 * SMART TOPOLOGY — สแกน IP ในเครือข่าย (IP Scanner)
 *
 *  - กำหนดช่วงที่สแกนได้เป็น CIDR (172.16.1.0/24) หรือช่วง (172.16.1.10-172.16.1.200 / 172.16.1.10-200)
 *  - ตรวจแต่ละ IP ด้วย ICMP ping ถ้าไม่ตอบจะลอง TCP port ที่เครื่องลูกข่ายมักเปิด (เช่น 445, 3389, 135)
 *    เพราะ Windows Firewall มักปิด ping ไว้
 *  - หาชื่อเครื่องด้วย Reverse DNS และ MAC จากตาราง ARP (เฉพาะเครือข่ายเดียวกับเซิร์ฟเวอร์)
 *  - ผลการสแกนนำไปเทียบกับทะเบียนคอมพิวเตอร์และอุปกรณ์เครือข่าย (ทำใน server.js)
 *  เก็บที่ DATA_DIR/ipscan.json
 */
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const crypto = require('crypto');

const MAX_PER_RANGE = 4096;          // /20
const MAX_TOTAL = 16384;
const HISTORY_CAP = 3000;

function defaultSettings() {
  return { concurrency: 64, timeoutMs: 800, ports: [445, 3389, 135, 139, 22, 80, 443, 9100, 554, 8080], resolveNames: true,
    schedule: { enabled: false, everyHours: 24, at: '01:00' }, lastScheduled: 0 };
}
function defaultData() { return { settings: defaultSettings(), ranges: [], results: {}, history: [] }; }

const ip2n = (ip) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const n2ip = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIPv4 = (s) => /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s || '').trim());

/** "172.16.1.0/24" | "172.16.1.10-172.16.1.50" | "172.16.1.10-50" | "172.16.1.5" → { start, end, count } */
function parseRange(spec) {
  const s = String(spec || '').trim().replace(/\s+/g, '');
  let m = s.match(/^([\d.]+)\/(\d{1,2})$/);
  if (m) {
    if (!isIPv4(m[1])) throw new Error(`IP ไม่ถูกต้อง: ${m[1]}`);
    const bits = Number(m[2]);
    if (bits < 16 || bits > 32) throw new Error('CIDR ต้องอยู่ระหว่าง /16 ถึง /32');
    const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
    const net = (ip2n(m[1]) & mask) >>> 0, bc = (net | (~mask >>> 0)) >>> 0;
    const start = bits >= 31 ? net : net + 1, end = bits >= 31 ? bc : bc - 1;   // ไม่รวม network / broadcast
    return check({ start, end, cidr: `${n2ip(net)}/${bits}` });
  }
  m = s.match(/^([\d.]+)-([\d.]+)$/);
  if (m) {
    if (!isIPv4(m[1])) throw new Error(`IP ไม่ถูกต้อง: ${m[1]}`);
    let endIp = m[2];
    if (/^\d{1,3}$/.test(endIp)) endIp = m[1].split('.').slice(0, 3).concat(endIp).join('.');
    if (!isIPv4(endIp)) throw new Error(`IP ไม่ถูกต้อง: ${m[2]}`);
    return check({ start: ip2n(m[1]), end: ip2n(endIp) });
  }
  if (isIPv4(s)) return check({ start: ip2n(s), end: ip2n(s) });
  throw new Error('รูปแบบช่วง IP ไม่ถูกต้อง (ตัวอย่าง 172.16.1.0/24 หรือ 172.16.1.10-172.16.1.200)');
  function check(r) {
    if (r.end < r.start) throw new Error('IP สิ้นสุดต้องมากกว่า IP เริ่มต้น');
    r.count = r.end - r.start + 1;
    if (r.count > MAX_PER_RANGE) throw new Error(`ช่วงเดียวสแกนได้ไม่เกิน ${MAX_PER_RANGE} IP (/20) — แบ่งเป็นหลายช่วง`);
    r.first = n2ip(r.start); r.last = n2ip(r.end);
    return r;
  }
}
function inRange(ip, r) { if (!isIPv4(ip)) return false; const n = ip2n(ip); return n >= r.start && n <= r.end; }

function readArp() {
  const m = new Map();
  try {
    fs.readFileSync('/proc/net/arp', 'utf8').split('\n').slice(1).forEach((l) => {
      const c = l.trim().split(/\s+/);
      if (c.length >= 4 && c[2] === '0x2' && c[3] !== '00:00:00:00:00:00') m.set(c[0], c[3].toLowerCase());
    });
  } catch { /* ไม่ใช่ Linux หรือไม่มีสิทธิ์ */ }
  return m;
}
function withTimeout(p, ms) { return Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]); }

module.exports = function createIpScan({ dataDir, icmp, tcp, onUpdate = () => {}, onDone = () => {}, log = console }) {
  const FILE = path.join(dataDir, 'ipscan.json');
  let D = defaultData();
  let job = null, timer = null;

  function load() {
    try {
      if (fs.existsSync(FILE)) {
        const x = JSON.parse(fs.readFileSync(FILE, 'utf8'));
        D = Object.assign(defaultData(), x);
        D.settings = Object.assign(defaultSettings(), x.settings);
        D.settings.schedule = Object.assign(defaultSettings().schedule, (x.settings || {}).schedule);
      }
    } catch (e) { log.warn('[ipscan] อ่าน ipscan.json ไม่ได้:', e.message); }
  }
  function saveNow() { clearTimeout(timer); timer = null; const t = `${FILE}.tmp`; fs.writeFileSync(t, JSON.stringify(D)); fs.renameSync(t, FILE); }
  function save() { if (!timer) timer = setTimeout(() => { try { saveNow(); } catch (e) { log.warn('[ipscan] บันทึกไม่ได้:', e.message); } }, 1500); }

  /* -------------------------------------------------------------- ranges */
  function cleanRange(b, old) {
    const name = String(b.name || '').trim().slice(0, 80);
    if (!name) throw new Error('กรุณาตั้งชื่อช่วง IP (เช่น VLAN 10 OPD)');
    const spec = String(b.spec || '').trim();
    const r = parseRange(spec);
    const others = D.ranges.filter((x) => x !== old);
    const total = others.reduce((a, x) => a + parseRange(x.spec).count, 0) + r.count;
    if (total > MAX_TOTAL) throw new Error(`รวมทุกช่วงสแกนได้ไม่เกิน ${MAX_TOTAL} IP`);
    return { name, spec: r.cidr || spec.replace(/\s+/g, ''), vlan: String(b.vlan || '').trim().slice(0, 20), note: String(b.note || '').trim().slice(0, 200),
      enabled: b.enabled !== false, count: r.count, first: r.first, last: r.last };
  }
  function addRange(b) { const r = { id: crypto.randomBytes(5).toString('hex'), ...cleanRange(b), created: Date.now() }; D.ranges.push(r); saveNow(); return r; }
  function updateRange(id, b) { const r = D.ranges.find((x) => x.id === id); if (!r) return null; Object.assign(r, cleanRange({ ...r, ...b }, r)); saveNow(); return r; }
  function removeRange(id) { const n = D.ranges.length; D.ranges = D.ranges.filter((x) => x.id !== id); delete D.results[id]; if (n !== D.ranges.length) saveNow(); return n !== D.ranges.length; }

  /* ---------------------------------------------------------------- scan */
  async function probe(ip, S) {
    const t = Math.max(200, Math.min(5000, S.timeoutMs));
    const ms = await icmp(ip, t);
    if (ms != null) return { rtt: Math.round(ms * 10) / 10, via: 'icmp' };
    const ports = (S.ports || []).slice(0, 12);
    if (!ports.length) return null;
    return new Promise((resolve) => {
      let left = ports.length, done = false;
      ports.forEach((p) => tcp(ip, p, t).then((v) => {
        if (done) return;
        if (v != null) { done = true; resolve({ rtt: Math.round(v * 10) / 10, via: `tcp:${p}` }); }
        else if (--left === 0) resolve(null);
      }));
    });
  }
  function status() {
    return job ? { running: !job.finished, cancel: job.cancel, by: job.by, startedAt: job.startedAt, finishedAt: job.finishedAt || null,
      done: job.done, total: job.total, found: job.found, current: job.current, ranges: job.ranges.map((r) => r.name) } : { running: false };
  }
  function run(ids, by = 'manual') {
    if (job && !job.finished) throw new Error('กำลังสแกนอยู่ กรุณารอให้เสร็จก่อน');
    const ranges = D.ranges.filter((r) => r.enabled && (!ids || !ids.length || ids.includes(r.id)));
    if (!ranges.length) throw new Error('ยังไม่มีช่วง IP ที่เปิดใช้งาน');
    const parsed = ranges.map((r) => ({ r, p: parseRange(r.spec) }));
    job = { by, startedAt: Date.now(), done: 0, total: parsed.reduce((a, x) => a + x.p.count, 0), found: 0, current: '', ranges, cancel: false, finished: false };
    const j = job;
    (async () => {
      const S = D.settings;
      for (const { r, p } of parsed) {
        if (j.cancel) break;
        j.current = r.name;
        const t0 = Date.now();
        const hosts = [];
        let next = p.start;
        const worker = async () => {
          while (next <= p.end && !j.cancel) {
            const ip = n2ip(next++);
            const res = await probe(ip, S).catch(() => null);
            j.done++;
            if (res) { hosts.push({ ip, ...res }); j.found++; }
          }
        };
        let last = 0;
        const tick = setInterval(() => { if (j.done !== last) { last = j.done; onUpdate(status()); } }, 1000);
        await Promise.all(Array.from({ length: Math.max(1, Math.min(256, S.concurrency || 64)) }, worker));
        clearInterval(tick);
        if (j.cancel) break;
        const arp = readArp();
        if (S.resolveNames) {
          await Promise.all(hosts.map(async (h) => { const n = await withTimeout(dns.reverse(h.ip).catch(() => null), 2000); if (n && n[0]) h.name = n[0].replace(/\.$/, ''); }));
        }
        hosts.forEach((h) => { if (arp.has(h.ip)) h.mac = arp.get(h.ip); });
        hosts.sort((a, b) => ip2n(a.ip) - ip2n(b.ip));
        const prev = D.results[r.id];
        const prevSet = new Set(prev ? prev.hosts.map((h) => h.ip) : []);
        const now = new Set(hosts.map((h) => h.ip));
        D.results[r.id] = { at: Date.now(), ms: Date.now() - t0, total: p.count, alive: hosts.length, hosts, by,
          appeared: prev ? hosts.filter((h) => !prevSet.has(h.ip)).map((h) => h.ip) : [], gone: prev ? [...prevSet].filter((ip) => !now.has(ip)) : [] };
        D.history.push({ at: Date.now(), rangeId: r.id, name: r.name, total: p.count, alive: hosts.length });
        if (D.history.length > HISTORY_CAP) D.history.splice(0, D.history.length - HISTORY_CAP);
        save();
      }
      j.finished = true; j.finishedAt = Date.now(); j.current = '';
      saveNow();
      onUpdate(status());
      onDone(j);
      log.log(`[ipscan] สแกน ${j.ranges.length} ช่วง ${j.done}/${j.total} IP พบ ${j.found} เครื่อง ใช้เวลา ${Math.round((j.finishedAt - j.startedAt) / 1000)} วินาที${j.cancel ? ' (ยกเลิก)' : ''}`);
    })().catch((e) => { j.finished = true; j.error = e.message; log.warn('[ipscan]', e.message); });
    return status();
  }
  function cancel() { if (job && !job.finished) job.cancel = true; return status(); }

  /* ------------------------------------------------------------ schedule */
  setInterval(() => {
    const sc = D.settings.schedule;
    if (!sc.enabled || (job && !job.finished) || !D.ranges.some((r) => r.enabled)) return;
    const now = new Date();
    const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const every = Math.max(1, Number(sc.everyHours) || 24) * 3600000;
    const last = D.settings.lastScheduled || 0;
    const due = every >= 86400000 ? (hm === sc.at && Date.now() - last > 3600000) : Date.now() - last >= every;
    if (!due) return;
    D.settings.lastScheduled = Date.now(); save();
    try { run(null, 'schedule'); } catch (e) { log.warn('[ipscan] สแกนตามเวลาไม่สำเร็จ:', e.message); }
  }, 30000).unref();

  return {
    load, save, saveNow, parseRange, inRange, addRange, updateRange, removeRange, run, cancel, status,
    get data() { return D; },
    set data(x) { if (job && !job.finished) job.cancel = true; D = Object.assign(defaultData(), x || {}); D.settings = Object.assign(defaultSettings(), (x || {}).settings); D.settings.schedule = Object.assign(defaultSettings().schedule, ((x || {}).settings || {}).schedule); saveNow(); },
    setSettings(b) {
      const s = D.settings;
      if (b.concurrency !== undefined) s.concurrency = Math.max(1, Math.min(256, parseInt(b.concurrency, 10) || 64));
      if (b.timeoutMs !== undefined) s.timeoutMs = Math.max(200, Math.min(5000, parseInt(b.timeoutMs, 10) || 800));
      if (b.ports !== undefined) {
        const ports = String(Array.isArray(b.ports) ? b.ports.join(',') : b.ports).split(/[\s,]+/).filter(Boolean).map(Number);
        if (ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) throw new Error('พอร์ตต้องเป็นตัวเลข 1–65535');
        if (ports.length > 12) throw new Error('กำหนดพอร์ตได้ไม่เกิน 12 พอร์ต');
        s.ports = [...new Set(ports)];
      }
      if (b.resolveNames !== undefined) s.resolveNames = !!b.resolveNames;
      if (b.schedule) {
        const sc = s.schedule;
        if (b.schedule.enabled !== undefined) sc.enabled = !!b.schedule.enabled;
        if (b.schedule.everyHours !== undefined) sc.everyHours = [1, 2, 3, 4, 6, 8, 12, 24].includes(Number(b.schedule.everyHours)) ? Number(b.schedule.everyHours) : 24;
        if (b.schedule.at !== undefined) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.schedule.at)) throw new Error('เวลาต้องเป็นรูปแบบ HH:MM'); sc.at = b.schedule.at; }
      }
      saveNow();
      return s;
    },
  };
};
module.exports.parseRange = parseRange;
module.exports.ip2n = ip2n;
module.exports.defaultData = defaultData;
