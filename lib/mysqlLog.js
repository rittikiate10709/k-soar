'use strict';
/**
 * SMART TOPOLOGY — MySQL log writer & report queries
 *
 *  - เก็บผลการตรวจทุกครั้ง (raw)        → nms_check_log
 *  - สรุปราย 5 นาที / รายชั่วโมง (สะสม)  → nms_stats_5min / nms_stats_hourly
 *  - เหตุการณ์เปลี่ยนสถานะ              → nms_event_log
 *  - ซิงก์ทะเบียนอุปกรณ์                → nms_device
 *
 * เขียนแบบ batch ทุก 15 วินาที ถ้า MySQL ล่มจะเก็บค้างไว้ในหน่วยความจำแล้วส่งใหม่เมื่อกลับมา
 */
const fs = require('fs');
const path = require('path');

let mysql = null;
try { mysql = require('mysql2/promise'); } catch { /* ยังไม่ได้ npm install */ }

const SCHEMA_FILE = path.join(__dirname, '..', 'sql', 'schema.sql');
const FLUSH_MS = 15000;
const RAW_CAP = 200000;      // จำนวนแถวค้างสูงสุดในหน่วยความจำเมื่อ MySQL ใช้งานไม่ได้
const BATCH = 2000;
const DB_RE = /^[A-Za-z0-9_]{1,64}$/;
const LOGGED = new Set(['online', 'warning', 'offline']);

const pad = (n) => String(n).padStart(2, '0');
const sqlDT = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const parseDT = (s) => new Date(String(s).replace(' ', 'T'));

function schemaStatements() {
  const txt = fs.readFileSync(SCHEMA_FILE, 'utf8')
    .split(/\r?\n/).filter((l) => !/^\s*--/.test(l)).join('\n');
  return txt.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter((s) => s && !/^(CREATE DATABASE|USE)\b/i.test(s));
}

