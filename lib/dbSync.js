'use strict';
/**
 * SMART TOPOLOGY — เฝ้าระวังฐานข้อมูล Master / Slave (เช่น HOSxP)
 *
 *  - ตรวจการเชื่อมต่อ, เวอร์ชัน, uptime, threads, QPS ของทั้งสองเครื่อง
 *  - สถานะ Replication (IO/SQL thread, Seconds_Behind_Master, binlog position, error)
 *    รองรับทั้ง MySQL 8.4 (SHOW REPLICA STATUS / SHOW BINARY LOG STATUS) และ MySQL 5.7/8.0, MariaDB
 *  - Custom Query ที่ผู้ดูแลกำหนด: รันทั้งสองฝั่งแล้วเปรียบเทียบผล (ค่าเดียว / ตาราง)
 *    บังคับเป็นคำสั่งอ่านอย่างเดียว + ทำใน READ ONLY transaction + จำกัดเวลา
 *  - เปรียบเทียบรายการตารางและจำนวนแถว
 */
let mysql = null;
try { mysql = require('mysql2/promise'); } catch { /* ยังไม่ได้ npm install */ }
const { friendly: baseFriendly } = require('./mysqlLog');
/** ข้อความ error สำหรับ Query ของผู้ใช้ */
function friendly(e) {
  const M = {
    ER_NO_SUCH_TABLE: 'ไม่พบตารางนี้ในฐานข้อมูล', ER_BAD_FIELD_ERROR: 'ไม่พบคอลัมน์', ER_BAD_DB_ERROR: 'ไม่พบฐานข้อมูล',
    ER_PARSE_ERROR: 'คำสั่ง SQL ไม่ถูกต้อง', ER_QUERY_TIMEOUT: 'Query ทำงานนานเกินเวลาที่กำหนด', ER_STATEMENT_TIMEOUT: 'Query ทำงานนานเกินเวลาที่กำหนด',
    PROTOCOL_SEQUENCE_TIMEOUT: 'Query ทำงานนานเกินเวลาที่กำหนด', ER_TABLEACCESS_DENIED_ERROR: 'ผู้ใช้ไม่มีสิทธิ์ SELECT ตารางนี้',
    ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: 'คำสั่งนี้พยายามเขียนข้อมูล (อนุญาตเฉพาะการอ่าน)',
  };
  if (e && M[e.code]) return `${M[e.code]} — ${String(e.sqlMessage || e.message || '').slice(0, 200)}`;
  return baseFriendly(e);
}

const HISTORY_MAX = 2880;
const MAX_ROWS = 500;
const NAME_RE = /^[A-Za-z0-9_$]{1,64}$/;
const ALLOWED = /^(SELECT|WITH|SHOW|EXPLAIN|DESCRIBE|DESC|CHECKSUM\s+TABLE)\b/i;
const LEVEL = { ok: 0, info: 1, warning: 2, critical: 3 };

