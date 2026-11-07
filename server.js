'use strict';
/**
 * SMART TOPOLOGY — Network Monitoring System (NOC)
 * Zero-dependency Node.js server (Node >= 18)
 *  - Login / session (scrypt hashed passwords, HttpOnly cookie)
 *  - Users & roles: admin / operator / viewer
 *  - Device inventory (switch, router, server, IP ...)
 *  - Real monitoring: ICMP ping (system `ping`) or TCP port check
 *  - Alerts on status change, live updates via Server-Sent Events
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');
const createMysqlLog = require('./lib/mysqlLog');
const createDbSync = require('./lib/dbSync');
const createGateway = require('./lib/apiGateway');
const backupLib = require('./lib/backup');
const createWazuh = require('./lib/wazuh');
const openapiSpec = require('./lib/openapi');
const createInventory = require('./lib/inventory');
const createIpScan = require('./lib/ipscan');
const APP_VERSION = (() => { try { return require('./package.json').version; } catch { return '0'; } })();
const STARTED = Date.now();

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const PUBLIC = path.join(__dirname, 'public');
const HISTORY_LEN = 60;
const SESSION_TTL = 12 * 3600 * 1000;
const TYPES = ['isp', 'firewall', 'router', 'core', 'switch', 'ap', 'server', 'vm', 'database',
  'client', 'laptop', 'camera', 'printer', 'medical', 'kiosk', 'iot', 'other'];
const ROLE_RANK = { integration: 0, agent: 0, viewer: 1, operator: 2, admin: 3 };

/* ------------------------------------------------------------------ DB */
let db;
const mylog = createMysqlLog({
  getConfig: () => db && db.mysql,
  getDevices: () => (db ? db.devices : []),
  getIntervalSec: () => (db ? db.settings.intervalSec : 10),
}); // บันทึก log ลง MySQL (lib/mysqlLog.js)
const dbsync = createDbSync({
  getConfig: () => db && db.dbsync,
  onIssue: (i) => onDbIssue(i),
  onSample: (x) => { mylog.recordDbSync(x); clearStaleDbAlerts(x.keys); },
  onUpdate: () => broadcast(),
}); // เฝ้าระวังฐานข้อมูล Master/Slave (lib/dbSync.js)
const gateway = createGateway({ getApi: () => db.api, save: () => save() });   // API Key / CORS / rate limit
const wazuh = createWazuh({
  getConfig: () => db && db.wazuh,
  onAgentChange: (ag, prev, cur) => onWazuhAgent(ag, prev, cur),
  onUpdate: () => broadcast(),
}); // Wazuh Server API (lib/wazuh.js)
const inv = createInventory({ dataDir: DATA_DIR, onChanges: (rows, asset) => onAssetChanges(rows, asset) });   // ทะเบียนคอมพิวเตอร์
const ipscan = createIpScan({ dataDir: DATA_DIR, icmp: (h, t) => icmp(h, t), tcp: (h, p, t) => tcp(h, p, t) });     // สแกน IP
function defaultDB() {
  return {
    users: [], devices: [], alerts: [],
    settings: { intervalSec: 10, timeoutMs: 1000, warnMs: 100, slaTarget: 99.8, siteName: 'โรงพยาบาล' },
    notify: defaultNotify(),
    mysql: defaultMysql(),
    dbsync: defaultDbSync(),
    api: defaultApi(),
    wazuh: defaultWazuh(),
    backup: defaultBackupCfg(),
    seq: { device: 0, alert: 0, user: 0 },
  };
}
const MOPH_URL = 'https://morpromt2f.moph.go.th/api/notify/send';
function defaultApi() { return { enabled: true, cors: [], defaultRate: 120, trustProxy: false, keys: [] }; }
function defaultWazuh() {
  return { enabled: false, url: '', user: 'wazuh', password: '', verifyTls: false, intervalMin: 5, scaMax: 20,
    pushEnabled: false, pushMinSeverity: 'warning', inboundEnabled: true, inboundMinLevel: 7, inboundNotifyLevel: 12,
    inboundAutoResolveMin: 60, agentAlerts: true };
}
function defaultBackupCfg() { return { autoEnabled: true, time: '02:30', keep: 14, includeAlerts: false, lastAuto: null }; }
function defaultDbSide() { return { host: '', port: 3306, user: '', password: '', database: '', ssl: false }; }
function defaultDbSync() {
  return { enabled: false, intervalSec: 60, tableIntervalMin: 30, lagWarn: 30, lagCrit: 300, notify: true, exactTables: '',
    reportEnabled: false, reportTimes: '09:05, 12:10, 16:10', reportOnlyDiff: false,
    master: defaultDbSide(), slave: defaultDbSide(), queries: [] };
}
function defaultMysql() {
  const e = process.env;
  return { enabled: !!e.NMS_MYSQL_HOST, host: e.NMS_MYSQL_HOST || '', port: Number(e.NMS_MYSQL_PORT) || 3306,
    user: e.NMS_MYSQL_USER || '', password: e.NMS_MYSQL_PASSWORD || '', database: e.NMS_MYSQL_DATABASE || 'smart_topology',
    ssl: false, rawLog: true, rawDays: 30, statDays: 90, hourDays: 0 };
}
function defaultNotify() {
  return { enabled: false, onDown: true, onRecover: true, onWarning: false, criticalOnly: false,
    suppressChildren: true, repeatMin: 0, publicUrl: '', channels: [], log: [] };
}
function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(String(pw), salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  try {
    const [salt, h] = stored.split(':');
    const a = crypto.scryptSync(String(pw), salt, 64);
    const b = Buffer.from(h, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function loadDB() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const def = defaultDB();
  if (fs.existsSync(DB_FILE)) {
    db = Object.assign(def, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    db.settings = Object.assign(defaultDB().settings, db.settings);
    db.seq = Object.assign(defaultDB().seq, db.seq);
    db.notify = Object.assign(defaultNotify(), db.notify);
    db.mysql = Object.assign(defaultMysql(), db.mysql);
    db.dbsync = Object.assign(defaultDbSync(), db.dbsync);
    db.dbsync.master = Object.assign(defaultDbSide(), db.dbsync.master);
    db.dbsync.slave = Object.assign(defaultDbSide(), db.dbsync.slave);
    db.api = Object.assign(defaultApi(), db.api);
    db.wazuh = Object.assign(defaultWazuh(), db.wazuh);
    db.backup = Object.assign(defaultBackupCfg(), db.backup);
  } else db = def;
  if (!db.users.length) {
    const pw = process.env.ADMIN_PASSWORD || 'admin1234';
    db.users.push({ id: ++db.seq.user, username: 'admin', name: 'ผู้ดูแลระบบ', role: 'admin',
      pass: hashPw(pw), mustChange: !process.env.ADMIN_PASSWORD, created: Date.now() });
    console.log(`[init] สร้างผู้ใช้ admin (รหัสผ่าน: ${process.env.ADMIN_PASSWORD ? '(จาก ADMIN_PASSWORD)' : 'admin1234'}) — กรุณาเปลี่ยนรหัสผ่านหลังเข้าระบบ`);
  }
  saveNow();
}
let saveTimer = null;
function save() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 400); }
function saveNow() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}

/* ------------------------------------------------------------- Checks */
let pingMissingLogged = false;
function icmp(host, timeout) {
  return new Promise((resolve) => {
    const p = process.platform;
    const tSec = Math.max(1, Math.ceil(timeout / 1000));
    const args = p === 'win32' ? ['-n', '1', '-w', String(timeout), host]
      : p === 'darwin' ? ['-c', '1', '-t', String(tSec), host]
        : ['-c', '1', '-W', String(tSec), host];
    const start = process.hrtime.bigint();
    execFile('ping', args, { timeout: timeout + 2500, windowsHide: true }, (err, stdout) => {
      const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
      const out = String(stdout || '');
      if (err) {
        if (err.code === 'ENOENT' && !pingMissingLogged) {
          pingMissingLogged = true;
          console.warn('[warn] ไม่พบคำสั่ง ping ในระบบ — ติดตั้ง iputils-ping หรือใช้การตรวจแบบ TCP');
        }
        return resolve(null);
      }
      if (p === 'win32' && !/TTL=/i.test(out)) return resolve(null);
      const m = out.match(/time[=<]\s*([\d.]+)\s*ms/i) || out.match(/[=<]\s*([\d.]+)\s*ms/);
      resolve(m ? parseFloat(m[1]) : elapsed);
    });
  });
}
function tcp(host, port, timeout) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    const start = process.hrtime.bigint();
    let done = false;
    const fin = (v) => { if (done) return; done = true; s.destroy(); resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(Number(process.hrtime.bigint() - start) / 1e6));
    s.once('timeout', () => fin(null));
    s.once('error', () => fin(null));
    try { s.connect(port, host); } catch { fin(null); }
  });
}

/* ------------------------------------------------------------ Monitor */
const rt = new Map();
let cycle = 0, lastCycleAt = 0, cycleRunning = false, timer = null;
const trend = [];
function getRt(id) {
  if (!rt.has(id)) rt.set(id, { status: 'unknown', latency: null, history: [], lastCheck: 0, since: Date.now(), fails: 0 });
  return rt.get(id);
}
const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

function addAlert(d, severity, kind, message) {
  const open = db.alerts.find((a) => a.deviceId === d.id && a.kind === kind && a.status !== 'resolved');
  if (open) return null;
  const a = { id: ++db.seq.alert, deviceId: d.id, deviceName: d.name, ip: d.ip, severity, kind, message,
    status: 'active', created: Date.now(), ackBy: null, resolvedAt: null };
  db.alerts.push(a);
  if (db.alerts.length > 2000) db.alerts.splice(0, db.alerts.length - 2000);
  save();
  pushAlertEvent(a, 'raised');
  return a;
}
const SEV_RANK = { info: 1, warning: 2, critical: 3 };
/** ส่งเหตุการณ์แจ้งเตือนของ Smart Topology ไปยัง Wazuh (POST /events) */
function pushAlertEvent(a, ev) {
  if (typeof wazuh === 'undefined' || !db.wazuh || !db.wazuh.pushEnabled || String(a.kind).startsWith('wazuh')) return;
  if ((SEV_RANK[a.severity] || 1) < (SEV_RANK[db.wazuh.pushMinSeverity] || 2)) return;
  wazuh.enqueue({ integration: 'smart-topology', st: {
    event: `alert_${ev}`, severity: ev === 'resolved' ? 'info' : a.severity, original_severity: a.severity, kind: a.kind, message: a.message,
    device: { id: a.deviceId, name: a.deviceName, ip: a.ip }, alert_id: a.id, site: db.settings.siteName,
    time: new Date().toISOString(), ...(ev === 'resolved' && a.resolvedAt ? { duration_sec: Math.round((a.resolvedAt - a.created) / 1000) } : {}) } });
}
function resolveAlerts(d, kinds) {
  const done = [];
  for (const a of db.alerts) {
    if (a.deviceId === d.id && a.status !== 'resolved' && (!kinds || kinds.includes(a.kind))) {
      a.status = 'resolved'; a.resolvedAt = Date.now(); done.push(a);
    }
  }
  if (done.length) save();
  done.forEach((a) => pushAlertEvent(a, 'resolved'));
  return done;
}
function onTransition(d, prev, st) {
  if (st === 'offline') {
    resolveAlerts(d, ['latency']);
    const a = addAlert(d, d.critical ? 'critical' : 'warning', 'down',
      `${d.name} (${d.ip}) ไม่ตอบสนอง${d.method === 'tcp' ? ` ที่พอร์ต ${d.port}` : ' ICMP'}`);
    if (a) queueNotify('down', d, a);
  } else if (st === 'warning') {
    resolveAlerts(d, ['down']).forEach((a) => queueNotify('recover', d, a));
    const a = addAlert(d, 'info', 'latency', `${d.name} มีค่า latency สูงเกินเกณฑ์ ${db.settings.warnMs} ms`);
    if (a) queueNotify('warning', d, a);
  } else if (st === 'online') {
    resolveAlerts(d).filter((a) => a.kind === 'down').forEach((a) => queueNotify('recover', d, a));
  } else if (st === 'maintenance' || st === 'disabled') {
    resolveAlerts(d); // ไม่ส่งแจ้งเตือนภายนอกเมื่อเข้าโหมดบำรุงรักษา/ปิดตรวจ
  }
}