module.exports = function createMysqlLog({ getConfig, getDevices, getIntervalSec, log = console }) {
  let pool = null, poolKey = '', connecting = false, nextTry = 0;
  const st = { connected: false, lastError: '', lastErrorAt: 0, lastFlushAt: 0, written: { raw: 0, stats: 0, events: 0 }, version: '', purgedAt: 0 };
  let raw = [], events = [], dbs = [], assets = [];
  let a5 = new Map(), aH = new Map();
  let devHash = '', lastPurgeDay = '';

  const cfg = () => getConfig() || {};
  const active = () => !!(mysql && cfg().enabled && cfg().host && cfg().user && cfg().database);

  /* ------------------------------------------------------------ connection */
  function poolOptions(c, withDb = true) {
    return {
      host: c.host, port: Number(c.port) || 3306, user: c.user, password: c.password || '',
      database: withDb ? c.database : undefined,
      waitForConnections: true, connectionLimit: 4, queueLimit: 0,
      connectTimeout: 6000, timezone: 'local', dateStrings: true, charset: 'utf8mb4',
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined,
      enableKeepAlive: true,
    };
  }
  function setError(e) {
    st.connected = false; st.lastError = friendly(e); st.lastErrorAt = Date.now();
  }
  async function getPool() {
    const c = cfg();
    const key = JSON.stringify([c.host, c.port, c.user, c.password, c.database, c.ssl]);
    if (pool && key === poolKey) return pool;
    if (pool) { pool.end().catch(() => {}); pool = null; }
    if (connecting || Date.now() < nextTry) return null;
    connecting = true;
    try {
      const p = mysql.createPool(poolOptions(c));
      const [[v]] = await p.query('SELECT VERSION() AS v');
      // สร้าง/อัปเดตโครงสร้างตาราง (CREATE ... IF NOT EXISTS ปลอดภัยต่อข้อมูลเดิม)
      try {
        for (const s of schemaStatements()) await p.query(s);
      } catch (e) {
        await p.query('SELECT 1 FROM nms_stats_hourly LIMIT 1');   // ถ้าไม่มีตารางหลักและสร้างไม่ได้ → แจ้ง error
        log.warn(`[mysql] อัปเดตโครงสร้างตารางไม่ได้ (${friendly(e)}) — ใช้ตารางเดิม`);
      }
      pool = p; poolKey = key; st.connected = true; st.version = v.v; st.lastError = '';
      devHash = '';
      log.log(`[mysql] เชื่อมต่อ ${c.host}:${c.port || 3306}/${c.database} สำเร็จ (${v.v})`);
      return pool;
    } catch (e) {
      setError(e); nextTry = Date.now() + 30000;
      log.warn(`[mysql] เชื่อมต่อไม่สำเร็จ: ${st.lastError} (ลองใหม่ใน 30 วินาที)`);
      return null;
    } finally { connecting = false; }
  }
  function reset() { if (pool) pool.end().catch(() => {}); pool = null; poolKey = ''; nextTry = 0; st.connected = false; }

  /* ------------------------------------------------------------ recording */
  function addAgg(map, key, id, bucket, x) {
    let a = map.get(key);
    if (!a) { a = { id, bucket, checks: 0, ok: 0, lost: 0, down: 0, warn: 0, downSec: 0, sum: 0, min: null, max: null }; map.set(key, a); }
    a.checks += x.checks; a.ok += x.ok; a.lost += x.lost; a.down += x.down; a.warn += x.warn; a.downSec += x.downSec; a.sum += x.sum;
    if (x.min != null) a.min = a.min == null ? x.min : Math.min(a.min, x.min);
    if (x.max != null) a.max = a.max == null ? x.max : Math.max(a.max, x.max);
  }
  /** เรียกทุกครั้งที่ตรวจอุปกรณ์ 1 ตัวเสร็จ */
  function recordCheck(d, ms, status, ts = Date.now()) {
    if (!active() || !LOGGED.has(status)) return;
    const c = cfg();
    if (c.rawLog !== false) {
      raw.push([d.id, new Date(ts), status, ms == null ? 0 : 1, ms == null ? null : Math.round(ms * 100) / 100]);
      if (raw.length > RAW_CAP) raw.splice(0, raw.length - RAW_CAP);
    }
    const ok = ms != null;
    const x = { checks: 1, ok: ok ? 1 : 0, lost: ok ? 0 : 1, down: status === 'offline' ? 1 : 0, warn: status === 'warning' ? 1 : 0,
      downSec: status === 'offline' ? getIntervalSec() : 0, sum: ok ? ms : 0, min: ok ? ms : null, max: ok ? ms : null };
    const b5 = new Date(ts - (ts % 300000));
    const bh = new Date(ts); bh.setMinutes(0, 0, 0);
    addAgg(a5, `${d.id}|${+b5}`, d.id, b5, x);
    addAgg(aH, `${d.id}|${+bh}`, d.id, bh, x);
  }
  /** ประวัติการเปลี่ยนแปลงทะเบียนคอมพิวเตอร์ (lib/inventory.js) */
  function recordAssetChanges(rows) {
    if (!active()) return;
    for (const c of rows) assets.push([c.id, new Date(c.at), c.assetId, String(c.host || '').slice(0, 100), String(c.dept || '').slice(0, 100), c.cat, String(c.field || '').slice(0, 40),
      String(c.label || '').slice(0, 100), String(c.old || '').slice(0, 1000), String(c.new || '').slice(0, 1000), String(c.by || '').slice(0, 100)]);
    if (assets.length > 20000) assets.splice(0, assets.length - 20000);
  }
  /** ผลการตรวจฐานข้อมูล Master/Slave 1 รอบ */
  function recordDbSync(x) {
    if (!active()) return;
    dbs.push([new Date(x.at), x.code, x.lag, x.mMs, x.sMs, x.gap, x.diffs || 0, x.detail || null]);
    if (dbs.length > 20000) dbs.splice(0, dbs.length - 20000);
  }
  async function dbSyncHistory(hours) {
    if (!active()) return null;
    const p = await getPool(); if (!p) return null;
    const fmt = hours <= 2 ? `DATE_FORMAT(checked_at, '%Y-%m-%d %H:%i:00')`
      : hours <= 48 ? `DATE_FORMAT(checked_at - INTERVAL (MINUTE(checked_at) % 5) MINUTE, '%Y-%m-%d %H:%i:00')`
        : `DATE_FORMAT(checked_at, '%Y-%m-%d %H:00:00')`;
    const [rows] = await p.query(`SELECT ${fmt} AS t, MAX(lag_sec) AS lag, AVG(master_ms) AS mMs, AVG(slave_ms) AS sMs, MAX(gap_bytes) AS gap,
      MAX(diff_count) AS diffs, SUM(status <> 'sync') AS bad, COUNT(*) AS n FROM nms_dbsync_log WHERE checked_at >= ? GROUP BY t ORDER BY t`,
    [new Date(Date.now() - hours * 3600000)]);
    return rows.map((r) => ({ t: +parseDT(r.t), lag: r.lag == null ? null : Number(r.lag), mMs: r.mMs == null ? null : Number(r.mMs),
      sMs: r.sMs == null ? null : Number(r.sMs), gap: r.gap == null ? null : Number(r.gap), diffs: Number(r.diffs) || 0, bad: Number(r.bad) || 0, n: Number(r.n) }));
  }
  /** เรียกเมื่อสถานะเปลี่ยน */
  function recordEvent(d, from, to, prevSince, latency, ts = Date.now()) {
    if (!active()) return;
    let ev;
    if (to === 'offline') ev = 'down';
    else if (from === 'offline' && (to === 'online' || to === 'warning')) ev = 'up';
    else if (to === 'warning') ev = 'slow';
    else if (from === 'warning' && to === 'online') ev = 'normal';
    else if (to === 'maintenance') ev = 'maintenance';
    else return;
    if (from === 'unknown' && ev !== 'down') return;      // ตอนเริ่มระบบ ไม่ต้องบันทึก
    const started = from === 'unknown' ? ts : (prevSince || ts);
    events.push([d.id, ev, from || null, to, new Date(started), new Date(ts),
      Math.max(0, Math.round((ts - started) / 1000)), latency == null ? null : latency]);
  }

  /* ------------------------------------------------------------ flushing */
  const AGG_SQL = (table) => `INSERT INTO ${table}
    (device_id, bucket, checks, ok_count, lost_count, down_count, warn_count, down_sec, sum_latency, min_latency, max_latency)
    VALUES ? ON DUPLICATE KEY UPDATE
      checks = checks + VALUES(checks), ok_count = ok_count + VALUES(ok_count), lost_count = lost_count + VALUES(lost_count),
      down_count = down_count + VALUES(down_count), warn_count = warn_count + VALUES(warn_count), down_sec = down_sec + VALUES(down_sec),
      sum_latency = sum_latency + VALUES(sum_latency),
      min_latency = LEAST(COALESCE(min_latency, VALUES(min_latency)), COALESCE(VALUES(min_latency), min_latency)),
      max_latency = GREATEST(COALESCE(max_latency, VALUES(max_latency)), COALESCE(VALUES(max_latency), max_latency))`;
  const aggRow = (a) => [a.id, a.bucket, a.checks, a.ok, a.lost, a.down, a.warn, a.downSec, a.sum,
    a.min == null ? null : Math.round(a.min * 100) / 100, a.max == null ? null : Math.round(a.max * 100) / 100];

  async function syncDevices(p) {
    const D = getDevices();
    const rows = D.map((d) => [d.id, d.code || null, d.name, d.ip, d.method || 'icmp', d.method === 'tcp' ? d.port : null, d.type || null,
      d.vendor || null, d.model || null, d.location || null, d.vlan || null, d.parentId || null, d.critical ? 1 : 0]);
    const h = JSON.stringify(rows);
    if (h === devHash) return;
    const now = new Date();
    if (rows.length) {
      await p.query(`INSERT INTO nms_device (device_id, code, name, ip, method, port, type, vendor, model, location, vlan, parent_id, is_critical, is_deleted, updated_at)
        VALUES ? ON DUPLICATE KEY UPDATE code=VALUES(code), name=VALUES(name), ip=VALUES(ip), method=VALUES(method), port=VALUES(port), type=VALUES(type),
        vendor=VALUES(vendor), model=VALUES(model), location=VALUES(location), vlan=VALUES(vlan), parent_id=VALUES(parent_id),
        is_critical=VALUES(is_critical), is_deleted=0, updated_at=VALUES(updated_at)`, [rows.map((r) => [...r, 0, now])]);
      await p.query('UPDATE nms_device SET is_deleted = 1, updated_at = ? WHERE is_deleted = 0 AND device_id NOT IN (?)', [now, D.map((d) => d.id)]);
    } else {
      await p.query('UPDATE nms_device SET is_deleted = 1 WHERE is_deleted = 0');
    }
    devHash = h;
  }
  let flushing = false;
  async function flush() {
    if (flushing || !active()) return;
    flushing = true;
    const p = await getPool();
    if (!p) { flushing = false; return; }
    // นำข้อมูลออกจากคิว (ถ้าเขียนไม่สำเร็จจะคืนกลับ)
    const R = raw; raw = [];
    const E = events; events = [];
    const DB = dbs; dbs = [];
    const AS = assets; assets = [];
    const M5 = a5, MH = aH; a5 = new Map(); aH = new Map();
    let stage = 'devices';
    try {
      await syncDevices(p);
      stage = 'stats';
      const s5 = [...M5.values()].map(aggRow), sh = [...MH.values()].map(aggRow);
      for (let i = 0; i < s5.length; i += BATCH) await p.query(AGG_SQL('nms_stats_5min'), [s5.slice(i, i + BATCH)]);
      M5.clear();
      for (let i = 0; i < sh.length; i += BATCH) await p.query(AGG_SQL('nms_stats_hourly'), [sh.slice(i, i + BATCH)]);
      MH.clear();
      st.written.stats += s5.length + sh.length;
      stage = 'events';
      if (E.length) {
        await p.query('INSERT INTO nms_event_log (device_id, event, from_status, to_status, started_at, event_at, duration_sec, latency_ms) VALUES ?', [E]);
        st.written.events += E.length; E.length = 0;
      }
      if (DB.length) {
        stage = 'dbsync';
        await p.query('INSERT INTO nms_dbsync_log (checked_at, status, lag_sec, master_ms, slave_ms, gap_bytes, diff_count, detail) VALUES ?', [DB]);
        DB.length = 0;
      }
      if (AS.length) {
        stage = 'asset_change';
        await p.query('INSERT IGNORE INTO nms_asset_change (id, changed_at, asset_id, hostname, department, category, field, label, old_value, new_value, changed_by) VALUES ?', [AS]);
        AS.length = 0;
      }
      stage = 'raw';
      while (R.length) {
        const chunk = R.slice(0, BATCH);
        await p.query('INSERT INTO nms_check_log (device_id, checked_at, status, success, latency_ms) VALUES ?', [chunk]);
        R.splice(0, chunk.length); st.written.raw += chunk.length;
      }
      st.connected = true; st.lastFlushAt = Date.now();
    } catch (e) {
      setError(e);
      log.warn(`[mysql] บันทึกไม่สำเร็จ (${stage}): ${st.lastError}`);
      if (/ECONNREFUSED|PROTOCOL_CONNECTION_LOST|ETIMEDOUT|ENOTFOUND|ER_ACCESS_DENIED|EHOSTUNREACH|ECONNRESET/.test(e.code || '')) reset();
      // คืนข้อมูลที่ยังไม่ได้เขียนกลับเข้าคิว (สถิติจะรวมกับข้อมูลใหม่ได้ ไม่ซ้ำ)
      for (const a of M5.values()) addAgg(a5, `${a.id}|${+a.bucket}`, a.id, a.bucket, a);
      for (const a of MH.values()) addAgg(aH, `${a.id}|${+a.bucket}`, a.id, a.bucket, a);
      events = E.concat(events);
      dbs = DB.concat(dbs);
      assets = AS.concat(assets);
      raw = R.concat(raw);
      if (raw.length > RAW_CAP) raw.splice(0, raw.length - RAW_CAP);
    } finally { flushing = false; }
    purgeIfDue().catch((e) => log.warn('[mysql] purge:', friendly(e)));
  }

  /* ------------------------------------------------------------ retention */
  async function purgeTable(p, table, col, days) {
    if (!(days > 0)) return 0;
    const cut = new Date(Date.now() - days * 86400000);
    let total = 0;
    for (;;) {
      const [r] = await p.query(`DELETE FROM ${table} WHERE ${col} < ? LIMIT 20000`, [cut]);
      total += r.affectedRows;
      if (r.affectedRows < 20000) break;
      await new Promise((res) => setTimeout(res, 200));
    }
    return total;
  }
  async function purgeIfDue(force = false) {
    const now = new Date();
    const day = sqlDT(now).slice(0, 10);
    if (!force && (day === lastPurgeDay || now.getHours() < 2)) return null;   // ทำวันละครั้ง หลังตี 2
    const p = pool; if (!p) return null;
    lastPurgeDay = day;
    const c = cfg();
    const res = {
      raw: await purgeTable(p, 'nms_check_log', 'checked_at', Number(c.rawDays)),
      stats5: await purgeTable(p, 'nms_stats_5min', 'bucket', Number(c.statDays)),
      hourly: await purgeTable(p, 'nms_stats_hourly', 'bucket', Number(c.hourDays)),
      events: await purgeTable(p, 'nms_event_log', 'event_at', Number(c.hourDays)),
      dbsync: await purgeTable(p, 'nms_dbsync_log', 'checked_at', Number(c.statDays)),
    };
    st.purgedAt = Date.now();
    if (res.raw + res.stats5 + res.hourly + res.events) log.log('[mysql] ลบข้อมูลเก่าตามรอบเก็บรักษา', res);
    return res;
  }

  /* ------------------------------------------------------------ admin helpers */
  async function withConn(c, withDb, fn) {
    if (!mysql) throw new Error('ยังไม่ได้ติดตั้งไลบรารี mysql2 — สั่ง npm install ในโฟลเดอร์โปรแกรม');
    const conn = await mysql.createConnection(poolOptions(c, withDb));
    try { return await fn(conn); } finally { conn.end().catch(() => {}); }
  }
  async function test(c) {
    return withConn(c, false, async (conn) => {
      const [[v]] = await conn.query('SELECT VERSION() AS v, CURRENT_USER() AS u');
      const [dbs] = await conn.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [c.database]);
      let tables = [];
      if (dbs.length) {
        const [t] = await conn.query('SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [c.database]);
        tables = t.map((x) => x.t);
      }
      const need = ['nms_device', 'nms_check_log', 'nms_stats_5min', 'nms_stats_hourly', 'nms_event_log'];
      return { version: v.v, user: v.u, dbExists: dbs.length > 0, tables, missing: need.filter((x) => !tables.includes(x)) };
    });
  }
  async function init(c) {
    if (!DB_RE.test(c.database || '')) throw new Error('ชื่อฐานข้อมูลใช้ได้เฉพาะ a-z, 0-9 และ _ (ไม่เกิน 64 ตัว)');
    const steps = [];
    await withConn(c, false, async (conn) => {
      try {
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${c.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        steps.push(`ฐานข้อมูล ${c.database} พร้อมใช้งาน`);
      } catch (e) {
        if (!/ER_DBACCESS_DENIED|ER_ACCESS_DENIED/.test(e.code || '')) throw e;
        steps.push(`ไม่มีสิทธิ์ CREATE DATABASE — ใช้ฐานข้อมูล ${c.database} ที่มีอยู่`);
      }
      await conn.query(`USE \`${c.database}\``);
      for (const s of schemaStatements()) {
        await conn.query(s);
        const m = s.match(/(?:TABLE IF NOT EXISTS|VIEW)\s+(\w+)/i);
        if (m) steps.push(`${/VIEW/i.test(s.slice(0, 30)) ? 'View' : 'ตาราง'} ${m[1]} ✓`);
      }
    });
    reset();
    return { steps };
  }
  async function tableSizes() {
    const p = pool; if (!p) return [];
    const conn = await p.getConnection();
    try {
      // MySQL 8 แคชสถิติไว้ 24 ชม. — ขอค่าล่าสุด (MariaDB ไม่มีตัวแปรนี้ ข้ามได้)
      await conn.query('SET SESSION information_schema_stats_expiry = 0').catch(() => {});
      const [rows] = await conn.query(`SELECT TABLE_NAME AS name, TABLE_ROWS AS row_est, DATA_LENGTH + INDEX_LENGTH AS bytes
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME LIKE 'nms\\_%' ORDER BY TABLE_NAME`);
      return rows.map((r) => ({ name: r.name, rows: Number(r.row_est) || 0, bytes: Number(r.bytes) || 0 }));
    } finally { conn.release(); }
  }
  async function status() {
    let sizes = [];
    try { sizes = await tableSizes(); } catch { /* ignore */ }
    return { driver: !!mysql, active: active(), ...st, queue: { raw: raw.length, events: events.length, stats: a5.size + aH.size }, sizes };
  }

  /* ------------------------------------------------------------ reports */
  function rangeOf(mode, val) {
    const now = new Date();
    let y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
    const mt = String(val || '').match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$/);
    if (mt) { y = +mt[1]; if (mt[2]) m = +mt[2]; if (mt[3]) d = +mt[3]; }
    let s, e, ps, pe, slots, label, prevLabel;
    const TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
    const be = (yy) => yy + 543;
    if (mode === 'day') {
      s = new Date(y, m - 1, d); e = new Date(y, m - 1, d + 1); ps = new Date(y, m - 1, d - 1); pe = s;
      slots = Array.from({ length: 288 }, (_, i) => `${pad(Math.floor(i / 12))}:${pad((i % 12) * 5)}`);
      label = `${s.getDate()} ${TH_M[s.getMonth()]} ${be(s.getFullYear())}`;
      prevLabel = `${ps.getDate()} ${TH_M[ps.getMonth()]} ${be(ps.getFullYear())}`;
    } else if (mode === 'year') {
      s = new Date(y, 0, 1); e = new Date(y + 1, 0, 1); ps = new Date(y - 1, 0, 1); pe = s;
      slots = TH_M.slice();
      label = `ปี ${be(y)}`; prevLabel = `ปี ${be(y - 1)}`;
    } else {
      mode = 'month';
      s = new Date(y, m - 1, 1); e = new Date(y, m, 1); ps = new Date(y, m - 2, 1); pe = s;
      const n = new Date(y, m, 0).getDate();
      slots = Array.from({ length: n }, (_, i) => String(i + 1));
      label = `${TH_M[m - 1]} ${be(y)}`; prevLabel = `${TH_M[ps.getMonth()]} ${be(ps.getFullYear())}`;
    }
    return { mode, s, e, ps, pe, slots, label, prevLabel };
  }
  // ตำแหน่งช่อง (slot) ของเวลา
  function slotOf(mode, start, t) {
    if (mode === 'day') return Math.floor((t - start) / 300000);
    if (mode === 'year') return t.getMonth();
    return t.getDate() - 1;
  }
  const num = (v) => Number(v) || 0;
  function summarize(r) {
    const checks = num(r.checks), ok = num(r.ok);
    return {
      checks, ok, lost: num(r.lost), down: num(r.down), warn: num(r.warn), downSec: num(r.down_sec),
      lossPct: checks ? (100 * num(r.lost)) / checks : null,
      availPct: checks ? (100 * (checks - num(r.down))) / checks : null,
      avgLatency: ok ? num(r.sum_lat) / ok : null,
      maxLatency: r.max_lat == null ? null : num(r.max_lat),
      devices: num(r.devices),
    };
  }
  const sums = (t = '') => `SUM(${t}checks) AS checks, SUM(${t}ok_count) AS ok, SUM(${t}lost_count) AS lost, SUM(${t}down_count) AS down,
    SUM(${t}warn_count) AS warn, SUM(${t}down_sec) AS down_sec, SUM(${t}sum_latency) AS sum_lat, MAX(${t}max_latency) AS max_lat`;
  const SUMS = sums();

  async function report({ mode, date, deviceId, type }) {
    if (!active()) return { configured: false };
    const p = await getPool();
    if (!p) return { configured: true, connected: false, error: st.lastError };
    const R = rangeOf(mode, date);
    // ตัวกรองอุปกรณ์
    // wf(col) = เงื่อนไขกรองอุปกรณ์ โดยระบุชื่อคอลัมน์ device_id ของตารางหลัก
    let wf = () => '', wp = [];
    if (deviceId) { wf = (col) => ` AND ${col} = ?`; wp = [Number(deviceId)]; }
    else if (type) { wf = (col) => ` AND ${col} IN (SELECT nd.device_id FROM nms_device nd WHERE nd.type = ?)`; wp = [type]; }
    const where = wf('device_id');
    const rng = (a, b) => [a, b, ...wp];
    const seriesTable = R.mode === 'day' ? 'nms_stats_5min' : 'nms_stats_hourly';

    const kpiQ = (a, b) => p.query(`SELECT ${SUMS}, COUNT(DISTINCT device_id) AS devices FROM nms_stats_hourly WHERE bucket >= ? AND bucket < ?${where}`, rng(a, b));
    const downQ = (a, b) => p.query(`SELECT event_at FROM nms_event_log WHERE event = 'down' AND event_at >= ? AND event_at < ?${where} LIMIT 100000`, rng(a, b));
    const serQ = (a, b) => p.query(`SELECT bucket, ${SUMS} FROM ${seriesTable} WHERE bucket >= ? AND bucket < ?${where} GROUP BY bucket`, rng(a, b));

    const rowKey = R.mode === 'day' ? 'device_id' : R.mode === 'year' ? 'MONTH(bucket)' : 'DAY(bucket)';
    const [[[k1]], [[k0]], [d1], [d0], [s1], [s0], [hm], [wk], [top], [topEv], [inc]] = await Promise.all([
      kpiQ(R.s, R.e), kpiQ(R.ps, R.pe), downQ(R.s, R.e), downQ(R.ps, R.pe), serQ(R.s, R.e), serQ(R.ps, R.pe),
      p.query(`SELECT ${rowKey} AS r, HOUR(bucket) AS h, SUM(checks) AS checks, SUM(lost_count) AS lost, SUM(down_count) AS down
        FROM nms_stats_hourly WHERE bucket >= ? AND bucket < ?${where} GROUP BY r, h`, rng(R.s, R.e)),
      p.query(`SELECT WEEKDAY(bucket) AS w, HOUR(bucket) AS h, SUM(checks) AS checks, SUM(lost_count) AS lost, SUM(down_count) AS down
        FROM nms_stats_hourly WHERE bucket >= ? AND bucket < ?${where} GROUP BY w, h`, rng(R.s, R.e)),
      p.query(`SELECT s.device_id, d.name, d.ip, d.type, d.location, d.is_deleted, ${sums('s.')}
        FROM nms_stats_hourly s LEFT JOIN nms_device d ON d.device_id = s.device_id
        WHERE s.bucket >= ? AND s.bucket < ?${wf('s.device_id')}
        GROUP BY s.device_id, d.name, d.ip, d.type, d.location, d.is_deleted
        ORDER BY SUM(s.lost_count) DESC, SUM(s.down_sec) DESC, MAX(s.max_latency) DESC LIMIT 20`, rng(R.s, R.e)),
      p.query(`SELECT device_id, COUNT(*) AS n FROM nms_event_log WHERE event = 'down' AND event_at >= ? AND event_at < ?${where} GROUP BY device_id`, rng(R.s, R.e)),
      p.query(`SELECT e.id, e.device_id, e.event, e.started_at, e.event_at, e.duration_sec, d.name, d.ip, d.location,
          (e.event = 'down' AND NOT EXISTS (SELECT 1 FROM nms_event_log u WHERE u.device_id = e.device_id AND u.event = 'up' AND u.event_at > e.event_at)) AS ongoing
        FROM nms_event_log e LEFT JOIN nms_device d ON d.device_id = e.device_id
        WHERE e.event IN ('up', 'down') AND e.event_at >= ? AND e.event_at < ?${wf('e.device_id')}
        ORDER BY e.event_at DESC LIMIT 400`, rng(R.s, R.e)),
    ]);

    // ---- series
    const blank = () => R.slots.map(() => ({ checks: 0, ok: 0, lost: 0, down: 0, warn: 0, down_sec: 0, sum_lat: 0, max_lat: null, events: 0 }));
    const fill = (rows, start, evRows) => {
      const out = blank();
      for (const r of rows) {
        const i = slotOf(R.mode, start, parseDT(r.bucket));
        const o = out[i]; if (!o) continue;
        o.checks += num(r.checks); o.ok += num(r.ok); o.lost += num(r.lost); o.down += num(r.down); o.warn += num(r.warn);
        o.down_sec += num(r.down_sec); o.sum_lat += num(r.sum_lat);
        if (r.max_lat != null) o.max_lat = Math.max(o.max_lat || 0, num(r.max_lat));
      }
      for (const ev of evRows) { const i = slotOf(R.mode, start, parseDT(ev.event_at)); if (out[i]) out[i].events++; }
      return out.map((o) => ({ ...summarize(o), events: o.events }));
    };
    const cur = fill(s1, R.s, d1), prev = fill(s0, R.ps, d0);

    // ---- heatmap (แถว × ชั่วโมง)
    const heat = new Map();
    for (const r of hm) {
      const k = String(r.r);
      if (!heat.has(k)) heat.set(k, { key: k, cells: Array.from({ length: 24 }, () => ({ checks: 0, lost: 0, down: 0 })), lost: 0, checks: 0 });
      const h = heat.get(k), c = h.cells[num(r.h)];
      c.checks += num(r.checks); c.lost += num(r.lost); c.down += num(r.down); h.lost += num(r.lost); h.checks += num(r.checks);
    }
    let heatRows = [...heat.values()];
    if (R.mode === 'day') {
      const names = new Map(top.map((t) => [String(t.device_id), t.name || `#${t.device_id}`]));
      heatRows = heatRows.filter((h) => h.lost > 0).sort((a, b) => b.lost - a.lost).slice(0, 15)
        .map((h) => ({ ...h, label: names.get(h.key) || (getDevices().find((d) => String(d.id) === h.key) || {}).name || `#${h.key}` }));
    } else {
      heatRows.sort((a, b) => Number(a.key) - Number(b.key));
      heatRows = heatRows.map((h) => ({ ...h, label: R.mode === 'year' ? R.slots[Number(h.key) - 1] : h.key }));
    }
    const week = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => ({ checks: 0, lost: 0, down: 0 })));
    for (const r of wk) { const c = week[num(r.w)][num(r.h)]; c.checks += num(r.checks); c.lost += num(r.lost); c.down += num(r.down); }

    // ---- top devices
    const evCount = new Map(topEv.map((x) => [x.device_id, num(x.n)]));
    const topDevices = top.map((t) => ({ id: t.device_id, name: t.name || `อุปกรณ์ #${t.device_id}`, ip: t.ip, type: t.type, location: t.location,
      deleted: !!t.is_deleted, ...summarize(t), events: evCount.get(t.device_id) || 0 }));

    // ---- incidents (ล่ม → กลับมา)
    const incidents = inc.filter((x) => x.event === 'up' || Number(x.ongoing)).map((x) => ({
      deviceId: x.device_id, name: x.name || `#${x.device_id}`, ip: x.ip, location: x.location,
      start: x.event === 'up' ? x.started_at : x.event_at, end: x.event === 'up' ? x.event_at : null,
      durationSec: x.event === 'up' ? num(x.duration_sec) : Math.round((Date.now() - parseDT(x.event_at)) / 1000), ongoing: x.event !== 'up' }));

    const kc = summarize(k1), kp = summarize(k0);
    kc.events = d1.length; kp.events = d0.length;
    return {
      configured: true, connected: true, mode: R.mode, label: R.label, prevLabel: R.prevLabel,
      start: sqlDT(R.s), end: sqlDT(R.e), slots: R.slots, current: cur, previous: prev,
      kpi: { current: kc, previous: kp }, heat: heatRows, week, topDevices, incidents,
    };
  }

  const timer = setInterval(() => flush().catch((e) => log.warn('[mysql]', e.message)), FLUSH_MS);
  timer.unref();

  return { recordCheck, recordEvent, recordDbSync, recordAssetChanges, dbSyncHistory, active, flush, test, init, status, report, reset, purge: () => purgeIfDue(true), hasDriver: () => !!mysql };
};