/* ---------------------------------------------------------------- SQL safety */
function stripForCheck(sql) {
  return String(sql || '')
    .replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, "''")   // ตัด string literal ออกก่อนตรวจ
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--\s|#)[^\n]*/g, ' ')
    .trim();
}
function validateSql(sql) {
  const raw = String(sql || '').trim().replace(/;\s*$/, '');
  const s = stripForCheck(raw);
  if (!s) throw new Error('กรุณาใส่คำสั่ง SQL');
  if (raw.length > 8000) throw new Error('คำสั่ง SQL ยาวเกิน 8,000 ตัวอักษร');
  if (!ALLOWED.test(s)) throw new Error('อนุญาตเฉพาะคำสั่งอ่านข้อมูล: SELECT, WITH, SHOW, EXPLAIN, DESCRIBE, CHECKSUM TABLE');
  if (s.includes(';')) throw new Error('ใส่ได้ครั้งละ 1 คำสั่ง (ห้ามมี ; คั่นกลาง)');
  if (/\bINTO\s+(OUTFILE|DUMPFILE|@)/i.test(s)) throw new Error('ห้ามใช้ INTO OUTFILE / DUMPFILE / ตัวแปร');
  if (/\bFOR\s+UPDATE\b|\bLOCK\s+IN\s+SHARE\s+MODE\b|\bFOR\s+SHARE\b/i.test(s)) throw new Error('ห้ามใช้คำสั่งล็อกแถว (FOR UPDATE / LOCK IN SHARE MODE)');
  if (/\b(SLEEP|BENCHMARK|GET_LOCK|LOAD_FILE)\s*\(/i.test(s)) throw new Error('ห้ามใช้ฟังก์ชัน SLEEP / BENCHMARK / GET_LOCK / LOAD_FILE');
  return raw;
}

/* ---------------------------------------------------------------- value helpers */
function cell(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v.length > 64 ? `0x${v.subarray(0, 64).toString('hex')}…` : `0x${v.toString('hex')}`;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'string' && v.length > 500) return v.slice(0, 500) + '…';
  return v;
}
function compareValue(a, b, tol) {
  if (a == null && b == null) return { ok: true, numeric: false, diff: null };
  const ia = /^-?\d+$/.test(String(a)), ib = /^-?\d+$/.test(String(b));
  if (ia && ib) {
    const d = Number(BigInt(String(a)) - BigInt(String(b)));
    return { ok: Math.abs(d) <= tol, numeric: true, diff: d };
  }
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && a != null && b != null && Number.isFinite(na) && Number.isFinite(nb)) {
    const d = Math.round((na - nb) * 1e6) / 1e6;
    return { ok: Math.abs(d) <= tol, numeric: true, diff: d };
  }
  return { ok: String(a) === String(b), numeric: false, diff: null };
}
/** เทียบผลแบบตาราง: คอลัมน์แรกเป็นคีย์ · ค่าตัวเลขต่างกันได้ไม่เกิน tol */
function compareTables(m, s, tol = 0) {
  const key = (r) => String(r[0]);
  const ser = (r) => JSON.stringify(r);
  const sameRow = (a, b) => a.length === b.length && a.every((v, i) => i === 0 || String(v) === String(b[i]) || (tol > 0 && compareValue(v, b[i], tol).ok));
  const ms = new Map(m.rows.map((r) => [key(r), r])), ss = new Map(s.rows.map((r) => [key(r), r]));
  const onlyMaster = [], onlySlave = [], changed = [];
  let same = 0;
  for (const [k, r] of ms) {
    if (!ss.has(k)) onlyMaster.push(r);
    else if (ser(r) !== ser(ss.get(k)) && !sameRow(r, ss.get(k))) changed.push({ key: k, master: r, slave: ss.get(k) });
    else same++;
  }
  for (const [k, r] of ss) if (!ms.has(k)) onlySlave.push(r);
  const sameCols = JSON.stringify(m.columns) === JSON.stringify(s.columns);
  return { ok: sameCols && !onlyMaster.length && !onlySlave.length && !changed.length, sameCols, same,
    onlyMaster: onlyMaster.slice(0, 100), onlySlave: onlySlave.slice(0, 100), changed: changed.slice(0, 100),
    counts: { master: m.rows.length, slave: s.rows.length, onlyMaster: onlyMaster.length, onlySlave: onlySlave.length, changed: changed.length } };
}