/* ------------------------------------------------- External notification */
const pendingN = [];
function queueNotify(kind, d, a) {
  pendingN.push({ kind, id: d.id, alertId: a.id, created: a.created, resolvedAt: a.resolvedAt });
}
const NMETA = {
  down: { icon: '🔴', title: 'อุปกรณ์ขาดการเชื่อมต่อ', color: '#E5384F' },
  repeat: { icon: '⏰', title: 'อุปกรณ์ยังขาดการเชื่อมต่อ', color: '#B42339' },
  recover: { icon: '🟢', title: 'อุปกรณ์กลับมาใช้งานได้', color: '#12A372' },
  warning: { icon: '🟠', title: 'อุปกรณ์ตอบสนองช้า', color: '#E08A00' },
  test: { icon: '✅', title: 'ทดสอบการแจ้งเตือน', color: '#0E7C6B' },
};
const thTime = (t) => new Date(t).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
function thDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} วินาที`;
  if (s < 3600) return `${Math.floor(s / 60)} นาที`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม. ${Math.floor((s % 3600) / 60)} นาที`;
  return `${Math.floor(s / 86400)} วัน ${Math.floor((s % 86400) / 3600)} ชม.`;
}
function buildMessage(kind, items, hidden = 0) {
  const m = NMETA[kind], now = Date.now(), N = db.notify, site = db.settings.siteName || 'Smart Topology';
  const rows = items.slice(0, 10).map(({ d, e }) => {
    const tgt = d.ip + (d.method === 'tcp' ? ':' + d.port : '');
    let info = '';
    if (kind === 'down') info = `ขาดการเชื่อมต่อเมื่อ ${thTime(e.created)}`;
    else if (kind === 'repeat') info = `ขาดการเชื่อมต่อมาแล้ว ${thDur(now - e.created)}`;
    else if (kind === 'recover') info = `กลับมาเมื่อ ${thTime(e.resolvedAt || now)} (ใช้งานไม่ได้ ${thDur((e.resolvedAt || now) - e.created)})`;
    else if (kind === 'warning') info = `Latency ${getRt(d.id).latency ?? '-'} ms (เกณฑ์ ${db.settings.warnMs} ms)`;
    else info = e.info || '';
    return { name: (d.critical ? '[สำคัญ] ' : '') + d.name, target: tgt, location: d.location || '', info,
      detail: `${tgt}${d.location ? ' · ' + d.location : ''}\n${info}` };
  });
  const extra = [];
  if (items.length > 10) extra.push(`…และอีก ${items.length - 10} รายการ`);
  if (hidden) extra.push(`+ อุปกรณ์ปลายทางที่ได้รับผลกระทบอีก ${hidden} รายการ`);
  const title = `${m.icon} ${m.title}${kind === 'test' ? '' : ` (${items.length} รายการ)`}`;
  const text = `${title}\n${site}\n\n` + rows.map((r, i) => `${i + 1}. ${r.name}\n   ${r.detail.replace('\n', '\n   ')}`).join('\n')
    + (extra.length ? '\n' + extra.join('\n') : '') + `\n\nเวลา ${thTime(now)}` + (N.publicUrl ? `\n${N.publicUrl}` : '');
  return { kind, title, site, color: m.color, rows, extra, text, time: now };
}
function flexBubble(msg) {
  const T = (text, o = {}) => ({ type: 'text', text: String(text || '-').slice(0, 300), wrap: true, ...o });
  const body = [];
  msg.rows.forEach((r, i) => {
    if (i) body.push({ type: 'separator', margin: 'md' });
    body.push({ type: 'box', layout: 'vertical', margin: i ? 'md' : 'none', spacing: 'xs', contents: [
      T(r.name, { weight: 'bold', size: 'sm', color: '#1B2533' }),
      T(`${r.target}${r.location ? ' · ' + r.location : ''}`, { size: 'xs', color: '#0E7C6B' }),
      T(r.info, { size: 'xs', color: '#66768A' })] });
  });
  msg.extra.forEach((x) => body.push(T(x, { size: 'xs', color: '#E5384F', margin: 'md' })));
  const footer = [T(`Smart Topology NOC · ${thTime(msg.time)}`, { size: 'xxs', color: '#9AA8B8', align: 'center' })];
  if (/^https?:\/\//i.test(db.notify.publicUrl || '')) {
    footer.unshift({ type: 'button', style: 'primary', color: '#0E7C6B', height: 'sm',
      action: { type: 'uri', label: 'เปิดระบบ NOC', uri: db.notify.publicUrl } });
  }
  return { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: msg.color, paddingAll: '14px', contents: [
      T(msg.title, { color: '#FFFFFF', weight: 'bold', size: 'md' }), T(msg.site, { color: '#FFFFFFCC', size: 'xs' })] },
    body: { type: 'box', layout: 'vertical', contents: body.length ? body : [T('-')] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } };
}
function parseHeaderLines(txt) {
  const h = {};
  String(txt || '').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) { const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim(); if (/^[A-Za-z0-9-]+$/.test(k)) h[k] = v; }
  });
  return h;
}
async function sendChannel(c, msg, attempt = 1) {
  const entry = { t: Date.now(), channel: c.name || c.type, type: c.type, kind: msg.kind, ok: false, status: null, info: '' };
  try {
    let url, body;
    const headers = { 'Content-Type': 'application/json' };
    if (c.type === 'moph') {
      url = c.url || MOPH_URL;
      headers['client-key'] = c.clientKey || ''; headers['secret-key'] = c.secretKey || '';
      body = { messages: [c.format === 'text' ? { type: 'text', text: msg.text.slice(0, 4900) }
        : { type: 'flex', altText: msg.title.slice(0, 390), contents: msg.flex || flexBubble(msg) }] };
    } else if (c.type === 'telegram') {
      url = `https://api.telegram.org/bot${c.botToken}/sendMessage`;
      body = { chat_id: c.chatId, text: msg.text.slice(0, 4000), disable_web_page_preview: true };
    } else {
      url = c.url;
      Object.assign(headers, parseHeaderLines(c.headers));
      body = { event: msg.kind, title: msg.title, text: msg.text, content: msg.text.slice(0, 1900), site: msg.site,
        time: new Date(msg.time).toISOString(), devices: msg.rows.map((r) => ({ name: r.name, target: r.target, location: r.location, info: r.info })) };
    }
    const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const txt = (await r.text()).slice(0, 300);
    entry.status = r.status; entry.ok = r.ok; entry.info = txt;
    // บาง API ตอบ 200 แต่แจ้ง error ใน body
    try { const j = JSON.parse(txt); if (j && (j.ok === false || j.success === false || /error|fail/i.test(String(j.status || '')))) entry.ok = false; } catch { /* not json */ }
  } catch (e) {
    entry.info = e.name === 'TimeoutError' ? 'หมดเวลาเชื่อมต่อ (10 วินาที)' : String((e.cause && (e.cause.code || e.cause.message)) || e.message);
  }
  if (!entry.ok && attempt === 1 && (entry.status == null || entry.status >= 500)) {
    await new Promise((r) => setTimeout(r, 5000));
    return sendChannel(c, msg, 2);
  }
  if (attempt > 1) entry.info = `(ส่งซ้ำ) ${entry.info}`;
  db.notify.log.push(entry);
  if (db.notify.log.length > 100) db.notify.log.splice(0, db.notify.log.length - 100);
  save();
  if (!entry.ok) console.warn(`[notify] ส่งไม่สำเร็จ (${entry.channel}): ${entry.status || ''} ${entry.info}`);
  return entry;
}
function eligible(d) { const N = db.notify; return d.notify !== false && (!N.criticalOnly || d.critical); }
function hasOfflineAncestor(d, downIds) {
  let cur = d.parentId, g = 0;
  while (cur != null && g++ < 100) {
    const p = db.devices.find((x) => x.id === cur);
    if (!p) return false;
    if (downIds.has(p.id) && eligible(p)) return true;
    cur = p.parentId;
  }
  return false;
}
let flushing = Promise.resolve();
function flushNotify() {
  flushing = flushing.then(doFlush).catch((e) => console.error('[notify]', e));
  return flushing;
}
async function doFlush() {
  const N = db.notify;
  if (!N.repeatMin || !N.enabled) { /* no-op */ } else {
    const now = Date.now();
    for (const a of db.alerts) {
      if (a.kind === 'down' && a.status === 'active' && a.lastNotified && now - a.lastNotified >= N.repeatMin * 60000) {
        a.lastNotified = now; pendingN.push({ kind: 'repeat', id: a.deviceId, alertId: a.id, created: a.created });
      }
    }
  }
  if (!pendingN.length) return;
  const evs = pendingN.splice(0);
  const chans = N.channels.filter((c) => c.enabled);
  if (!N.enabled || !chans.length) return;
  const allow = { down: N.onDown, repeat: N.onDown, recover: N.onRecover, warning: N.onWarning };
  const groups = { down: [], repeat: [], recover: [], warning: [] };
  for (const e of evs) {
    const d = db.devices.find((x) => x.id === e.id);
    if (!d || !allow[e.kind] || !eligible(d)) continue;
    // แจ้ง "กลับมา" เฉพาะอุปกรณ์ที่เคยส่งแจ้ง "ล่ม" ไปแล้วจริง
    if (e.kind === 'recover') { const a = db.alerts.find((x) => x.id === e.alertId); if (!a || !a.lastNotified) continue; }
    groups[e.kind].push({ d, e });
  }
  const downIds = new Set(db.devices.filter((x) => getRt(x.id).status === 'offline').map((x) => x.id));
  for (const kind of Object.keys(groups)) {
    let items = groups[kind], hidden = 0;
    if (!items.length) continue;
    if (N.suppressChildren && (kind === 'down' || kind === 'repeat')) {
      const keep = items.filter((it) => !hasOfflineAncestor(it.d, downIds));
      hidden = items.length - keep.length;
      items = keep;
      if (!items.length) continue; // อุปกรณ์ต้นทางถูกแจ้งไปแล้ว ไม่ต้องแจ้งซ้ำ
    }
    if (kind === 'down') items.forEach(({ e }) => { const a = db.alerts.find((x) => x.id === e.alertId); if (a) a.lastNotified = Date.now(); });
    const msg = buildMessage(kind, items, hidden);
    await Promise.all(chans.map((c) => sendChannel(c, msg)));
  }
}
const SECRET_FIELDS = ['clientKey', 'secretKey', 'botToken'];
const maskVal = (v) => (v ? '••••' + String(v).slice(-4) : '');
function notifyView() {
  const N = db.notify;
  return { ...N, defaultUrl: MOPH_URL, log: N.log.slice(-30).reverse(),
    channels: N.channels.map((c) => { const o = { ...c }; SECRET_FIELDS.forEach((k) => { if (o[k]) o[k] = maskVal(o[k]); }); return o; }) };
}
function validChannel(c, strict) {
  const old = db.notify.channels.find((x) => x.id === c.id);
  const type = ['moph', 'webhook', 'telegram'].includes(c.type) ? c.type : null;
  if (!type) throw bad('ประเภทช่องทางไม่ถูกต้อง');
  const keep = (k) => { const v = c[k]; return typeof v === 'string' && v.startsWith('••••') && old ? old[k] : str(v, 500); };
  const ch = { id: old ? old.id : crypto.randomBytes(6).toString('hex'), type, enabled: c.enabled !== false,
    name: str(c.name, 60) || { moph: 'MOPH Notify (หมอพร้อม)', webhook: 'Webhook', telegram: 'Telegram' }[type] };
  if (type === 'moph') {
    ch.url = str(c.url, 500) || MOPH_URL; ch.clientKey = keep('clientKey'); ch.secretKey = keep('secretKey');
    ch.format = c.format === 'text' ? 'text' : 'flex';
    if (strict && (!ch.clientKey || !ch.secretKey)) throw bad(`${ch.name}: กรุณาระบุ client-key และ secret-key`);
  } else if (type === 'telegram') {
    ch.botToken = keep('botToken'); ch.chatId = str(c.chatId, 60);
    if (strict && (!ch.botToken || !ch.chatId)) throw bad(`${ch.name}: กรุณาระบุ Bot Token และ Chat ID`);
  } else {
    ch.url = str(c.url, 500); ch.headers = str(c.headers, 2000);
  }
  if (ch.url && !/^https?:\/\/[^\s]+$/i.test(ch.url)) throw bad(`${ch.name}: URL ต้องขึ้นต้นด้วย http:// หรือ https://`);
  if (type === 'webhook' && strict && !ch.url) throw bad(`${ch.name}: กรุณาระบุ URL`);
  return ch;
}
async function checkDevice(d) {
  const r = getRt(d.id);
  const ms = d.method === 'tcp' ? await tcp(d.ip, d.port, db.settings.timeoutMs) : await icmp(d.ip, db.settings.timeoutMs);
  // อุปกรณ์อาจถูกลบระหว่างตรวจ
  if (!db.devices.find((x) => x.id === d.id)) return;
  r.lastCheck = Date.now();
  r.history.push(r2(ms));
  if (r.history.length > HISTORY_LEN) r.history.shift();
  r.latency = r2(ms);
  let st;
  if (ms == null) {
    r.fails++;
    st = (r.fails >= 2 || r.status === 'unknown' || r.status === 'offline') ? 'offline' : r.status;
  } else {
    r.fails = 0;
    st = ms > db.settings.warnMs ? 'warning' : 'online';
  }
  if (d.maintenance) st = 'maintenance';
  mylog.recordCheck(d, ms, st, r.lastCheck);
  if (st !== r.status) {
    const prev = r.status, prevSince = r.since;
    r.status = st; r.since = Date.now();
    mylog.recordEvent(d, prev, st, prevSince, r.latency, r.since);
    onTransition(d, prev, st);
  }
}
async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; try { await fn(it); } catch (e) { console.error(e); } }
  });
  await Promise.all(workers);
}
async function runCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    const list = db.devices.filter((d) => d.enabled);
    await pool(list, 48, checkDevice);
    for (const d of db.devices.filter((x) => !x.enabled)) {
      const r = getRt(d.id);
      if (r.status !== 'disabled') { r.status = 'disabled'; r.since = Date.now(); r.latency = null; onTransition(d, null, 'disabled'); }
    }
    cycle++; lastCycleAt = Date.now();
    const mon = list.filter((d) => !d.maintenance);
    const lats = mon.map((d) => getRt(d.id).latency).filter((v) => v != null);
    const avg = lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : null;
    const jitter = lats.length > 1 ? Math.sqrt(lats.reduce((a, b) => a + (b - avg) ** 2, 0) / lats.length) : 0;
    const up = mon.filter((d) => ['online', 'warning'].includes(getRt(d.id).status)).length;
    trend.push({ t: lastCycleAt, avg: r2(avg), jitter: r2(jitter), up, total: mon.length });
    if (trend.length > HISTORY_LEN) trend.shift();
    broadcast();
    flushNotify();
  } finally { cycleRunning = false; }
}
function schedule() {
  clearInterval(timer);
  timer = setInterval(runCycle, Math.max(3, db.settings.intervalSec) * 1000);
}

/* -------------------------------------------------------------- State */
function lossPct(h) {
  if (!h.length) return null;
  const s = h.slice(-20);
  return Math.round((s.filter((v) => v == null).length / s.length) * 100);
}
function devView(d) {
  const r = getRt(d.id);
  const status = d.enabled ? (d.maintenance && r.status !== 'unknown' ? 'maintenance' : r.status) : 'disabled';
  return { ...d, status, latency: r.latency, lastCheck: r.lastCheck, since: r.since, history: r.history, loss: lossPct(r.history) };
}
function stateView() {
  return {
    cycle, lastCycleAt, serverTime: Date.now(), settings: db.settings,
    devices: db.devices.map(devView), trend, alerts: db.alerts.slice(-300), dbsync: dbsync.summary(), wazuh: wazuh.summary(),
  };
}
const clients = new Set();
function broadcast() {
  if (!clients.size) return;
  const payload = `event: state\ndata: ${JSON.stringify(stateView())}\n\n`;
  for (const c of clients) {
    const ok = typeof c.uid === 'string' ? db.api.keys.some((k) => `key:${k.id}` === c.uid && k.enabled) : db.users.some((x) => x.id === c.uid);
    if (!ok) { c.res.end(); clients.delete(c); continue; }
    c.res.write(payload);
  }
}
setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 25000);

/* --------------------------------------------------------- Validation */
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (m) => new HttpError(400, m);
const str = (v, n = 200) => String(v == null ? '' : v).trim().slice(0, n);
const HOST_RE = /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9.\-:]*[a-zA-Z0-9])?$/;