function friendly(e) {
  const c = e && e.code;
  const M = {
    ECONNREFUSED: 'เชื่อมต่อไม่ได้ (ECONNREFUSED) — ตรวจ IP/พอร์ต และว่า MySQL เปิดรับการเชื่อมต่อจากเครือข่าย (bind-address)',
    ETIMEDOUT: 'หมดเวลาเชื่อมต่อ — ตรวจ Firewall ระหว่างเครื่อง (พอร์ต 3306)',
    ENOTFOUND: 'ไม่พบชื่อเครื่อง (Host) นี้',
    EHOSTUNREACH: 'ไม่สามารถติดต่อเครื่องปลายทางได้',
    ER_ACCESS_DENIED_ERROR: 'ชื่อผู้ใช้หรือรหัสผ่าน MySQL ไม่ถูกต้อง หรือผู้ใช้ไม่ได้รับอนุญาตจาก IP นี้',
    ER_BAD_DB_ERROR: 'ไม่พบฐานข้อมูล — กด “สร้างฐานข้อมูลและตาราง”',
    ER_NO_SUCH_TABLE: 'ยังไม่มีตาราง — กด “สร้างฐานข้อมูลและตาราง”',
    ER_DBACCESS_DENIED_ERROR: 'ผู้ใช้นี้ไม่มีสิทธิ์ใช้ฐานข้อมูลนี้ (GRANT)',
    ER_TABLEACCESS_DENIED_ERROR: 'ผู้ใช้นี้ไม่มีสิทธิ์กับตาราง (GRANT SELECT, INSERT, UPDATE, DELETE)',
    HANDSHAKE_SSL_ERROR: 'การเชื่อมต่อ SSL ล้มเหลว — ลองปิดตัวเลือก SSL',
  };
  return (M[c] || '') + (M[c] ? '' : `${c ? c + ': ' : ''}${(e && e.message) || e}`);
}
module.exports.friendly = friendly;