module.exports = function createDbSync({ getConfig, onIssue = () => {}, onSample = () => {}, onUpdate = () => {}, log = console }) {
  const pools = { master: null, slave: null }, poolKeys = { master: '', slave: '' };
  let last = null, tables = null, running = false, tablesRunning = false, timer = null;
  const history = [];
  const qState = new Map();     // id → { lastRun, result, history: [diff…] }
  const issueCount = new Map(); // key → consecutive count
  const raised = new Set();
  const prevStatus = { master: null, slave: null };

  const cfg = () => getConfig() || {};
  const configured = () => { const c = cfg(); return !!(mysql && c.master && c.master.host && c.slave && c.slave.host); };

  /* ------------------------------------------------------------ connections */
  function opts(c) {
    return { host: c.host, port: Number(c.port) || 3306, user: c.user, password: c.password || '',
      waitForConnections: true, connectionLimit: 3, queueLimit: 20, connectTimeout: 6000,
      dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, timezone: 'local', charset: 'utf8mb4',
      ssl: c.ssl ? { rejectUnauthorized: false } : undefined, enableKeepAlive: true };
  }
  function pool(side) {
    const c = cfg()[side] || {};
    const k = JSON.stringify([c.host, c.port, c.user, c.password, c.ssl]);
    if (!pools[side] || poolKeys[side] !== k) {
      if (pools[side]) pools[side].end().catch(() => {});
      pools[side] = mysql.createPool(opts(c)); poolKeys[side] = k;
    }
    return pools[side];
  }
  function resetPools() { for (const s of ['master', 'slave']) { if (pools[s]) pools[s].end().catch(() => {}); pools[s] = null; poolKeys[s] = ''; } }
  function reset() {
    for (const s of ['master', 'slave']) { if (pools[s]) pools[s].end().catch(() => {}); pools[s] = null; poolKeys[s] = ''; }
    last = null; tables = null; history.length = 0; qState.clear();
  }
  /** รันคำสั่งบนเครื่องหนึ่ง (อ่านอย่างเดียว + จำกัดเวลา) */
  async function exec(conn, sql, { db, timeoutMs = 15000, readOnly = true } = {}) {
    await conn.query(`SET SESSION max_execution_time = ${Math.round(timeoutMs)}`).catch(() => {});        // MySQL
    await conn.query(`SET SESSION max_statement_time = ${(timeoutMs / 1000).toFixed(1)}`).catch(() => {}); // MariaDB
    if (db) { if (!NAME_RE.test(db)) throw new Error('ชื่อฐานข้อมูลไม่ถูกต้อง'); await conn.query(`USE \`${db}\``); }
    let tx = false;
    if (readOnly) { try { await conn.query('START TRANSACTION READ ONLY'); tx = true; } catch { /* ignore */ } }
    try {
      const t0 = process.hrtime.bigint();
      const [rows, fields] = await conn.query({ sql, timeout: timeoutMs + 2000, rowsAsArray: true });
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      const list = Array.isArray(rows) ? rows : [];
      const cols = (fields || []).map((f) => f.name);
      return { columns: cols, rows: list.slice(0, MAX_ROWS).map((r) => r.map(cell)), total: list.length, truncated: list.length > MAX_ROWS, ms: Math.round(ms * 100) / 100 };
    } finally { if (tx) await conn.query('ROLLBACK').catch(() => {}); }
  }
  async function run(side, sql, o = {}) {
    const p = pool(side);
    const conn = await p.getConnection();
    let broken = false;
    const c = cfg();
    const db = o.db === undefined ? (c[side].database || c.master.database) : o.db;
    try { return await exec(conn, sql, { ...o, db }); }
    catch (e) { if (/TIMEOUT|PROTOCOL|ECONNRESET/.test(e.code || '')) broken = true; throw e; }
    finally { if (broken) conn.destroy(); else conn.release(); }
  }
  const objRows = (r) => r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  async function tryShow(side, list) {
    let lastErr;
    for (const sql of list) {
      try { return objRows(await run(side, sql, { db: null, readOnly: false, timeoutMs: 8000 })); }
      catch (e) { lastErr = e; if (!/PARSE|SYNTAX|ER_PARSE_ERROR/.test(e.code || '')) break; }
    }
    throw lastErr;
  }

  /* ------------------------------------------------------------ server info */
  async function serverInfo(side) {
    const t0 = Date.now();
    const out = { ok: false, host: cfg()[side].host, port: Number(cfg()[side].port) || 3306 };
    try {
      const [r] = objRows(await run(side, 'SELECT 1 AS ping', { db: null, readOnly: false, timeoutMs: 6000 }));
      out.latencyMs = Date.now() - t0;
      if (!r) throw new Error('no response');
      const [i] = objRows(await run(side, `SELECT VERSION() AS version, @@version_comment AS comment, @@hostname AS hostname,
        @@server_id AS server_id, @@read_only AS read_only, @@log_bin AS log_bin`, { db: null, readOnly: false }));
      Object.assign(out, { version: i.version, comment: i.comment, hostname: i.hostname, serverId: Number(i.server_id),
        readOnly: Number(i.read_only) === 1, logBin: Number(i.log_bin) === 1 });
      out.mariadb = /mariadb/i.test(`${i.version} ${i.comment}`);
      const st = objRows(await run(side, `SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries')`, { db: null, readOnly: false }));
      const g = Object.fromEntries(st.map((x) => [x.Variable_name, Number(x.Value)]));
      out.uptime = g.Uptime; out.threads = g.Threads_connected; out.running = g.Threads_running; out.slowQueries = g.Slow_queries;
      const prev = prevStatus[side];
      if (prev && g.Uptime > prev.uptime) out.qps = Math.round(((g.Questions - prev.questions) / (g.Uptime - prev.uptime)) * 10) / 10;
      prevStatus[side] = { uptime: g.Uptime, questions: g.Questions };
      out.ok = true;
    } catch (e) { out.error = friendly(e); out.latencyMs = out.latencyMs ?? null; }
    return out;
  }
  async function binlogStatus() {
    try {
      const rows = await tryShow('master', ['SHOW BINARY LOG STATUS', 'SHOW MASTER STATUS']);
      if (!rows.length) return { enabled: false };
      const r = rows[0];
      const b = { enabled: true, file: r.File, pos: Number(r.Position), gtid: r.Executed_Gtid_Set || null };
      if (!b.gtid) { try { const [x] = objRows(await run('master', 'SELECT @@gtid_binlog_pos AS g', { db: null, readOnly: false })); b.gtid = x.g || null; } catch { /* MySQL */ } }
      return b;
    } catch (e) { return { error: /DENIED/.test(e.code || '') ? 'ไม่มีสิทธิ์ดูสถานะ binlog บนเครื่อง Master — MySQL: GRANT REPLICATION CLIENT ON *.* · MariaDB 10.5+: GRANT BINLOG MONITOR ON *.*' : friendly(e) }; }
  }
  async function replicaStatus() {
    let rows;
    try { rows = await tryShow('slave', ['SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']); }
    catch (e) { return { error: /DENIED/.test(e.code || '') ? 'ไม่มีสิทธิ์ดูสถานะ Replication บนเครื่อง Slave — MySQL: GRANT REPLICATION CLIENT ON *.* · MariaDB 10.5+: GRANT SLAVE MONITOR ON *.*' : friendly(e) }; }
    if (!rows.length) return { notReplica: true };
    const mh = String(cfg().master.host || '');
    const g = (r, ...ks) => { for (const k of ks) if (r[k] !== undefined && r[k] !== null) return r[k]; return null; };
    const r = rows.find((x) => String(g(x, 'Source_Host', 'Master_Host')) === mh) || rows[0];
    const lag = g(r, 'Seconds_Behind_Source', 'Seconds_Behind_Master');
    const out = {
      io: g(r, 'Replica_IO_Running', 'Slave_IO_Running'), sql: g(r, 'Replica_SQL_Running', 'Slave_SQL_Running'),
      lag: lag == null || lag === '' ? null : Number(lag),
      sourceHost: g(r, 'Source_Host', 'Master_Host'), sourcePort: Number(g(r, 'Source_Port', 'Master_Port')) || null,
      readFile: g(r, 'Source_Log_File', 'Master_Log_File'), readPos: Number(g(r, 'Read_Source_Log_Pos', 'Read_Master_Log_Pos')) || 0,
      execFile: g(r, 'Relay_Source_Log_File', 'Relay_Master_Log_File'), execPos: Number(g(r, 'Exec_Source_Log_Pos', 'Exec_Master_Log_Pos')) || 0,
      ioError: g(r, 'Last_IO_Error') || '', sqlError: g(r, 'Last_SQL_Error') || '', lastErrno: Number(g(r, 'Last_Errno', 'Last_SQL_Errno')) || 0,
      ioState: g(r, 'Replica_IO_State', 'Slave_IO_State') || '', sqlState: g(r, 'Replica_SQL_Running_State', 'Slave_SQL_Running_State') || '',
      gtidMode: g(r, 'Using_Gtid') || (Number(g(r, 'Auto_Position')) === 1 ? 'Auto_Position' : 'No'),
      executedGtid: g(r, 'Executed_Gtid_Set') || null, channels: rows.length, connectionName: g(r, 'Connection_name', 'Channel_Name') || '',
    };
    if (!out.executedGtid) { try { const [x] = objRows(await run('slave', 'SELECT @@gtid_slave_pos AS g', { db: null, readOnly: false })); out.executedGtid = x.g || null; } catch { /* MySQL */ } }
    return out;
  }

  /* ------------------------------------------------------------ custom queries */
  async function runQuery(q, force = false) {
    const st = qState.get(q.id) || { history: [] };
    qState.set(q.id, st);
    if (!force && st.lastRun && q.everyMin > 0 && Date.now() - st.lastRun < q.everyMin * 60000) return st.result;
    const side = async (s) => {
      if (q.target !== 'both' && q.target !== s) return null;
      try { return await run(s, q.sql, { db: q.database || undefined, timeoutMs: (q.timeoutSec || 15) * 1000 }); }
      catch (e) { return { error: friendly(e) }; }
    };
    const [m, s] = await Promise.all([side('master'), side('slave')]);
    const res = { id: q.id, at: Date.now(), master: m, slave: s, status: 'ok' };
    if ((m && m.error) || (s && s.error)) res.status = 'error';
    else if (q.target === 'both') {
      if (q.mode === 'table') {
        res.compare = compareTables(m, s, Number(q.tolerance) || 0);
        res.status = res.compare.ok ? 'ok' : 'diff';
      } else {
        const a = m.rows[0] ? m.rows[0][0] : null, b = s.rows[0] ? s.rows[0][0] : null;
        res.compare = compareValue(a, b, Number(q.tolerance) || 0);
        res.status = res.compare.ok ? 'ok' : 'diff';
        if (res.compare.numeric) { st.history.push(res.compare.diff); if (st.history.length > 60) st.history.shift(); }
      }
    } else res.status = 'info';
    st.lastRun = Date.now(); st.result = res;
    return res;
  }

  /* ------------------------------------------------------------ issues → alerts */
  function evaluate(r) {
    const c = cfg(), issues = [];
    const add = (key, level, text) => issues.push({ key, level, text });
    if (!r.master.ok) add('conn_master', 'critical', `เชื่อมต่อเครื่อง Master (${r.master.host}) ไม่ได้: ${r.master.error}`);
    if (!r.slave.ok) add('conn_slave', 'critical', `เชื่อมต่อเครื่อง Slave (${r.slave.host}) ไม่ได้: ${r.slave.error}`);
    if (r.slave.ok) {
      const p = r.replica;
      if (p.error) add('repl_priv', 'warning', p.error);
      else if (p.notReplica) add('repl_none', 'critical', 'เครื่อง Slave ไม่ได้ตั้งค่า Replication (SHOW REPLICA STATUS ว่าง)');
      else {
        if (p.io !== 'Yes' || p.sql !== 'Yes') {
          add('repl_broken', 'critical', `Replication หยุดทำงาน — IO thread: ${p.io}, SQL thread: ${p.sql}${p.sqlError ? ` · ${p.sqlError}` : ''}${p.ioError ? ` · ${p.ioError}` : ''}`);
        } else if (p.lag != null && p.lag >= (c.lagCrit || 300)) add('repl_lag', 'critical', `Replication ล่าช้า ${p.lag} วินาที (เกณฑ์วิกฤต ${c.lagCrit} วินาที)`);
        else if (p.lag != null && p.lag >= (c.lagWarn || 30)) add('repl_lag', 'warning', `Replication ล่าช้า ${p.lag} วินาที (เกณฑ์เตือน ${c.lagWarn} วินาที)`);
        if (r.master.ok && p.sourceHost && p.sourcePort && r.master.port && p.sourcePort !== r.master.port && p.sourceHost === r.master.host) {
          add('repl_source', 'warning', `Slave ตั้งค่าให้รับข้อมูลจาก ${p.sourceHost}:${p.sourcePort} ไม่ใช่ Master ที่ตั้งไว้ (${r.master.host}:${r.master.port})`);
        }
      }
      if (!r.slave.readOnly) add('slave_rw', 'warning', 'เครื่อง Slave ไม่ได้เปิด read_only — มีความเสี่ยงที่ข้อมูลจะถูกแก้ไขตรงที่ Slave จนไม่ตรงกับ Master');
    }
    if (r.master.ok && r.master.serverId && r.slave.ok && r.master.serverId === r.slave.serverId) add('server_id', 'critical', `server_id ของ Master และ Slave ซ้ำกัน (${r.master.serverId})`);
    if (r.master.ok && r.binlog && r.binlog.enabled === false) add('binlog_off', 'warning', 'เครื่อง Master ไม่ได้เปิด binary log (log_bin = OFF)');
    // ถ้ามีปัญหาที่ต้นเหตุ (เครื่องล่ม / replication หยุดหรือช้า) ผล Query ที่ต่างกันเป็นผลตามมา → แสดงเป็นข้อมูล ไม่แจ้งเตือนซ้ำ
    const root = issues.find((i) => /^(conn_|repl_broken|repl_lag|repl_none)/.test(i.key));
    for (const q of r.queries) {
      if (q.status === 'diff') {
        add(`q:${q.id}`, root ? 'info' : 'warning', `ข้อมูลไม่ตรงกัน: ${q.name}${q.compare && q.compare.numeric ? ` (ต่างกัน ${q.compare.diff})` : ''}${root ? ' — น่าจะเป็นผลจากปัญหา Replication ด้านบน' : ''}`);
      }
      if (q.status === 'error' && !(r.master.ok === false || r.slave.ok === false)) {
        add(`qerr:${q.id}`, 'info', `Query “${q.name}” ทำงานผิดพลาด: ${(q.master && q.master.error) || (q.slave && q.slave.error)}`);
      }
    }
    return issues;
  }
  function dispatch(issues) {
    const now = new Set(issues.map((i) => i.key));
    for (const i of issues) {
      const n = (issueCount.get(i.key) || 0) + 1;
      issueCount.set(i.key, n);
      // ต้องพบติดกัน 2 รอบก่อนแจ้งเตือน (กันแจ้งเตือนหลอกจาก lag ชั่วคราว)
      if (n >= 2 && !raised.has(i.key) && i.level !== 'info') { raised.add(i.key); onIssue({ ...i, active: true }); }
    }
    for (const k of [...issueCount.keys()]) {
      if (!now.has(k)) { issueCount.delete(k); if (raised.has(k)) { raised.delete(k); onIssue({ key: k, active: false }); } }
    }
  }

  /* ------------------------------------------------------------ cycle */
  async function check(force = false) {
    if (running || !configured() || (!cfg().enabled && !force)) return last;
    running = true;
    try {
      const c = cfg();
      const [m, s] = await Promise.all([serverInfo('master'), serverInfo('slave')]);
      const [binlog, replica] = await Promise.all([m.ok ? binlogStatus() : null, s.ok ? replicaStatus() : null]);
      const queries = [];
      for (const q of (c.queries || []).filter((x) => x.enabled !== false)) {
        const r = await runQuery(q, force);
        if (r) queries.push({ ...r, name: q.name });
      }
      let gap = null;
      if (binlog && binlog.file && replica && replica.execFile === binlog.file) gap = Math.max(0, binlog.pos - replica.execPos);
      const r = { at: Date.now(), master: m, slave: s, binlog, replica, gapBytes: gap, queries };
      r.issues = evaluate(r);
      const worst = r.issues.reduce((a, i) => Math.max(a, LEVEL[i.level]), 0);
      r.level = Object.keys(LEVEL).find((k) => LEVEL[k] === worst);
      r.code = !m.ok || !s.ok ? 'offline' : replica && (replica.notReplica) ? 'norepl'
        : replica && !replica.error && (replica.io !== 'Yes' || replica.sql !== 'Yes') ? 'broken'
          : r.issues.some((i) => i.key === 'repl_lag') ? 'lag' : r.issues.some((i) => i.key.startsWith('q:')) ? 'diff' : worst >= 2 ? 'warning' : 'sync';
      last = r;
      history.push({ t: r.at, code: r.code, lag: replica && !replica.error ? replica.lag : null, mMs: m.latencyMs, sMs: s.latencyMs, gap,
        diffs: queries.filter((q) => q.status === 'diff').length });
      if (history.length > HISTORY_MAX) history.shift();
      dispatch(r.issues);
      onSample({ keys: r.issues.map((i) => i.key), at: r.at, code: r.code, lag: history[history.length - 1].lag, mMs: m.latencyMs, sMs: s.latencyMs, gap,
        diffs: history[history.length - 1].diffs, detail: r.issues.map((i) => i.text).join(' | ').slice(0, 2000) });
      onUpdate();
      if (!tables || Date.now() - tables.at > (c.tableIntervalMin || 30) * 60000) compareAllTables().catch(() => {});
      return r;
    } catch (e) { log.warn('[dbsync]', e.message); return last; }
    finally { running = false; }
  }
  function schedule() {
    clearInterval(timer);
    const iv = Math.max(10, Number(cfg().intervalSec) || 60) * 1000;
    timer = setInterval(() => check().catch(() => {}), iv); timer.unref();
    setTimeout(() => check().catch(() => {}), 1500).unref();
  }

  /* ------------------------------------------------------------ tables */
  async function compareAllTables() {
    if (tablesRunning || !configured()) return tables;
    tablesRunning = true;
    try {
      const c = cfg();
      const dbm = c.master.database, dbs = c.slave.database || c.master.database;
      if (!dbm) { tables = { at: Date.now(), error: 'ยังไม่ได้กำหนดชื่อฐานข้อมูลที่ต้องการเปรียบเทียบ (ช่อง Database ของ Master)' }; return tables; }
      const list = async (side, db) => {
        const p = pool(side), conn = await p.getConnection();
        try {
          await conn.query('SET SESSION information_schema_stats_expiry = 0').catch(() => {});
          const [rows] = await conn.query(`SELECT TABLE_NAME AS n, TABLE_ROWS AS r, DATA_LENGTH + INDEX_LENGTH AS b, ENGINE AS e
            FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [db]);
          return new Map(rows.map((x) => [x.n, { rows: Number(x.r) || 0, bytes: Number(x.b) || 0, engine: x.e }]));
        } finally { conn.release(); }
      };
      const [M, S] = await Promise.all([list('master', dbm), list('slave', dbs)]);
      const exact = String(c.exactTables || '').split(/[\s,]+/).filter((t) => NAME_RE.test(t)).slice(0, 50);
      const exactRes = {};
      for (const t of exact) {
        const one = async (side, db) => {
          if (!(side === 'master' ? M : S).has(t)) return null;
          try { const r = await run(side, `SELECT COUNT(*) FROM \`${t}\``, { db, timeoutMs: 60000 }); return Number(r.rows[0][0]); }
          catch (e) { return { error: friendly(e) }; }
        };
        const [a, b] = await Promise.all([one('master', dbm), one('slave', dbs)]);
        exactRes[t] = { master: a, slave: b };
      }
      const names = [...new Set([...M.keys(), ...S.keys()])].sort();
      const rows = names.map((n) => {
        const a = M.get(n), b = S.get(n), x = exactRes[n];
        let status = 'ok';
        if (!b) status = 'missing_slave'; else if (!a) status = 'missing_master';
        else if (x && typeof x.master === 'number' && typeof x.slave === 'number') status = x.master === x.slave ? 'exact_ok' : 'exact_diff';
        return { name: n, master: a || null, slave: b || null, exact: x || null, status };
      });
      const sum = (map, k) => [...map.values()].reduce((s, v) => s + v[k], 0);
      tables = { at: Date.now(), database: { master: dbm, slave: dbs }, rows,
        summary: { master: M.size, slave: S.size, both: rows.filter((r) => r.master && r.slave).length,
          onlyMaster: rows.filter((r) => r.status === 'missing_slave').length, onlySlave: rows.filter((r) => r.status === 'missing_master').length,
          exactDiff: rows.filter((r) => r.status === 'exact_diff').length, exactOk: rows.filter((r) => r.status === 'exact_ok').length,
          rowsMaster: sum(M, 'rows'), rowsSlave: sum(S, 'rows'), bytesMaster: sum(M, 'bytes'), bytesSlave: sum(S, 'bytes') } };
      onUpdate();
      return tables;
    } catch (e) { tables = { at: Date.now(), error: friendly(e) }; return tables; }
    finally { tablesRunning = false; }
  }

  /* ------------------------------------------------------------ admin helpers */
  async function testSide(side, c) {
    if (!mysql) throw new Error('ยังไม่ได้ติดตั้งไลบรารี mysql2 — สั่ง npm install ในโฟลเดอร์โปรแกรม');
    const conn = await mysql.createConnection({ ...opts(c), connectionLimit: undefined, waitForConnections: undefined, queueLimit: undefined });
    try {
      const q = async (sql) => { const [r] = await conn.query(sql); return r; };
      const [i] = await q('SELECT VERSION() AS version, @@version_comment AS comment, @@hostname AS hostname, @@server_id AS server_id, @@read_only AS read_only, @@log_bin AS log_bin, CURRENT_USER() AS user');
      const dbs = (await q('SHOW DATABASES')).map((r) => Object.values(r)[0]).filter((d) => !/^(information_schema|performance_schema|mysql|sys)$/.test(d));
      let grants = [];
      try { grants = (await q('SHOW GRANTS FOR CURRENT_USER()')).map((r) => Object.values(r)[0]); } catch { /* ignore */ }
      const g = grants.join('\n');
      const canWrite = /GRANT ALL|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(g.replace(/GRANT USAGE[^\n]*/g, ''));
      let role = '', replClient = true;
      const tryq = async (list) => { for (const s of list) { try { return await q(s); } catch (e) { if (!/PARSE/.test(e.code || '')) return { error: friendly(e) }; } } return null; };
      if (side === 'slave') {
        const r = await tryq(['SHOW REPLICA STATUS', 'SHOW SLAVE STATUS']);
        if (r && r.error) replClient = false;
        role = r && r.error ? `ตรวจ Replication ไม่ได้ — ${/DENIED/.test(r.error) ? 'ไม่มีสิทธิ์ดูสถานะ Replication บนเครื่อง Slave — MySQL: GRANT REPLICATION CLIENT ON *.* · MariaDB 10.5+: GRANT SLAVE MONITOR ON *.*' : r.error}` : r && r.length ? `เป็น Replica ของ ${r[0].Source_Host || r[0].Master_Host}:${r[0].Source_Port || r[0].Master_Port}` : 'ไม่ได้ตั้งค่า Replication';
      } else {
        const r = await tryq(['SHOW BINARY LOG STATUS', 'SHOW MASTER STATUS']);
        if (r && r.error) replClient = false;
        role = r && r.error ? `ตรวจ binlog ไม่ได้ — ${/DENIED/.test(r.error) ? 'ไม่มีสิทธิ์ดูสถานะ binlog บนเครื่อง Master — MySQL: GRANT REPLICATION CLIENT ON *.* · MariaDB 10.5+: GRANT BINLOG MONITOR ON *.*' : r.error}` : r && r.length ? `binlog: ${r[0].File} @ ${r[0].Position}` : 'ไม่ได้เปิด binary log';
      }
      return { version: i.version, hostname: i.hostname, serverId: Number(i.server_id), readOnly: Number(i.read_only) === 1, logBin: Number(i.log_bin) === 1,
        user: i.user, databases: dbs, canWrite, replClient, role, grants: grants.slice(0, 10) };
    } finally { conn.end().catch(() => {}); }
  }
  async function testQuery(q) {
    const r = await runQuery({ ...q, id: '__test__' }, true);
    qState.delete('__test__');
    return r;
  }

  function summary() {
    if (!configured()) return { configured: false };
    if (!last) return { configured: true, enabled: !!cfg().enabled, code: 'pending' };
    return { configured: true, enabled: !!cfg().enabled, code: last.code, level: last.level, at: last.at,
      lag: last.replica && !last.replica.error ? last.replica.lag : null, master: last.master.ok, slave: last.slave.ok,
      issues: last.issues.length, diffs: last.queries.filter((q) => q.status === 'diff').length };
  }
  function view() {
    return { configured: configured(), driver: !!mysql, enabled: !!cfg().enabled, intervalSec: cfg().intervalSec, last, tables,
      history: history.slice(-1440), queryHistory: Object.fromEntries([...qState.entries()].map(([k, v]) => [k, v.history])) };
  }

  return { check, schedule, reset, resetPools, compareAllTables, testSide, testQuery, validateSql, summary, view, history: () => history };
};
module.exports.validateSql = validateSql;