function wouldCycle(id, parentId) {
  let cur = parentId, guard = 0;
  while (cur != null && guard++ < 10000) {
    if (cur === id) return true;
    const p = db.devices.find((x) => x.id === cur);
    cur = p ? p.parentId : null;
  }
  return false;
}
function validDevice(b, existing) {
  const d = {};
  d.name = str(b.name, 120);
  if (!d.name) throw bad('กรุณาระบุชื่ออุปกรณ์');
  d.ip = str(b.ip, 253);
  if (!HOST_RE.test(d.ip)) throw bad('รูปแบบ IP / Hostname ไม่ถูกต้อง');
  d.type = TYPES.includes(b.type) ? b.type : 'other';
  d.method = b.method === 'tcp' ? 'tcp' : 'icmp';
  d.port = null;
  if (d.method === 'tcp') {
    d.port = parseInt(b.port, 10);
    if (!(d.port >= 1 && d.port <= 65535)) throw bad('พอร์ต TCP ต้องอยู่ระหว่าง 1-65535');
  }
  d.vendor = str(b.vendor, 40);
  d.model = str(b.model, 120);
  d.code = str(b.code, 40);
  d.location = str(b.location, 160);
  d.vlan = str(b.vlan, 20);
  d.mac = str(b.mac, 40);
  d.linkLabel = str(b.linkLabel, 40);
  d.description = str(b.description, 500);
  d.critical = !!b.critical;
  d.maintenance = !!b.maintenance;
  d.enabled = b.enabled !== false;
  d.notify = b.notify !== false;
  const pid = b.parentId === '' || b.parentId == null ? null : parseInt(b.parentId, 10);
  if (pid != null) {
    if (!db.devices.find((x) => x.id === pid)) throw bad('ไม่พบอุปกรณ์ต้นทาง (Uplink) ที่เลือก');
    if (existing && (pid === existing.id || wouldCycle(existing.id, pid))) throw bad('ไม่สามารถเชื่อมต่อแบบวนซ้ำได้');
  }
  d.parentId = pid;
  const dup = db.devices.find((x) => x.ip === d.ip && x.method === d.method && x.port === d.port && (!existing || x.id !== existing.id));
  if (dup) throw bad(`IP นี้ถูกใช้แล้วโดย "${dup.name}" (ใช้วิธีตรวจหรือพอร์ตอื่นหากต้องการซ้ำ)`);
  return d;
}

/* ------------------------------------------------------------- Auth */
const sessions = new Map();
const failures = new Map();
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function getUser(req) {
  const v = gateway.verify(req, clientIp(req));
  if (v) {
    if (v.error) { const e = new HttpError(v.status, v.error); e.rate = v.rate; throw e; }
    const k = v.key;
    return { u: { id: `key:${k.id}`, username: `api:${k.name}`, name: k.name, role: k.role, apiKey: true, keyId: k.id, created: k.created }, token: null, key: k, rate: v.rate };
  }
  const t = parseCookies(req).nms_sid;
  if (!t) return null;
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); return null; }
  s.exp = Date.now() + SESSION_TTL;
  const u = db.users.find((x) => x.id === s.uid);
  return u ? { u, token: t } : null;
}
function isSecure(req) { return process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https'; }
function setCookie(req, res, val, maxAge) {
  res.setHeader('Set-Cookie', `nms_sid=${val}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${isSecure(req) ? '; Secure' : ''}`);
}
const publicUser = (u) => ({ id: u.id, username: u.username, name: u.name, role: u.role, mustChange: !!u.mustChange, created: u.created, lastLogin: u.lastLogin || null });
/* ------------------------------------------------- DB Master/Slave helpers */
const DB_PSEUDO = () => ({ id: -1, name: 'ฐานข้อมูล HIS (Master/Slave)', ip: `${db.dbsync.master.host} → ${db.dbsync.slave.host}`, critical: true });
function notifyDb(kind, text, durMs) {
  const N = db.notify, c = db.dbsync;
  if (!N.enabled || !c.notify) return;
  const chans = N.channels.filter((x) => x.enabled);
  if (!chans.length) return;
  const title = kind === 'down' ? '🔴 ฐานข้อมูล Master/Slave มีปัญหา' : '🟢 ฐานข้อมูล Master/Slave กลับมาปกติ';
  const target = `${c.master.host}:${c.master.port} → ${c.slave.host}:${c.slave.port}`;
  const info = text + (durMs ? ` (นาน ${thDur(durMs)})` : '');
  const site = db.settings.siteName || 'Smart Topology';
  const msg = { kind, title, site, color: NMETA[kind].color, time: Date.now(), extra: [],
    rows: [{ name: 'Master → Slave', target, location: '', info, detail: `${target}\n${info}` }],
    text: `${title}\n${site}\n\n${info}\n${target}\n\nเวลา ${thTime(Date.now())}${N.publicUrl ? `\n${N.publicUrl}` : ''}` };
  chans.forEach((ch) => sendChannel(ch, msg).catch(() => {}));
}
/* ------------------------------------------------- รายงานสรุป Master/Slave ตามเวลา */
function parseTimes(v) {
  return [...new Set(String(v || '').split(/[\s,;]+/).map((t) => {
    const m = t.match(/^(\d{1,2})[:.](\d{2})$/);
    return m && +m[1] < 24 && +m[2] < 60 ? `${String(+m[1]).padStart(2, '0')}:${m[2]}` : null;
  }).filter(Boolean))].sort().slice(0, 24);
}
// ใส่ , เฉพาะตัวเลขจำนวน (ไม่เกิน 12 หลัก และไม่ขึ้นต้นด้วย 0) — รหัสอย่าง VN / HN แสดงตามเดิม
const fmtN = (v) => (v == null ? '-' : /^-?[1-9]\d{0,11}$|^0$/.test(String(v)) ? Number(v).toLocaleString('en-US') : String(v));
function buildDbReport(r) {
  const c = db.dbsync, items = [];
  const qres = new Map((r.queries || []).map((x) => [x.id, x]));
  for (const q of c.queries.filter((x) => x.enabled !== false)) {
    const x = qres.get(q.id);
    if (!x) continue;
    if (x.status === 'error') { items.push({ label: q.name, err: (x.master && x.master.error) || (x.slave && x.slave.error) || 'error' }); continue; }
    if (q.target !== 'both') {
      const one = x[q.target];
      items.push({ label: `${q.name} (${q.target === 'master' ? 'M' : 'S'})`, m: q.target === 'master' ? (one.rows[0] || [])[0] : null, s: q.target === 'slave' ? (one.rows[0] || [])[0] : null, ok: true, info: true });
    } else if (q.mode === 'table' && x.master.columns.length === 2) {
      const tol = Number(q.tolerance) || 0;
      items.push({ group: q.name });
      const sm = new Map(x.slave.rows.map((row) => [String(row[0]), row[1]]));
      const keys = [...new Set([...x.master.rows.map((row) => String(row[0])), ...x.slave.rows.map((row) => String(row[0]))])];
      const mm = new Map(x.master.rows.map((row) => [String(row[0]), row[1]]));
      keys.forEach((k) => {
        const a = mm.get(k), b = sm.get(k);
        const num = /^-?\d+(\.\d+)?$/.test(String(a)) && /^-?\d+(\.\d+)?$/.test(String(b));
        const ok = a !== undefined && b !== undefined && (String(a) === String(b) || (num && Math.abs(Number(a) - Number(b)) <= tol));
        items.push({ label: k, m: a, s: b, ok, diff: num ? Number(a) - Number(b) : null });
      });
    } else if (q.mode === 'table') {
      const k = x.compare.counts;
      items.push({ label: q.name, m: `${k.master} แถว`, s: `${k.slave} แถว`, ok: x.compare.ok });
    } else {
      items.push({ label: q.name, m: (x.master.rows[0] || [])[0], s: (x.slave.rows[0] || [])[0], ok: x.compare.ok, diff: x.compare.numeric ? x.compare.diff : null });
    }
  }
  const p = r.replica || {};
  const replOk = r.master.ok && r.slave.ok && !p.error && !p.notReplica && p.io === 'Yes' && p.sql === 'Yes' && !(p.lag >= (c.lagWarn || 30));
  const repl = !r.master.ok ? 'เชื่อมต่อ Master ไม่ได้' : !r.slave.ok ? 'เชื่อมต่อ Slave ไม่ได้' : p.error ? 'ตรวจสถานะไม่ได้ (สิทธิ์)'
    : p.notReplica ? 'Slave ไม่ได้ตั้ง Replication' : p.io !== 'Yes' || p.sql !== 'Yes' ? `หยุดทำงาน (IO ${p.io} / SQL ${p.sql})` : `ปกติ · Delay ${p.lag ?? '-'} วินาที`;
  const cmp = items.filter((i) => !i.info && !i.group);
  const okN = cmp.filter((i) => i.ok).length, errN = items.filter((i) => i.err).length;
  const allOk = replOk && okN === cmp.length - errN && !errN;
  const now = new Date(), site = db.settings.siteName || 'Smart Topology';
  const dateTh = now.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  const timeTh = now.toLocaleTimeString('th-TH', { hour12: false });
  const title = `${allOk ? '✅' : '⚠️'} รายงานเปรียบเทียบฐานข้อมูล Master / Slave`;
  // ---- ข้อความ (รูปแบบเดียวกับ index.php เดิม)
  const L = [title, site, `ข้อมูล HOS-MASTER <=> HOS-SLAVE`, `วันที่ : ${dateTh}`, `ณ เวลา ${timeTh} น.`,
    `Replication : ${replOk ? '✅' : '❌'} ${repl}`, 'M = MASTER : S = SLAVE', '*********************'];
  for (const i of items) {
    if (i.group) { L.push(`【${i.group}】`); continue; }
    if (i.err) { L.push(`${i.label} : ⚠️ ${String(i.err).slice(0, 80)}`, '*********************'); continue; }
    L.push(`${i.label}_M : ${fmtN(i.m)}`, `${i.label}_S : ${fmtN(i.s)}${i.info ? '' : i.ok ? ' ✅' : ` ❌${i.diff ? ` (ต่าง ${i.diff > 0 ? '+' : ''}${fmtN(i.diff)})` : ''}`}`, '*********************');
  }
  L.push(`สรุป : ตรงกัน ${okN}/${cmp.length} รายการ${errN ? ` · ผิดพลาด ${errN}` : ''}`);
  if (db.notify.publicUrl) L.push(db.notify.publicUrl);
  const text = L.join('\n');
  // ---- Flex Message (ตาราง)
  const T = (t, o = {}) => ({ type: 'text', text: String(t == null || t === '' ? '-' : t).slice(0, 120), size: 'xs', wrap: true, ...o });
  const row = (i) => i.group
    ? T(i.group, { weight: 'bold', color: '#0E7C6B', margin: 'md', size: 'sm' })
    : i.err
    ? { type: 'box', layout: 'horizontal', contents: [T(i.label, { flex: 4 }), T(String(i.err).slice(0, 60), { flex: 7, color: '#E08A00' })] }
    : { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [T(i.label, { flex: 4, color: '#1B2533' }), T(fmtN(i.m), { flex: 3, align: 'end' }),
      T(fmtN(i.s), { flex: 3, align: 'end', color: i.ok ? '#1B2533' : '#E5384F', weight: i.ok ? 'regular' : 'bold' }),
      T(i.info ? ' ' : i.ok ? '✓' : '✗', { flex: 1, align: 'end', color: i.ok ? '#12A372' : '#E5384F', weight: 'bold' })] };
  const body = [
    { type: 'box', layout: 'horizontal', contents: [T('Replication', { flex: 4, weight: 'bold' }), T(repl, { flex: 7, align: 'end', color: replOk ? '#12A372' : '#E5384F', weight: 'bold' })] },
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'horizontal', spacing: 'sm', margin: 'md', contents: [T('รายการ', { flex: 4, color: '#9AA8B8' }), T('Master', { flex: 3, align: 'end', color: '#9AA8B8' }), T('Slave', { flex: 3, align: 'end', color: '#9AA8B8' }), T(' ', { flex: 1 })] },
    ...items.slice(0, 40).map(row),
    { type: 'separator', margin: 'md' },
    T(`สรุป: ตรงกัน ${okN}/${cmp.length} รายการ${errN ? ` · ผิดพลาด ${errN}` : ''}`, { margin: 'md', weight: 'bold', color: allOk ? '#12A372' : '#E5384F', size: 'sm' }),
  ];
  const footer = [T(`Smart Topology NOC · ${dateTh} ${timeTh}`, { size: 'xxs', color: '#9AA8B8', align: 'center' })];
  if (/^https?:\/\//i.test(db.notify.publicUrl || '')) footer.unshift({ type: 'button', style: 'primary', color: '#0E7C6B', height: 'sm', action: { type: 'uri', label: 'เปิดระบบ NOC', uri: db.notify.publicUrl } });
  const flex = { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: allOk ? '#12A372' : '#E08A00', paddingAll: '14px', contents: [
      T(title, { color: '#FFFFFF', weight: 'bold', size: 'md' }), T(`${site} · ${dateTh} ${timeTh} น.`, { color: '#FFFFFFCC', size: 'xs' })] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: footer } };
  return { kind: 'report', title, site, color: allOk ? '#12A372' : '#E08A00', time: now.getTime(), extra: [], text, flex, allOk,
    rows: items.filter((i) => !i.group).map((i) => ({ name: i.label, target: '', location: '', info: i.err ? `error: ${i.err}` : `M ${fmtN(i.m)} / S ${fmtN(i.s)}${i.ok ? '' : ' ✗'}` })) };
}
async function sendDbReport(trigger) {
  if (!dbsync.summary().configured) throw bad('กรุณาตั้งค่าการเชื่อมต่อ Master และ Slave ก่อน');
  const r = await dbsync.check(true);
  if (!r) throw bad('ยังตรวจฐานข้อมูลไม่ได้ กรุณาลองใหม่');
  const msg = buildDbReport(r);
  if (trigger === 'preview') return { preview: msg.text, allOk: msg.allOk };
  const chans = db.notify.channels.filter((x) => x.enabled);
  if (!chans.length) throw bad('ยังไม่มีช่องทางแจ้งเตือนที่เปิดใช้งาน — ตั้งค่าที่ ตั้งค่า → การแจ้งเตือนภายนอก');
  if (trigger === 'schedule' && db.dbsync.reportOnlyDiff && msg.allOk) return { skipped: true };
  const results = await Promise.all(chans.map((ch) => sendChannel(ch, msg)));
  return { preview: msg.text, results };
}
const reportSent = new Set();
setInterval(() => {
  const c = db && db.dbsync;
  if (!c || !c.reportEnabled || !c.enabled || !db.notify.enabled) return;
  const now = new Date(), hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (!parseTimes(c.reportTimes).includes(hm)) return;
  const key = `${now.toDateString()} ${hm}`;
  if (reportSent.has(key)) return;
  reportSent.add(key);
  if (reportSent.size > 200) reportSent.clear();
  sendDbReport('schedule').then((x) => console.log(`[dbsync] ส่งรายงานตามเวลา ${hm}${x.skipped ? ' (ข้ามเพราะข้อมูลตรงกัน)' : ''}`))
    .catch((e) => console.warn('[dbsync] ส่งรายงานไม่สำเร็จ:', e.message));
}, 15000).unref();

/** ปิด alert ของฐานข้อมูลที่ค้างจากรอบก่อน (เช่น หลังรีสตาร์ตโปรแกรม) แต่ไม่มีปัญหานั้นแล้ว */
function clearStaleDbAlerts(keys) {
  const k = new Set((keys || []).map((x) => `db:${x}`));
  let changed = false;
  for (const a of db.alerts) {
    if (a.deviceId === -1 && a.status !== 'resolved' && !k.has(a.kind)) { a.status = 'resolved'; a.resolvedAt = Date.now(); changed = true; }
  }
  if (changed) save();
}
function onDbIssue(i) {
  const d = DB_PSEUDO();
  if (i.active) {
    const a = addAlert(d, i.level === 'critical' ? 'critical' : 'warning', `db:${i.key}`, i.text);
    if (a) notifyDb('down', i.text);
  } else {
    resolveAlerts(d, [`db:${i.key}`]).forEach((a) => { if (!i.quiet) notifyDb('recover', `แก้ไขแล้ว: ${a.message}`, a.resolvedAt - a.created); });
  }
  broadcast();
}
function maskSide(x) { return { ...x, password: x.password ? '••••••••' : '' }; }
function validDbSide(b, old, label) {
  b = b || {};
  const o = {
    host: str(b.host, 253), port: parseInt(b.port, 10) || 3306, user: str(b.user, 80),
    password: typeof b.password === 'string' && b.password.startsWith('••••') ? old.password : String(b.password || '').slice(0, 200),
    database: str(b.database, 64), ssl: !!b.ssl,
  };
  if (o.host && !HOST_RE.test(o.host)) throw bad(`${label}: รูปแบบ Host ไม่ถูกต้อง`);
  if (!(o.port >= 1 && o.port <= 65535)) throw bad(`${label}: พอร์ตไม่ถูกต้อง`);
  if (o.database && !/^[A-Za-z0-9_$]{1,64}$/.test(o.database)) throw bad(`${label}: ชื่อฐานข้อมูลไม่ถูกต้อง`);
  return o;
}
function validQuery(b, old) {
  const q = {
    id: old ? old.id : crypto.randomBytes(5).toString('hex'),
    name: str(b.name, 80), description: str(b.description, 300),
    target: ['both', 'master', 'slave'].includes(b.target) ? b.target : 'both',
    mode: b.mode === 'table' ? 'table' : 'value', database: str(b.database, 64),
    tolerance: Math.max(0, Number(b.tolerance) || 0), everyMin: Math.min(1440, Math.max(0, parseInt(b.everyMin, 10) || 0)),
    timeoutSec: Math.min(120, Math.max(1, parseInt(b.timeoutSec, 10) || 15)), enabled: b.enabled !== false,
  };
  if (!q.name) throw bad('กรุณาตั้งชื่อ Query');
  if (q.database && !/^[A-Za-z0-9_$]{1,64}$/.test(q.database)) throw bad('ชื่อฐานข้อมูลไม่ถูกต้อง');
  try { q.sql = createDbSync.validateSql(b.sql); } catch (e) { throw bad(e.message); }
  return q;
}
function dbsyncView(user) {
  const v = dbsync.view(), c = db.dbsync, admin = ROLE_RANK[user.role] >= ROLE_RANK.admin;
  v.queries = c.queries.map((q) => (admin ? q : { id: q.id, name: q.name, description: q.description, target: q.target, mode: q.mode, enabled: q.enabled }));
  if (admin) v.config = { ...c, queries: undefined, master: maskSide(c.master), slave: maskSide(c.slave) };
  v.logDb = mylog.active();
  return v;
}
async function mysqlView() {
  const c = { ...db.mysql, password: db.mysql.password ? '••••••••' : '' };
  return { config: c, status: await mylog.status() };
}
function validMysql(b, forAction = false) {
  const old = db.mysql;
  const c = {
    enabled: !!b.enabled, host: str(b.host, 253), port: parseInt(b.port, 10) || 3306,
    user: str(b.user, 80), password: typeof b.password === 'string' && b.password.startsWith('••••') ? old.password : String(b.password || '').slice(0, 200),
    database: str(b.database, 64) || 'smart_topology', ssl: !!b.ssl, rawLog: b.rawLog !== false,
    rawDays: Math.min(3650, Math.max(0, parseInt(b.rawDays, 10) || 0)),
    statDays: Math.min(3650, Math.max(0, parseInt(b.statDays, 10) || 0)),
    hourDays: Math.min(36500, Math.max(0, parseInt(b.hourDays, 10) || 0)),
  };
  if (c.host && !HOST_RE.test(c.host)) throw bad('รูปแบบ Host ของ MySQL ไม่ถูกต้อง');
  if (!(c.port >= 1 && c.port <= 65535)) throw bad('พอร์ต MySQL ไม่ถูกต้อง');
  if (!/^[A-Za-z0-9_]{1,64}$/.test(c.database)) throw bad('ชื่อฐานข้อมูลใช้ได้เฉพาะ a-z, 0-9 และ _');
  if ((c.enabled || forAction) && (!c.host || !c.user)) throw bad('กรุณาระบุ Host และชื่อผู้ใช้ MySQL');
  return c;
}
function need(user, role) { if (ROLE_RANK[user.role] < ROLE_RANK[role]) throw new HttpError(403, 'สิทธิ์ไม่เพียงพอสำหรับการดำเนินการนี้'); }

/* ------------------------------------------------------------- HTTP */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.xml': 'application/xml; charset=utf-8',
  '.ps1': 'text/plain; charset=utf-8', '.cmd': 'text/plain; charset=utf-8', '.py': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'");
}
function send(res, code, obj) {
  if (res.headersSent) return res.end();
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit = 2e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(bad('รูปแบบ JSON ไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/login') pathname = '/login.html';
  if (pathname === '/api-docs') pathname = '/api-docs.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}
function clientIp(req) {
  const trust = process.env.TRUST_PROXY === '1' || (db && db.api && db.api.trustProxy);
  const xf = trust ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  return createGateway.normIp(xf || req.socket.remoteAddress || '');
}
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur); return out.map((s) => s.trim());
}

function demoDevices() {
  const D = [
    { k: 'isp1', name: 'Internet Uplink (Cloudflare DNS)', ip: '1.1.1.1', type: 'isp', vendor: 'ISP', model: 'Public DNS / Internet', location: 'WAN', critical: true, linkLabel: 'WAN' },
    { k: 'isp2', name: 'Backup Uplink (Google DNS)', ip: '8.8.8.8', type: 'isp', vendor: 'ISP', model: 'Public DNS / Internet', location: 'WAN', linkLabel: 'WAN' },
    { k: 'fw', p: 'isp1', name: 'FortiGate 100F', ip: '127.0.0.1', type: 'firewall', vendor: 'Fortinet', model: 'FortiGate 100F', location: 'Data Center', critical: true, vlan: '1', linkLabel: 'Fiber 10Gbps' },
    { k: 'core', p: 'fw', name: 'Cisco Catalyst 9300-24T (Core)', ip: 'localhost', type: 'core', vendor: 'Cisco', model: 'Catalyst 9300-24T', location: 'Data Center', critical: true, vlan: '1', linkLabel: 'Fiber 10Gbps' },
    { k: 'his', p: 'core', name: 'HIS Database (ตัวอย่างตรวจพอร์ต TCP)', ip: '127.0.0.1', method: 'tcp', port: PORT, type: 'database', vendor: 'Server', model: 'MySQL / HOSxP', location: 'Data Center', critical: true, vlan: '250', linkLabel: 'Fiber 10Gbps' },
    { k: 'sw1', p: 'core', name: 'Aruba 1930 24G (OPD)', ip: '10.255.255.11', type: 'switch', vendor: 'Aruba', model: 'Aruba 1930 24G 4SFP/SFP+', location: 'อาคารผู้ป่วยนอก ชั้น 1', vlan: '31', linkLabel: 'Fiber 10Gbps' },
    { k: 'sw2', p: 'core', name: 'Aruba 1930 24G (ER)', ip: '10.255.255.12', type: 'switch', vendor: 'Aruba', model: 'Aruba 1930 24G 4SFP/SFP+', location: 'อาคารอุบัติเหตุฉุกเฉิน', vlan: '24', linkLabel: 'Fiber 10Gbps' },
    { k: 'ap1', p: 'sw1', name: 'Wi-Fi 6 AP (OPD)', ip: '10.255.255.21', type: 'ap', vendor: 'Cisco', model: 'Catalyst 9120AX', location: 'โถง OPD', vlan: '51' },
    { k: 'pc1', p: 'sw1', name: 'PC ห้องตรวจแพทย์ 1', ip: '10.255.255.31', type: 'client', vendor: 'HP', model: 'ProDesk 400 G9', location: 'OPD ห้องตรวจ 1', vlan: '31' },
    { k: 'cam1', p: 'sw2', name: 'CCTV ทางเข้า ER', ip: '10.255.255.41', type: 'camera', vendor: 'Hikvision', model: 'DS-2CD2186G2-I', location: 'ทางเข้าอุบัติเหตุ', vlan: '24' },
    { k: 'mon1', p: 'sw2', name: 'Bedside Monitor ICU 1', ip: '10.255.255.51', type: 'medical', vendor: 'Mindray', model: 'BeneVision N19', location: 'ICU เตียง 1', vlan: '30' },
  ];
  const map = {}; let added = 0;
  for (const x of D) {
    const exists = db.devices.find((d) => d.ip === x.ip && d.name === x.name);
    if (exists) { map[x.k] = exists.id; continue; }
    let d;
    try { d = validDevice({ ...x, parentId: x.p ? map[x.p] : null, enabled: true }, null); }
    catch {
      const dup = db.devices.find((y) => y.ip === x.ip && y.method === (x.method || 'icmp') && y.port === (x.port || null));
      if (dup) map[x.k] = dup.id;
      continue;
    }
    d.id = ++db.seq.device; d.created = Date.now(); d.code = d.code || `DEV-${String(d.id).padStart(3, '0')}`;
    db.devices.push(d); map[x.k] = d.id; added++;
  }
  return added;
}

/* ================================================================
   ส่วนขยาย: API ภายนอก, API Key, สำรอง/กู้คืน, Wazuh
   ================================================================ */
const maskSecret = (v) => (v ? '••••••••' : '');
const keepSecret = (v, old) => (typeof v === 'string' && v.startsWith('••••') ? old : String(v == null ? '' : v).slice(0, 300));

/* ---------- การแจ้งเตือนภายนอกแบบทั่วไป (ใช้กับ Wazuh) */
function notifyGeneric(kind, title, name, target, info) {
  const N = db.notify;
  if (!N.enabled) return;
  const chans = N.channels.filter((x) => x.enabled);
  if (!chans.length) return;
  const site = db.settings.siteName || 'Smart Topology';
  const msg = { kind, title, site, color: (NMETA[kind] || NMETA.down).color, time: Date.now(), extra: [],
    rows: [{ name, target, location: '', info, detail: `${target}\n${info}` }],
    text: `${title}\n${site}\n\n${name}\n${target}\n${info}\n\nเวลา ${thTime(Date.now())}${N.publicUrl ? `\n${N.publicUrl}` : ''}` };
  chans.forEach((ch) => sendChannel(ch, msg).catch(() => {}));
}

/* ---------- Wazuh: agent เปลี่ยนสถานะ / รับ alert / ปิด alert อัตโนมัติ */
function onWazuhAgent(ag, prev, cur) {
  if (!db.wazuh.agentAlerts) return;
  const d = { id: -3, name: `Wazuh agent ${ag.name}`, ip: ag.ip || '' };
  const kind = `wazuh-agent:${ag.id}`;
  if (cur === 'disconnected' && prev === 'active') {
    const a = addAlert(d, 'warning', kind, `Wazuh agent ${ag.name} (${ag.ip || '-'}) ขาดการเชื่อมต่อกับ Wazuh Manager`);
    if (a) notifyGeneric('down', '🛡️ Wazuh agent ขาดการเชื่อมต่อ', ag.name, ag.ip || '', `สถานะ ${prev} → ${cur}`);
  } else if (cur === 'active') {
    resolveAlerts(d, [kind]).forEach((a) => notifyGeneric('recover', '🛡️ Wazuh agent กลับมาเชื่อมต่อ', ag.name, ag.ip || '', `ขาดการเชื่อมต่อ ${thDur(a.resolvedAt - a.created)}`));
  }
  broadcast();
}
function handleWazuhAlert(a) {
  const c = db.wazuh;
  if (!a || typeof a !== 'object') return { skipped: 'invalid' };
  const rule = a.rule || {}, agent = a.agent || {};
  const level = Number(rule.level) || 0;
  const rec = { at: Date.now(), level, ruleId: String(rule.id || ''), description: str(rule.description, 300), agent: str(agent.name, 100), agentId: str(agent.id, 20),
    ip: str(agent.ip, 64), groups: Array.isArray(rule.groups) ? rule.groups.slice(0, 10).map((g) => str(g, 60)) : [], location: str(a.location, 200),
    mitre: rule.mitre && Array.isArray(rule.mitre.id) ? rule.mitre.id.slice(0, 5) : [], timestamp: str(a.timestamp, 40), accepted: false };
  if (!c.inboundEnabled) { rec.skipped = 'ปิดการรับข้อมูล'; wazuh.addInbound(rec); return { skipped: 'disabled' }; }
  if (level < (c.inboundMinLevel || 0)) { rec.skipped = `level ต่ำกว่า ${c.inboundMinLevel}`; wazuh.addInbound(rec); return { skipped: 'level' }; }
  const sev = level >= 12 ? 'critical' : level >= 7 ? 'warning' : 'info';
  const dev = rec.ip && db.devices.find((d) => d.ip === rec.ip);
  const d = dev ? { id: dev.id, name: dev.name, ip: dev.ip } : { id: -2, name: `Wazuh: ${rec.agent || rec.agentId || 'manager'}`, ip: rec.ip };
  const kind = `wazuh:${rec.ruleId}:${rec.agentId || '000'}`;
  const message = `[Wazuh L${level}] ${rec.description || 'Wazuh alert'} — ${rec.agent}${rec.ip ? ` (${rec.ip})` : ''}`.slice(0, 300);
  let al = db.alerts.find((x) => x.deviceId === d.id && x.kind === kind && x.status !== 'resolved');
  let isNew = false;
  if (al) { al.count = (al.count || 1) + 1; al.lastSeen = Date.now(); al.message = message; }
  else {
    al = addAlert(d, sev, kind, message);
    if (al) { Object.assign(al, { count: 1, lastSeen: Date.now(), source: 'wazuh', wazuh: { ruleId: rec.ruleId, level, groups: rec.groups, mitre: rec.mitre, location: rec.location, agentId: rec.agentId } }); isNew = true; }
  }
  rec.accepted = true; rec.isNew = isNew; rec.alertId = al && al.id;
  wazuh.addInbound(rec);
  if (isNew && level >= (c.inboundNotifyLevel || 12)) {
    notifyGeneric('down', `🛡️ Wazuh แจ้งเตือนระดับ ${level}`, rec.description || `Rule ${rec.ruleId}`, `${rec.agent} ${rec.ip}`.trim(),
      `Rule ${rec.ruleId}${rec.groups.length ? ` · ${rec.groups.join(', ')}` : ''}${rec.location ? ` · ${rec.location}` : ''}`);
  }
  save();
  return { accepted: true, alertId: al && al.id, new: isNew, severity: sev };
}
setInterval(() => {
  if (!db || !db.wazuh) return;
  const ttl = Math.max(1, Number(db.wazuh.inboundAutoResolveMin) || 60) * 60000;
  let changed = false;
  for (const a of db.alerts) {
    if (a.source === 'wazuh' && a.status !== 'resolved' && Date.now() - (a.lastSeen || a.created) > ttl) { a.status = 'resolved'; a.resolvedAt = Date.now(); a.ackBy = a.ackBy || 'auto'; changed = true; }
  }
  if (changed) { save(); broadcast(); }
}, 60000).unref();

/* ---------- สำรองข้อมูล */
const BK_SECTIONS = () => ({ notify: defaultNotify, mysql: defaultMysql, dbsync: defaultDbSync, api: defaultApi, wazuh: defaultWazuh, backup: defaultBackupCfg,
  inventory: createInventory.defaultData, ipscan: createIpScan.defaultData });
/** ข้อมูลทั้งหมดสำหรับไฟล์สำรอง: db.json + ทะเบียนคอมพิวเตอร์ + ช่วงสแกน IP (เก็บแยกไฟล์) */
function bkSource() { return { ...db, inventory: inv.data, ipscan: ipscan.data }; }
function backupFiles() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => /^[A-Za-z0-9._-]+\.json$/.test(f)).map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs, kind: f.split('-')[0] };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}
function writeBackupFile(kind, { includeAlerts = false, by = 'system' } = {}) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const name = `${kind}-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.json`;
  const b = backupLib.build(bkSource(), { includeAlerts, createdBy: by, app: APP_VERSION });
  fs.writeFileSync(path.join(BACKUP_DIR, name), JSON.stringify(b, null, 1), { mode: 0o600 });
  // ลบไฟล์อัตโนมัติที่เกินจำนวนที่เก็บ
  const keep = Math.max(1, Number(db.backup.keep) || 14);
  for (const k of ['auto', 'pre']) {
    backupFiles().filter((f) => f.kind === k).slice(k === 'auto' ? keep : 10).forEach((f) => { try { fs.unlinkSync(path.join(BACKUP_DIR, f.name)); } catch { /* ignore */ } });
  }
  return name;
}
function applyRestore(parsed, by) {
  const { db: ndb, issues } = backupLib.sanitize(parsed.data, {
    defaultDB, sections: BK_SECTIONS(), defaultDbSide, roles: ['viewer', 'operator', 'admin'], validateSql: createDbSync.validateSql });
  const snap = writeBackupFile('pre-restore', { includeAlerts: true, by });           // สำรองค่าปัจจุบันก่อนกู้คืนเสมอ
  if (ndb.alerts === null) ndb.alerts = db.alerts;
  const { inventory: nInv, ipscan: nScan, ...rest } = ndb;
  db = rest;
  if (parsed.data.inventory) inv.data = nInv;      // ไฟล์สำรองเวอร์ชันเก่า (ไม่มีส่วนนี้) → คงทะเบียนปัจจุบันไว้
  if (parsed.data.ipscan) ipscan.data = nScan;
  saveNow();
  // รีเซ็ตทุกส่วนให้ใช้ค่าที่กู้คืน
  rt.clear(); trend.length = 0; sessions.clear();
  for (const c of clients) { try { c.res.end(); } catch { /* ignore */ } } clients.clear();
  mylog.reset(); dbsync.reset(); dbsync.schedule(); wazuh.reset(); wazuh.schedule(); schedule();
  runCycle().catch(() => {});
  console.log(`[backup] กู้คืนข้อมูลโดย ${by} (สำรองค่าเดิมไว้ที่ ${snap})`);
  return { issues, snapshot: snap, summary: backupLib.summarize(bkSource()) };
}
setInterval(() => {
  const b = db && db.backup;
  if (!b || !b.autoEnabled) return;
  const now = new Date(), hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toDateString();
  if (hm !== b.time || b.lastAuto === today) return;
  b.lastAuto = today; save();
  try { console.log(`[backup] สำรองอัตโนมัติ → ${writeBackupFile('auto', { includeAlerts: b.includeAlerts })}`); }
  catch (e) { console.warn('[backup] สำรองอัตโนมัติไม่สำเร็จ:', e.message); }
}, 30000).unref();

/* ---------- ทะเบียนคอมพิวเตอร์ (Inventory) และสแกน IP */
function onAssetChanges(rows, asset) {
  mylog.recordAssetChanges(rows);
  if (!inv.settings.alertHardware) return;
  const warn = rows.filter((c) => c.severity === 'warning');
  if (!warn.length) return;
  const d = { id: -4, name: `PC ${asset.hostname}`, ip: asset.lastIp || (asset.ips || [])[0] || '' };
  for (const c of warn) {
    const a = addAlert(d, 'warning', `inv:${asset.id}:${c.field}:${c.id}`, `[ทะเบียนคอมพิวเตอร์] ${asset.hostname}: ${c.label} ${c.old ? `จาก “${c.old}” ` : ''}${c.new ? `เป็น “${c.new}”` : ''}`.trim().slice(0, 300));
    if (a) { a.source = 'inventory'; a.assetId = asset.id; }
  }
  notifyGeneric('down', '🖥️ ฮาร์ดแวร์เครื่องคอมพิวเตอร์เปลี่ยนแปลง', asset.hostname, d.ip, warn.map((c) => `${c.label}: ${c.old || '-'} → ${c.new || '-'}`).join(' · ').slice(0, 400));
  broadcast();
}
function csvSend(res, name, head, rows) {
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  return res.end('﻿' + [head.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n'));
}
const thDate = (t) => (t ? new Date(t).toLocaleString('th-TH', { hour12: false }) : '');
/** เทียบผลสแกนของช่วง IP กับทะเบียนคอมพิวเตอร์ + อุปกรณ์เครือข่าย */
function scanCompare(range, full) {
  let pr; try { pr = ipscan.parseRange(range.spec); } catch { return null; }
  const res = ipscan.data.results[range.id];
  const alive = res ? res.hosts : [];
  const assets = inv.data.assets.filter((a) => a.status !== 'retired');
  const byIp = new Map();
  assets.forEach((a) => [a.lastIp, ...(a.ips || [])].filter(Boolean).forEach((ip) => { if (!byIp.has(ip)) byIp.set(ip, a); }));
  const byMac = inv.byMac();
  const devByIp = new Map(db.devices.map((d) => [d.ip, d]));
  const seenAsset = new Set(), seenDev = new Set();
  const hosts = alive.map((h) => {
    const a = byIp.get(h.ip) || (h.mac && byMac.get(h.mac)) || null, d = devByIp.get(h.ip) || null;
    if (a) seenAsset.add(a.id); if (d) seenDev.add(d.id);
    return { ...h, cls: a && d ? 'both' : a ? 'asset' : d ? 'device' : 'unknown',
      asset: a && { id: a.id, hostname: a.hostname, department: a.department, assetTag: a.assetTag, state: inv.stateOf(a), byMac: !byIp.get(h.ip) },
      device: d && { id: d.id, name: d.name, type: d.type } };
  });
  const inR = (ip) => ipscan.inRange(ip, pr);
  const assetsInRange = assets.filter((a) => [a.lastIp, ...(a.ips || [])].some((ip) => ip && inR(ip)));
  const devsInRange = db.devices.filter((d) => inR(d.ip));
  const offAssets = assetsInRange.filter((a) => !seenAsset.has(a.id));
  const offDevs = devsInRange.filter((d) => !seenDev.has(d.id));
  const cnt = (c) => hosts.filter((h) => h.cls === c).length;
  const sum = { total: pr.count, alive: alive.length, util: pr.count ? Math.round((alive.length / pr.count) * 1000) / 10 : 0,
    asset: cnt('asset') + cnt('both'), device: cnt('device'), unknown: cnt('unknown'), assetsInRange: assetsInRange.length, devicesInRange: devsInRange.length,
    assetsOffline: offAssets.length, devicesOffline: offDevs.length, scannedAt: res ? res.at : null, ms: res ? res.ms : null,
    appeared: res ? (res.appeared || []).length : 0, gone: res ? (res.gone || []).length : 0, first: pr.first, last: pr.last };
  if (!full) return sum;
  return { ...sum, hosts,
    offAssets: offAssets.map((a) => ({ id: a.id, hostname: a.hostname, ip: a.lastIp || (a.ips || [])[0], department: a.department, assetTag: a.assetTag, lastSeen: a.lastSeen, state: inv.stateOf(a) })),
    offDevices: offDevs.map((d) => ({ id: d.id, name: d.name, ip: d.ip, type: d.type, status: getRt(d.id).status })),
    appearedIps: res ? res.appeared || [] : [], goneIps: res ? res.gone || [] : [] };
}
function ipscanView() {
  const D = ipscan.data;
  const ranges = D.ranges.map((r) => ({ ...r, summary: scanCompare(r, false) }));
  const tot = ranges.reduce((a, r) => { const s = r.summary || {}; ['total', 'alive', 'asset', 'device', 'unknown', 'assetsOffline'].forEach((k) => { a[k] = (a[k] || 0) + (s[k] || 0); }); return a; }, {});
  const st = inv.stats();
  return { settings: D.settings, ranges, job: ipscan.status(), totals: { ...tot, registered: st.inUse, agentOnline: st.online },
    history: D.history.slice(-400) };
}

async function handleInventory(req, res, url, p, m, user, auth) {
  const q = url.searchParams;
  if (p === '/api/inventory/report' && m === 'POST') {
    if (!['agent', 'operator', 'admin'].includes(user.role)) throw new HttpError(403, 'ต้องใช้ API Key ประเภท agent');
    const b = await readBody(req, 8e6);
    let r; try { r = inv.ingest(b, { ip: clientIp(req), by: auth.key ? `agent:${auth.key.name}` : user.username }); } catch (e) { throw bad(e.message); }
    if (r.isNew || r.changes.length) broadcast();
    return send(res, 200, { ok: true, assetId: r.asset.id, isNew: r.isNew, changes: r.changes.length, serverTime: Date.now(),
      config: { intervalMin: inv.settings.intervalMin, software: inv.settings.trackSoftware } });
  }
  if (!p.startsWith('/api/inventory') && !p.startsWith('/api/ipscan')) return undefined;
  if (p === '/api/inventory' && m === 'GET') {
    need(user, 'viewer');
    let L = inv.data.assets.map(inv.listView);
    const s = String(q.get('q') || '').toLowerCase().trim();
    if (s) L = L.filter((a) => [a.hostname, a.ip, a.mac, a.assetTag, a.department, a.location, a.owner, a.user, a.os && a.os.name, a.cpu && a.cpu.model, a.system && a.system.serial, a.system && a.system.model].some((v) => String(v || '').toLowerCase().includes(s)));
    if (q.get('state')) L = L.filter((a) => a.state === q.get('state'));
    if (q.get('dept')) L = L.filter((a) => (a.department || '') === q.get('dept'));
    return send(res, 200, { settings: inv.settings, stats: inv.stats(), total: L.length, assets: L,
      departments: [...new Set(inv.data.assets.map((a) => a.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'th')) });
  }
  if (p === '/api/inventory/changes' && m === 'GET') {
    need(user, 'viewer');
    try { return send(res, 200, inv.report(Object.fromEntries(q))); } catch (e) { throw bad(e.message); }
  }
  if (p === '/api/inventory/changes.csv' && m === 'GET') {
    need(user, 'viewer');
    let r; try { r = inv.report({ ...Object.fromEntries(q), limit: 5000 }); } catch (e) { throw bad(e.message); }
    return csvSend(res, 'inventory-changes.csv', ['เวลา', 'เครื่อง', 'หน่วยงาน', 'หมวด', 'รายการ', 'ค่าเดิม', 'ค่าใหม่', 'โดย'],
      r.rows.map((c) => [thDate(c.at), c.host, c.dept, inv.CATS[c.cat] || c.cat, c.label, c.old, c.new, c.by]));
  }
  if (p === '/api/inventory/export.csv' && m === 'GET') {
    need(user, 'viewer');
    return csvSend(res, 'computer-inventory.csv', ['เลขครุภัณฑ์', 'ชื่อเครื่อง', 'IP', 'MAC', 'หน่วยงาน', 'สถานที่', 'ผู้รับผิดชอบ', 'สถานะ', 'ระบบปฏิบัติการ', 'OS build', 'CPU', 'คอร์/เธรด', 'RAM (GB)',
      'ดิสก์', 'การ์ดจอ', 'ยี่ห้อ', 'รุ่น', 'Serial', 'ผู้ใช้ล่าสุด', 'รายงานล่าสุด', 'ที่มา'],
    inv.data.assets.map((a) => [a.assetTag, a.hostname, a.lastIp || (a.ips || [])[0] || '', (a.macs || [])[0] || '', a.department, a.location, a.owner, inv.stateOf(a),
      a.os && a.os.name, a.os && [a.os.release, a.os.build].filter(Boolean).join(' '), a.cpu && a.cpu.model, a.cpu ? `${a.cpu.cores || ''}/${a.cpu.threads || ''}` : '',
      a.ramMB ? Math.round(a.ramMB / 102.4) / 10 : '', (a.disks || []).map((d) => `${d.model} ${d.sizeGB || ''}GB ${d.type || ''}`.trim()).join(' + '),
      (a.gpus || []).map((g) => g.name).join(' + '), a.system && a.system.manufacturer, a.system && a.system.model, a.system && a.system.serial, a.user, thDate(a.lastSeen), a.source]));
  }
  if (p === '/api/inventory/software' && m === 'GET') {
    need(user, 'viewer');
    const s = String(q.get('q') || '').toLowerCase().trim();
    if (s.length < 2) throw bad('พิมพ์ชื่อโปรแกรมอย่างน้อย 2 ตัวอักษร');
    const out = [];
    for (const a of inv.data.assets) for (const x of a.software || []) if (x.name.toLowerCase().includes(s)) out.push({ assetId: a.id, hostname: a.hostname, department: a.department, name: x.name, version: x.version, publisher: x.publisher });
    return send(res, 200, { total: out.length, rows: out.slice(0, 2000) });
  }
  if (p === '/api/inventory/settings' && m === 'PUT') {
    need(user, 'admin');
    return send(res, 200, { settings: inv.setSettings(await readBody(req)) });
  }
  if (p === '/api/inventory/assets' && m === 'POST') {
    need(user, 'operator');
    try { return send(res, 201, { asset: inv.addManual(await readBody(req), user.username) }); } catch (e) { if (e.status) throw e; throw bad(e.message); }
  }
  let mk = p.match(/^\/api\/inventory\/assets\/(\d+)$/);
  if (mk) {
    const id = Number(mk[1]);
    if (m === 'GET') { need(user, 'viewer'); const r = inv.detail(id); if (!r) throw new HttpError(404, 'ไม่พบเครื่องในทะเบียน'); return send(res, 200, r); }
    if (m === 'PUT') { need(user, 'operator'); let a; try { a = inv.update(id, await readBody(req), user.username); } catch (e) { if (e.status) throw e; throw bad(e.message); } if (!a) throw new HttpError(404, 'ไม่พบเครื่องในทะเบียน'); return send(res, 200, { asset: inv.listView(a) }); }
    if (m === 'DELETE') { need(user, 'admin'); if (!inv.remove(id, user.username)) throw new HttpError(404, 'ไม่พบเครื่องในทะเบียน'); return send(res, 200, { ok: true }); }
  }

  // ----- สแกน IP
  if (p === '/api/ipscan' && m === 'GET') { need(user, 'viewer'); return send(res, 200, ipscanView()); }
  if (p === '/api/ipscan/status' && m === 'GET') { need(user, 'viewer'); return send(res, 200, ipscan.status()); }
  if (p === '/api/ipscan/preview' && m === 'POST') {
    need(user, 'operator');
    try { const r = ipscan.parseRange((await readBody(req)).spec); return send(res, 200, { ok: true, count: r.count, first: r.first, last: r.last, cidr: r.cidr || null }); }
    catch (e) { return send(res, 200, { ok: false, error: e.message }); }
  }
  if (p === '/api/ipscan/ranges' && m === 'POST') { need(user, 'admin'); try { return send(res, 201, { range: ipscan.addRange(await readBody(req)) }); } catch (e) { if (e.status) throw e; throw bad(e.message); } }
  if (p === '/api/ipscan/settings' && m === 'PUT') { need(user, 'admin'); try { return send(res, 200, { settings: ipscan.setSettings(await readBody(req)) }); } catch (e) { if (e.status) throw e; throw bad(e.message); } }
  if (p === '/api/ipscan/run' && m === 'POST') {
    need(user, 'operator');
    const b = await readBody(req);
    try { return send(res, 200, ipscan.run(Array.isArray(b.rangeIds) ? b.rangeIds.map(String) : null, user.username)); } catch (e) { throw bad(e.message); }
  }
  if (p === '/api/ipscan/cancel' && m === 'POST') { need(user, 'operator'); return send(res, 200, ipscan.cancel()); }
  mk = p.match(/^\/api\/ipscan\/ranges\/([a-f0-9]{10})(\/export\.csv)?$/);
  if (mk) {
    const r = ipscan.data.ranges.find((x) => x.id === mk[1]);
    if (!r) throw new HttpError(404, 'ไม่พบช่วง IP');
    if (mk[2] && m === 'GET') {
      need(user, 'viewer');
      const c = scanCompare(r, true);
      const TH = { asset: 'ทะเบียนคอมพิวเตอร์', device: 'อุปกรณ์เครือข่าย', both: 'ทะเบียนคอมพิวเตอร์ + อุปกรณ์เครือข่าย', unknown: 'ไม่อยู่ในทะเบียน' };
      const rows = c.hosts.map((h) => ['ใช้งาน', h.ip, h.name || '', h.mac || '', h.via, h.rtt, TH[h.cls], h.asset ? h.asset.hostname : (h.device ? h.device.name : ''), h.asset ? h.asset.department : '', h.asset ? h.asset.assetTag : ''])
        .concat(c.offAssets.map((a) => ['ไม่พบตอนสแกน', a.ip, '', '', '', '', 'ทะเบียนคอมพิวเตอร์', a.hostname, a.department, a.assetTag]))
        .concat(c.offDevices.map((d) => ['ไม่พบตอนสแกน', d.ip, '', '', '', '', 'อุปกรณ์เครือข่าย', d.name, '', '']));
      return csvSend(res, `ipscan-${r.name.replace(/[^\w.-]+/g, '_')}.csv`, ['สถานะ', 'IP', 'ชื่อ (DNS)', 'MAC', 'ตรวจพบด้วย', 'RTT (ms)', 'การจับคู่', 'ชื่อในทะเบียน', 'หน่วยงาน', 'เลขครุภัณฑ์'], rows);
    }
    if (m === 'GET') { need(user, 'viewer'); return send(res, 200, { range: r, compare: scanCompare(r, true), history: ipscan.data.history.filter((h) => h.rangeId === r.id).slice(-200) }); }
    if (m === 'PUT') { need(user, 'admin'); try { return send(res, 200, { range: ipscan.updateRange(r.id, await readBody(req)) }); } catch (e) { if (e.status) throw e; throw bad(e.message); } }
    if (m === 'DELETE') { need(user, 'admin'); ipscan.removeRange(r.id); return send(res, 200, { ok: true }); }
  }
  return undefined;
}

/* ---------- routes */
async function handleExtra(req, res, url, p, m, user, auth) {
  const q = url.searchParams;
  // ----- รายการอุปกรณ์ / แจ้งเตือน สำหรับระบบภายนอก
  if (p === '/api/devices' && m === 'GET') {
    let L = db.devices.map(devView);
    if (q.get('status')) L = L.filter((d) => d.status === q.get('status'));
    if (q.get('type')) L = L.filter((d) => d.type === q.get('type'));
    if (q.get('q')) { const s = q.get('q').toLowerCase(); L = L.filter((d) => [d.name, d.ip, d.location, d.code].some((v) => String(v || '').toLowerCase().includes(s))); }
    if (q.get('history') !== '1') L = L.map(({ history, ...d }) => d);
    return send(res, 200, { total: L.length, devices: L });
  }
  const invRes = await handleInventory(req, res, url, p, m, user, auth);
  if (invRes !== undefined) return invRes;
  if (p === '/api/alerts' && m === 'GET') {
    let L = [...db.alerts].reverse();
    const st = q.get('status');
    if (st === 'open') L = L.filter((a) => a.status !== 'resolved'); else if (st) L = L.filter((a) => a.status === st);
    if (q.get('severity')) L = L.filter((a) => a.severity === q.get('severity'));
    if (q.get('since')) L = L.filter((a) => a.created >= Number(q.get('since')));
    const total = L.length;
    return send(res, 200, { total, alerts: L.slice(0, Math.min(2000, Math.max(1, parseInt(q.get('limit'), 10) || 100))) });
  }

  // ----- API Key และการตั้งค่า API (admin ผ่านหน้าเว็บเท่านั้น)
  if (p === '/api/apikeys' && m === 'GET') {
    need(user, 'admin');
    const a = db.api;
    return send(res, 200, { settings: { enabled: a.enabled, cors: a.cors, defaultRate: a.defaultRate, trustProxy: a.trustProxy }, keys: a.keys.map(gateway.view), roles: gateway.ROLES });
  }
  if (p === '/api/apikeys' && m === 'POST') {
    need(user, 'admin');
    const b = await readBody(req);
    const name = str(b.name, 60);
    if (!name) throw bad('กรุณาตั้งชื่อ API Key (เช่น ชื่อระบบที่จะเชื่อมต่อ)');
    if (db.api.keys.length >= 100) throw bad('สร้าง API Key ได้สูงสุด 100 รายการ');
    const ips = String(b.ips || '').split(/[\s,]+/).filter(Boolean);
    const badIp = ips.find((x) => !gateway.validRule(x));
    if (badIp) throw bad(`รูปแบบ IP ไม่ถูกต้อง: ${badIp}`);
    if (!gateway.ROLES.includes(b.role)) throw bad('กรุณาเลือกสิทธิ์ของ API Key');
    const r = gateway.create({ name, role: b.role, ips, rate: b.rate, expiresDays: parseInt(b.expiresDays, 10) || 0, createdBy: user.username });
    return send(res, 201, { token: r.token, key: gateway.view(r.key) });
  }
  let mk = p.match(/^\/api\/apikeys\/([a-f0-9]{10})$/);
  if (mk) {
    need(user, 'admin');
    const k = db.api.keys.find((x) => x.id === mk[1]);
    if (!k) throw new HttpError(404, 'ไม่พบ API Key');
    if (m === 'DELETE') { db.api.keys = db.api.keys.filter((x) => x !== k); save(); return send(res, 200, { ok: true }); }
    if (m === 'PUT') {
      const b = await readBody(req);
      if (b.enabled !== undefined) k.enabled = !!b.enabled;
      if (b.name !== undefined) k.name = str(b.name, 60) || k.name;
      if (b.rate !== undefined) k.rate = Math.max(0, Math.min(10000, Number(b.rate) || 0));
      if (b.ips !== undefined) {
        const ips = String(b.ips || '').split(/[\s,]+/).filter(Boolean);
        const badIp = ips.find((x) => !gateway.validRule(x)); if (badIp) throw bad(`รูปแบบ IP ไม่ถูกต้อง: ${badIp}`);
        k.ips = ips;
      }
      save(); return send(res, 200, { key: gateway.view(k) });
    }
  }
  if (p === '/api/api-settings' && m === 'PUT') {
    need(user, 'admin');
    const b = await readBody(req);
    const cors = String(b.cors || '').split(/[\s,]+/).filter(Boolean);
    const badO = cors.find((o) => o !== '*' && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(o));
    if (badO) throw bad(`Origin ไม่ถูกต้อง: ${badO} (ตัวอย่าง https://dashboard.hospital.go.th)`);
    Object.assign(db.api, { enabled: !!b.enabled, cors, defaultRate: Math.max(10, Math.min(10000, parseInt(b.defaultRate, 10) || 120)), trustProxy: !!b.trustProxy });
    save();
    return send(res, 200, { ok: true });
  }

  // ----- สำรอง / กู้คืน
  if (p.startsWith('/api/backup')) {
    need(user, 'admin');
    if (p === '/api/backup/export' && m === 'POST') {
      const b = await readBody(req);
      let out = backupLib.build(bkSource(), { includeAlerts: !!b.includeAlerts, createdBy: user.username, app: APP_VERSION });
      if (b.passphrase) { if (String(b.passphrase).length < 8) throw bad('รหัสผ่านของไฟล์สำรองต้องมีอย่างน้อย 8 ตัวอักษร'); out = backupLib.encrypt(out, b.passphrase); }
      const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
      return send(res, 200, { filename: `smart-topology-backup-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${b.passphrase ? '-encrypted' : ''}.json`, backup: out, summary: backupLib.summarize(bkSource()) });
    }
    if (p === '/api/backup/inspect' && m === 'POST') {
      const b = await readBody(req, 50e6);
      try { const r = backupLib.parse(b.backup, b.passphrase); return send(res, 200, { meta: r.meta, summary: backupLib.summarize(r.data) }); }
      catch (e) { return send(res, 200, { error: e.message, needPass: !!e.needPass }); }
    }
    if (p === '/api/backup/restore' && m === 'POST') {
      const b = await readBody(req, 50e6);
      if (b.confirm !== true) throw bad('ต้องยืนยันการกู้คืน (confirm: true)');
      let parsed; try { parsed = backupLib.parse(b.backup, b.passphrase); } catch (e) { throw bad(e.message); }
      let r; try { r = applyRestore(parsed, user.username); } catch (e) { throw bad(e.message); }
      setCookie(req, res, '', 0);
      return send(res, 200, { ok: true, relogin: true, ...r });
    }
    if (p === '/api/backup/files' && m === 'GET') return send(res, 200, { settings: db.backup, files: backupFiles(), dir: BACKUP_DIR });
    if (p === '/api/backup/files' && m === 'POST') { const b = await readBody(req); return send(res, 201, { name: writeBackupFile('manual', { includeAlerts: !!b.includeAlerts, by: user.username }), files: backupFiles() }); }
    if (p === '/api/backup/settings' && m === 'PUT') {
      const b = await readBody(req);
      const t = String(b.time || '').match(/^(\d{1,2}):(\d{2})$/);
      if (b.autoEnabled && (!t || +t[1] > 23 || +t[2] > 59)) throw bad('เวลาสำรองอัตโนมัติไม่ถูกต้อง (เช่น 02:30)');
      Object.assign(db.backup, { autoEnabled: !!b.autoEnabled, time: t ? `${t[1].padStart(2, '0')}:${t[2]}` : db.backup.time,
        keep: Math.max(1, Math.min(365, parseInt(b.keep, 10) || 14)), includeAlerts: !!b.includeAlerts });
      save(); return send(res, 200, { settings: db.backup });
    }
    const mf = p.match(/^\/api\/backup\/files\/([A-Za-z0-9._-]+\.json)(\/restore)?$/);
    if (mf) {
      const file = path.join(BACKUP_DIR, mf[1]);
      if (!fs.existsSync(file)) throw new HttpError(404, 'ไม่พบไฟล์สำรอง');
      if (!mf[2] && m === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${mf[1]}"`, 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
      if (!mf[2] && m === 'DELETE') { fs.unlinkSync(file); return send(res, 200, { ok: true, files: backupFiles() }); }
      if (mf[2] && m === 'POST') {
        const b = await readBody(req);
        if (b.confirm !== true) throw bad('ต้องยืนยันการกู้คืน (confirm: true)');
        let parsed; try { parsed = backupLib.parse(fs.readFileSync(file, 'utf8'), b.passphrase); } catch (e) { throw bad(e.message); }
        let r; try { r = applyRestore(parsed, user.username); } catch (e) { throw bad(e.message); }
        setCookie(req, res, '', 0);
        return send(res, 200, { ok: true, relogin: true, ...r });
      }
    }
  }

  // ----- Wazuh
  if (p === '/api/integrations/wazuh' && m === 'POST') {
    if (!(user.role === 'integration' || user.role === 'admin')) throw new HttpError(403, 'ต้องใช้ API Key ประเภท integration หรือ admin');
    const b = await readBody(req, 10e6);
    const list = Array.isArray(b.alerts) ? b.alerts : Array.isArray(b) ? b : [b];
    const results = list.slice(0, 500).map(handleWazuhAlert);
    broadcast();
    return send(res, 200, { received: list.length, accepted: results.filter((r) => r.accepted).length, results: results.slice(0, 20) });
  }
  if (p === '/api/wazuh' && m === 'GET') {
    const v = wazuh.view();
    if (ROLE_RANK[user.role] >= ROLE_RANK.admin) v.config = { ...db.wazuh, password: maskSecret(db.wazuh.password) };
    return send(res, 200, v);
  }
  if (p === '/api/wazuh/config' && m === 'PUT') {
    need(user, 'admin');
    const b = await readBody(req), o = db.wazuh;
    const urlv = str(b.url, 300).replace(/\/+$/, '');
    if (urlv && !/^https?:\/\/[^\s/]+(:\d+)?$/.test(urlv)) throw bad('URL ของ Wazuh API ไม่ถูกต้อง (ตัวอย่าง https://172.16.1.30:55000)');
    const num = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
    db.wazuh = { ...o, enabled: !!b.enabled, url: urlv, user: str(b.user, 100), password: keepSecret(b.password, o.password), verifyTls: !!b.verifyTls,
      intervalMin: num(b.intervalMin, 1, 1440, o.intervalMin), scaMax: num(b.scaMax, 0, 200, o.scaMax),
      pushEnabled: !!b.pushEnabled, pushMinSeverity: ['info', 'warning', 'critical'].includes(b.pushMinSeverity) ? b.pushMinSeverity : 'warning',
      inboundEnabled: !!b.inboundEnabled, inboundMinLevel: num(b.inboundMinLevel, 0, 16, o.inboundMinLevel), inboundNotifyLevel: num(b.inboundNotifyLevel, 0, 16, o.inboundNotifyLevel),
      inboundAutoResolveMin: num(b.inboundAutoResolveMin, 1, 10080, o.inboundAutoResolveMin), agentAlerts: !!b.agentAlerts };
    if (db.wazuh.enabled && (!db.wazuh.url || !db.wazuh.user)) throw bad('กรุณาระบุ URL และชื่อผู้ใช้ของ Wazuh API');
    save(); wazuh.reset(); wazuh.schedule();
    if (db.wazuh.enabled) await wazuh.collect().catch(() => {});
    const v = wazuh.view(); v.config = { ...db.wazuh, password: maskSecret(db.wazuh.password) };
    return send(res, 200, v);
  }
  if (p === '/api/wazuh/test' && m === 'POST') {
    need(user, 'admin');
    const b = await readBody(req);
    const c = { url: str(b.url, 300).replace(/\/+$/, ''), user: str(b.user, 100), password: keepSecret(b.password, db.wazuh.password), verifyTls: !!b.verifyTls };
    if (!/^https?:\/\//.test(c.url) || !c.user) throw bad('กรุณาระบุ URL และชื่อผู้ใช้');
    try { return send(res, 200, { ok: true, ...(await wazuh.test(c)) }); }
    catch (e) { return send(res, 200, { ok: false, error: createWazuh.netError(e) }); }
  }
  if (p === '/api/wazuh/refresh' && m === 'POST') { need(user, 'operator'); await wazuh.collect(); return send(res, 200, wazuh.view()); }
  if (p === '/api/wazuh/push-test' && m === 'POST') {
    need(user, 'admin');
    if (!db.wazuh.url) throw bad('กรุณาตั้งค่า Wazuh API ก่อน');
    return send(res, 200, { result: await wazuh.pushTest(db.settings.siteName) });
  }
  if (p === '/api/wazuh/configuration' && m === 'GET') {
    need(user, 'admin');   // ค่า configuration อาจมีข้อมูลลับ (เช่น integration key)
    try { return send(res, 200, { section: q.get('section') || '', config: await wazuh.configSection(q.get('section') || '') }); }
    catch (e) { throw bad(e.status ? e.message : createWazuh.netError(e)); }
  }
  mk = p.match(/^\/api\/wazuh\/sca\/([A-Za-z0-9_-]{1,20})\/([A-Za-z0-9_.-]{1,100})$/);
  if (mk && m === 'GET') {
    try { return send(res, 200, { checks: await wazuh.scaChecks(mk[1], mk[2], ['passed', 'failed', 'not applicable'].includes(q.get('result')) ? q.get('result') : '') }); }
    catch (e) { throw bad(e.status ? e.message : createWazuh.netError(e)); }
  }
  return undefined;
}

async function handleApi(req, res, url) {
  let p = url.pathname;
  const m = req.method;
  if (p.startsWith('/api/v1/')) p = `/api/${p.slice(8)}`;          // /api/v1/... = เวอร์ชันสำหรับระบบภายนอก
  if (gateway.cors(req, res)) return;                               // CORS preflight
  if (p === '/api/health' && m === 'GET') {
    return send(res, 200, { status: 'ok', version: APP_VERSION, uptimeSec: Math.round((Date.now() - STARTED) / 1000), devices: db.devices.length,
      cycle, lastCycleAt, mysqlLog: mylog.active(), dbsync: dbsync.summary().code || null, wazuh: wazuh.summary().ok, time: new Date().toISOString() });
  }
  if (p === '/api/openapi.json' && m === 'GET') return send(res, 200, openapiSpec(APP_VERSION));
  if (m !== 'GET' && m !== 'HEAD') {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) throw bad('ต้องส่งข้อมูลแบบ application/json');
  }

  if (p === '/api/login' && m === 'POST') {
    const b = await readBody(req);
    const key = clientIp(req) + '|' + str(b.username).toLowerCase();
    const f = failures.get(key);
    if (f && f.until > Date.now()) throw new HttpError(429, `เข้าสู่ระบบผิดหลายครั้ง กรุณารอ ${Math.ceil((f.until - Date.now()) / 60000)} นาที`);
    const u = db.users.find((x) => x.username.toLowerCase() === str(b.username).toLowerCase());
    if (!u || !checkPw(b.password || '', u.pass)) {
      const n = (f && f.until <= Date.now() && f.count >= 5 ? 0 : (f ? f.count : 0)) + 1;
      failures.set(key, { count: n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
      throw new HttpError(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { uid: u.id, exp: Date.now() + (b.remember ? 7 * 24 * 3600 * 1000 : SESSION_TTL) });
    u.lastLogin = Date.now(); save();
    setCookie(req, res, token, b.remember ? 7 * 24 * 3600 : SESSION_TTL / 1000);
    return send(res, 200, { user: publicUser(u) });
  }

  let auth;
  try { auth = getUser(req); } catch (e) {
    if (e.rate) { res.setHeader('Retry-After', String(e.rate.reset)); }
    throw e;
  }
  if (!auth) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ');
  const user = auth.u;
  if (auth.rate) { res.setHeader('X-RateLimit-Limit', auth.rate.limit); res.setHeader('X-RateLimit-Remaining', auth.rate.remaining); res.setHeader('X-RateLimit-Reset', auth.rate.reset); }
  if (auth.key) {
    // API Key: จำกัดการเข้าถึงบางส่วนที่ต้องใช้การล็อกอินจริงเท่านั้น
    if (user.role === 'integration' && !['/api/integrations/wazuh', '/api/me'].includes(p)) throw new HttpError(403, 'API Key ประเภท integration ใช้ได้เฉพาะการรับข้อมูลจาก Wazuh');
    if (user.role === 'agent' && !['/api/inventory/report', '/api/me'].includes(p)) throw new HttpError(403, 'API Key ประเภท agent ใช้ได้เฉพาะการส่งรายงานสเปคเครื่อง');
    if (/^\/api\/(logout|me\/password|users|apikeys|api-settings|backup\/(restore|settings)|backup\/files\/[^/]+\/restore)/.test(p)) throw new HttpError(403, 'ส่วนนี้ต้องล็อกอินผ่านหน้าเว็บ (ไม่อนุญาตให้ใช้ API Key)');
  }
  const ext = await handleExtra(req, res, url, p, m, user, auth);
  if (ext !== undefined) return ext;

  if (p === '/api/logout' && m === 'POST') { sessions.delete(auth.token); setCookie(req, res, '', 0); return send(res, 200, { ok: true }); }
  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: auth.key ? { ...publicUser(user), apiKey: true, keyId: user.keyId } : publicUser(user) });
  if (p === '/api/me/password' && m === 'POST') {
    const b = await readBody(req);
    if (!checkPw(b.current || '', user.pass)) throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง');
    if (String(b.newPassword || '').length < 8) throw bad('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
    user.pass = hashPw(b.newPassword); user.mustChange = false; save();
    for (const [t, s] of sessions) if (s.uid === user.id && t !== auth.token) sessions.delete(t);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/state' && m === 'GET') return send(res, 200, stateView());
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write(`event: state\ndata: ${JSON.stringify(stateView())}\n\n`);
    const c = { res, uid: user.id };
    clients.add(c);
    req.on('close', () => clients.delete(c));
    return;
  }

  // ---------- devices
  if (p === '/api/devices' && m === 'POST') {
    need(user, 'operator');
    const d = validDevice(await readBody(req), null);
    d.id = ++db.seq.device; d.created = Date.now();
    if (!d.code) d.code = `DEV-${String(d.id).padStart(3, '0')}`;
    db.devices.push(d); save();
    checkDevice(d).then(broadcast);
    return send(res, 201, { device: devView(d) });
  }
  if (p === '/api/devices/bulk' && m === 'POST') {
    need(user, 'operator');
    const b = await readBody(req);
    const lines = String(b.text || '').split(/\r?\n/);
    const added = [], errors = [];
    lines.forEach((line, i) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      const c = parseCsvLine(line);
      if (i === 0 && /^name$/i.test(c[0])) return;
      try {
        const parentRef = c[7] || '';
        const parent = parentRef ? db.devices.find((x) => x.name === parentRef || x.ip === parentRef) : null;
        if (parentRef && !parent) throw bad(`ไม่พบ Uplink "${parentRef}"`);
        const port = c[8] ? parseInt(c[8], 10) : null;
        const d = validDevice({ name: c[0], ip: c[1], type: (c[2] || 'other').toLowerCase(), vendor: c[3], model: c[4], location: c[5],
          vlan: c[6], parentId: parent ? parent.id : null, method: port ? 'tcp' : 'icmp', port }, null);
        d.id = ++db.seq.device; d.created = Date.now(); d.code = `DEV-${String(d.id).padStart(3, '0')}`;
        db.devices.push(d); added.push(d);
      } catch (e) { errors.push({ line: i + 1, error: e.message }); }
    });
    save();
    pool(added, 32, checkDevice).then(broadcast);
    return send(res, 200, { added: added.length, errors });
  }
  if (p === '/api/devices/demo' && m === 'POST') {
    need(user, 'operator');
    const n = demoDevices(); save(); runCycle();
    return send(res, 200, { added: n });
  }
  if (p === '/api/devices/positions' && m === 'DELETE') {
    need(user, 'operator');
    db.devices.forEach((d) => { delete d.x; delete d.y; }); save(); broadcast();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/check-all' && m === 'POST') { need(user, 'operator'); await runCycle(); return send(res, 200, { ok: true, cycle }); }

  let mm = p.match(/^\/api\/devices\/(\d+)(?:\/(check|position))?$/);
  if (mm) {
    const d = db.devices.find((x) => x.id === +mm[1]);
    if (!d) throw new HttpError(404, 'ไม่พบอุปกรณ์');
    if (!mm[2] && m === 'GET') return send(res, 200, { device: devView(d) });
    if (!mm[2] && m === 'PUT') {
      need(user, 'operator');
      const nd = validDevice(await readBody(req), d);
      const methodChanged = nd.ip !== d.ip || nd.method !== d.method || nd.port !== d.port;
      Object.assign(d, nd, { updated: Date.now() });
      if (methodChanged) { const r = getRt(d.id); r.history = []; r.fails = 0; }
      save(); await checkDevice(d); broadcast();
      return send(res, 200, { device: devView(d) });
    }
    if (!mm[2] && m === 'DELETE') {
      need(user, 'operator');
      db.devices = db.devices.filter((x) => x.id !== d.id);
      db.devices.forEach((x) => { if (x.parentId === d.id) x.parentId = d.parentId || null; });
      resolveAlerts(d); rt.delete(d.id); save(); broadcast();
      return send(res, 200, { ok: true });
    }
    if (mm[2] === 'check' && m === 'POST') { need(user, 'viewer'); await checkDevice(d); broadcast(); flushNotify(); return send(res, 200, { device: devView(d) }); }
    if (mm[2] === 'position' && m === 'PUT') {
      need(user, 'operator');
      const b = await readBody(req);
      if (Number.isFinite(b.x) && Number.isFinite(b.y)) { d.x = Math.round(b.x); d.y = Math.round(b.y); save(); }
      return send(res, 200, { ok: true });
    }
  }

  if (p === '/api/export.csv' && m === 'GET') {
    const head = 'name,ip,type,vendor,model,location,vlan,uplink,tcp_port';
    const rows = db.devices.map((d) => {
      const par = db.devices.find((x) => x.id === d.parentId);
      return [d.name, d.ip, d.type, d.vendor, d.model, d.location, d.vlan, par ? par.name : '', d.method === 'tcp' ? d.port : ''].map(csvCell).join(',');
    });
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="devices.csv"' });
    return res.end('﻿' + [head, ...rows].join('\n'));
  }

  // ---------- alerts
  mm = p.match(/^\/api\/alerts\/(\d+)\/(ack|resolve)$/);
  if (mm && m === 'POST') {
    need(user, 'operator');
    const a = db.alerts.find((x) => x.id === +mm[1]);
    if (!a) throw new HttpError(404, 'ไม่พบการแจ้งเตือน');
    if (mm[2] === 'ack') { a.status = a.status === 'resolved' ? a.status : 'acknowledged'; a.ackBy = user.username; }
    else { a.status = 'resolved'; a.resolvedAt = Date.now(); a.ackBy = a.ackBy || user.username; pushAlertEvent(a, 'resolved'); }
    save(); broadcast(); return send(res, 200, { ok: true });
  }
  if (p === '/api/alerts/clear-resolved' && m === 'POST') {
    need(user, 'operator');
    db.alerts = db.alerts.filter((a) => a.status !== 'resolved'); save(); broadcast();
    return send(res, 200, { ok: true });
  }

  // ---------- settings
  if (p === '/api/settings' && m === 'PUT') {
    need(user, 'admin');
    const b = await readBody(req), s = db.settings;
    const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
    s.intervalSec = Math.round(num(b.intervalSec, 3, 3600, s.intervalSec));
    s.timeoutMs = Math.round(num(b.timeoutMs, 200, 10000, s.timeoutMs));
    s.warnMs = Math.round(num(b.warnMs, 1, 10000, s.warnMs));
    s.slaTarget = num(b.slaTarget, 50, 100, s.slaTarget);
    if (b.siteName != null) s.siteName = str(b.siteName, 100);
    save(); schedule(); broadcast();
    return send(res, 200, { settings: s });
  }

  // ---------- DB Master / Slave
  if (p === '/api/dbsync' && m === 'GET') return send(res, 200, dbsyncView(user));
  if (p === '/api/dbsync/config' && m === 'PUT') {
    need(user, 'admin');
    const b = await readBody(req), c = db.dbsync;
    const num = (v, lo, hi, def) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
    const nc = { ...c, enabled: !!b.enabled, notify: b.notify !== false,
      intervalSec: num(b.intervalSec, 10, 3600, c.intervalSec), tableIntervalMin: num(b.tableIntervalMin, 1, 1440, c.tableIntervalMin),
      lagWarn: num(b.lagWarn, 1, 86400, c.lagWarn), lagCrit: num(b.lagCrit, 1, 864000, c.lagCrit),
      reportEnabled: !!b.reportEnabled, reportOnlyDiff: !!b.reportOnlyDiff, reportTimes: parseTimes(b.reportTimes).join(', '),
      exactTables: String(b.exactTables || '').split(/[\s,]+/).filter((t) => /^[A-Za-z0-9_$]{1,64}$/.test(t)).slice(0, 50).join(', '),
      master: validDbSide(b.master, c.master, 'Master'), slave: validDbSide(b.slave, c.slave, 'Slave') };
    if (nc.lagCrit <= nc.lagWarn) throw bad('เกณฑ์วิกฤตต้องมากกว่าเกณฑ์เตือน');
    if (nc.reportEnabled && !nc.reportTimes) throw bad('กรุณาระบุเวลาส่งรายงาน เช่น 09:05, 12:10, 16:10');
    if (nc.enabled && (!nc.master.host || !nc.slave.host || !nc.master.user || !nc.slave.user)) throw bad('กรุณาระบุ Host และชื่อผู้ใช้ของทั้ง Master และ Slave');
    db.dbsync = nc; save();
    dbsync.reset(); dbsync.schedule();
    if (nc.enabled) await dbsync.check(true);
    broadcast();
    return send(res, 200, dbsyncView(user));
  }
  if (p === '/api/dbsync/test' && m === 'POST') {
    need(user, 'admin');
    const b = await readBody(req), side = b.side === 'slave' ? 'slave' : 'master';
    const c = validDbSide(b.config, db.dbsync[side], side === 'master' ? 'Master' : 'Slave');
    if (!c.host || !c.user) throw bad('กรุณาระบุ Host และชื่อผู้ใช้');
    try { return send(res, 200, { ok: true, ...(await dbsync.testSide(side, c)) }); }
    catch (e) { return send(res, 200, { ok: false, error: createMysqlLog.friendly(e) }); }
  }
  if (p === '/api/dbsync/report' && m === 'POST') {
    need(user, 'admin');
    const b = await readBody(req);
    return send(res, 200, await sendDbReport(b.dry ? 'preview' : 'manual'));
  }
  if (p === '/api/dbsync/run' && m === 'POST') { need(user, 'operator'); dbsync.resetPools(); await dbsync.check(true); return send(res, 200, dbsyncView(user)); }
  if (p === '/api/dbsync/tables' && m === 'POST') { need(user, 'operator'); await dbsync.compareAllTables(); return send(res, 200, dbsyncView(user)); }
  if (p === '/api/dbsync/history' && m === 'GET') {
    const hours = Math.min(24 * 31, Math.max(1, parseInt(url.searchParams.get('hours'), 10) || 24));
    let rows = null, source = 'memory';
    try { rows = await mylog.dbSyncHistory(hours); if (rows) source = 'mysql'; } catch (e) { console.warn('[dbsync] history', e.message); }
    if (!rows) {
      const from = Date.now() - hours * 3600000;
      rows = dbsync.history().filter((h) => h.t >= from).map((h) => ({ t: h.t, lag: h.lag, mMs: h.mMs, sMs: h.sMs, gap: h.gap, diffs: h.diffs, bad: h.code === 'sync' ? 0 : 1, n: 1 }));
    }
    return send(res, 200, { hours, source, rows });
  }
  if (p === '/api/dbsync/query-test' && m === 'POST') {
    need(user, 'admin');
    if (!dbsync.summary().configured) throw bad('กรุณาตั้งค่าการเชื่อมต่อ Master และ Slave ก่อน');
    const q = validQuery(await readBody(req), null);
    return send(res, 200, { result: await dbsync.testQuery(q) });
  }
  if (p === '/api/dbsync/queries' && m === 'POST') {
    need(user, 'admin');
    if (db.dbsync.queries.length >= 50) throw bad('เพิ่ม Query ได้สูงสุด 50 รายการ');
    const q = validQuery(await readBody(req), null);
    db.dbsync.queries.push(q); save(); dbsync.check(true).catch(() => {});
    return send(res, 201, { query: q });
  }
  {
    const mq = p.match(/^\/api\/dbsync\/queries\/([a-f0-9]{10})$/);
    if (mq) {
      need(user, 'admin');
      const i = db.dbsync.queries.findIndex((x) => x.id === mq[1]);
      if (i < 0) throw new HttpError(404, 'ไม่พบ Query');
      if (m === 'PUT') { db.dbsync.queries[i] = validQuery(await readBody(req), db.dbsync.queries[i]); save(); dbsync.check(true).catch(() => {}); return send(res, 200, { query: db.dbsync.queries[i] }); }
      if (m === 'DELETE') { db.dbsync.queries.splice(i, 1); save(); return send(res, 200, { ok: true }); }
    }
  }

  // ---------- MySQL log
  if (p === '/api/mysql' && m === 'GET') { need(user, 'admin'); return send(res, 200, await mysqlView()); }
  if (p === '/api/mysql' && m === 'PUT') {
    need(user, 'admin');
    db.mysql = validMysql(await readBody(req)); save(); mylog.reset();
    if (db.mysql.enabled) await mylog.flush().catch(() => {});
    return send(res, 200, await mysqlView());
  }
  if ((p === '/api/mysql/test' || p === '/api/mysql/init') && m === 'POST') {
    need(user, 'admin');
    const c = validMysql(await readBody(req), true);
    try {
      const r = p.endsWith('test') ? await mylog.test(c) : await mylog.init(c);
      return send(res, 200, { ok: true, ...r });
    } catch (e) { return send(res, 200, { ok: false, error: createMysqlLog.friendly(e) }); }
  }
  if (p === '/api/mysql/purge' && m === 'POST') { need(user, 'admin'); return send(res, 200, { result: await mylog.purge() }); }
  if (p === '/api/reports' && m === 'GET') {
    const q = url.searchParams;
    try {
      const r = await mylog.report({ mode: q.get('mode'), date: q.get('date'), deviceId: q.get('device') ? parseInt(q.get('device'), 10) : null,
        type: TYPES.includes(q.get('type')) ? q.get('type') : null });
      return send(res, 200, r);
    } catch (e) { console.error('[report]', e); return send(res, 200, { configured: true, connected: false, error: createMysqlLog.friendly(e) }); }
  }

  // ---------- external notification
  if (p === '/api/notify' && m === 'GET') { need(user, 'admin'); return send(res, 200, notifyView()); }
  if (p === '/api/notify' && m === 'PUT') {
    need(user, 'admin');
    const b = await readBody(req), N = db.notify;
    const chans = (Array.isArray(b.channels) ? b.channels : []).slice(0, 20).map((c) => validChannel(c, c.enabled !== false));
    const url = str(b.publicUrl, 300);
    if (url && !/^https?:\/\/[^\s]+$/i.test(url)) throw bad('ลิงก์ระบบ NOC ต้องขึ้นต้นด้วย http:// หรือ https://');
    Object.assign(N, { enabled: !!b.enabled, onDown: !!b.onDown, onRecover: !!b.onRecover, onWarning: !!b.onWarning,
      criticalOnly: !!b.criticalOnly, suppressChildren: !!b.suppressChildren,
      repeatMin: Math.min(1440, Math.max(0, parseInt(b.repeatMin, 10) || 0)), publicUrl: url, channels: chans });
    save();
    return send(res, 200, notifyView());
  }
  if (p === '/api/notify/test' && m === 'POST') {
    need(user, 'admin');
    const b = await readBody(req);
    const ch = validChannel(b.channel || {}, true);
    const sample = db.devices.find((d) => d.critical) || db.devices[0]
      || { name: 'อุปกรณ์ทดสอบ', ip: '10.0.0.1', method: 'icmp', location: 'ห้อง Server', id: 0 };
    const msg = buildMessage('test', [{ d: sample, e: { info: `ส่งโดย ${user.username} — หากเห็นข้อความนี้แสดงว่าตั้งค่าถูกต้อง` } }]);
    const r = await sendChannel(ch, msg);
    return send(res, 200, { result: r });
  }

  // ---------- users
  if (p === '/api/users' && m === 'GET') { need(user, 'admin'); return send(res, 200, { users: db.users.map(publicUser) }); }
  if (p === '/api/users' && m === 'POST') {
    need(user, 'admin');
    const b = await readBody(req);
    const username = str(b.username, 40);
    if (!/^[a-zA-Z0-9._-]{3,40}$/.test(username)) throw bad('ชื่อผู้ใช้ต้องเป็น a-z, 0-9, . _ - อย่างน้อย 3 ตัว');
    if (db.users.find((x) => x.username.toLowerCase() === username.toLowerCase())) throw bad('ชื่อผู้ใช้นี้มีอยู่แล้ว');
    if (String(b.password || '').length < 8) throw bad('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
    const u = { id: ++db.seq.user, username, name: str(b.name, 80) || username, role: ROLE_RANK[b.role] ? b.role : 'viewer',
      pass: hashPw(b.password), mustChange: !!b.mustChange, created: Date.now() };
    db.users.push(u); save();
    return send(res, 201, { user: publicUser(u) });
  }
  mm = p.match(/^\/api\/users\/(\d+)$/);
  if (mm) {
    need(user, 'admin');
    const u = db.users.find((x) => x.id === +mm[1]);
    if (!u) throw new HttpError(404, 'ไม่พบผู้ใช้');
    const admins = db.users.filter((x) => x.role === 'admin');
    if (m === 'DELETE') {
      if (u.id === user.id) throw bad('ไม่สามารถลบบัญชีของตนเองได้');
      if (u.role === 'admin' && admins.length <= 1) throw bad('ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
      db.users = db.users.filter((x) => x.id !== u.id);
      for (const [t, s] of sessions) if (s.uid === u.id) sessions.delete(t);
      save(); return send(res, 200, { ok: true });
    }
    if (m === 'PUT') {
      const b = await readBody(req);
      if (b.role && ROLE_RANK[b.role]) {
        if (u.role === 'admin' && b.role !== 'admin' && admins.length <= 1) throw bad('ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน');
        u.role = b.role;
      }
      if (b.name != null) u.name = str(b.name, 80) || u.username;
      if (b.password) {
        if (String(b.password).length < 8) throw bad('รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
        u.pass = hashPw(b.password); u.mustChange = true;
        for (const [t, s] of sessions) if (s.uid === u.id) sessions.delete(t);
      }
      save(); return send(res, 200, { user: publicUser(u) });
    }
  }
  throw new HttpError(404, 'ไม่พบ API');
}

const server = http.createServer(async (req, res) => {
  secHeaders(res);
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url.pathname);
    else { res.writeHead(405); res.end(); }
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.status ? e.message : 'เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์' });
  }
});

try { loadDB(); } catch (e) {
  if (e.code === 'EACCES' || e.code === 'EPERM') {
    console.error(`[error] ไม่มีสิทธิ์เขียนโฟลเดอร์ข้อมูล ${DATA_DIR}\n` +
      '  Docker: ใช้ named volume (เช่น -v nms-data:/data) หรือ chown 1000:1000 โฟลเดอร์ที่ mount');
    process.exit(1);
  }
  throw e;
}
inv.load(); ipscan.load();
if (process.env.SEED_DEMO === '1' && !db.devices.length) { demoDevices(); saveNow(); }
server.listen(PORT, HOST, () => {
  console.log(`SMART TOPOLOGY NOC พร้อมใช้งานที่ http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  runCycle(); schedule(); dbsync.schedule(); wazuh.schedule();
});
async function shutdown() {
  saveNow();
  try { inv.saveNow(); ipscan.saveNow(); } catch { /* ignore */ }
  await Promise.race([mylog.flush().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
