'use strict';
/**
 * SMART TOPOLOGY — เชื่อมต่อ Wazuh Server API (RESTful, พอร์ต 55000)
 *
 *  ดึงข้อมูล : GET /, /manager/info, /manager/status, /manager/stats, /manager/daemons/stats,
 *             /manager/configuration(?section=), /manager/configuration/validation, /cluster/status,
 *             /agents, /agents/summary/status, /sca/{agent}, /sca/{agent}/checks/{policy}, /ciscat/{agent}/results
 *  ส่งข้อมูล : POST /events  (สูงสุด 100 events/ครั้ง, 30 ครั้ง/นาที — Wazuh 4.6 ขึ้นไป)
 *  ยืนยันตัวตน: POST /security/user/authenticate?raw=true (Basic) → JWT (อายุ 900 วินาทีโดยค่าเริ่มต้น)
 */
const http = require('http');
const https = require('https');

function request(urlStr, { method = 'GET', headers = {}, body, insecure = false, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error('URL ไม่ถูกต้อง')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const data = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = lib.request(u, {
      method, timeout, rejectUnauthorized: !insecure,
      headers: { Accept: 'application/json', 'User-Agent': 'SmartTopology-NOC', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 20e6) chunks.push(c); });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('หมดเวลาเชื่อมต่อ Wazuh API'), { code: 'ETIMEDOUT' })));
    req.on('error', (e) => reject(e));
    if (data) req.write(data);
    req.end();
  });
}
function netError(e) {
  const M = {
    ECONNREFUSED: 'เชื่อมต่อไม่ได้ (ECONNREFUSED) — ตรวจ IP/พอร์ต 55000 และว่า wazuh-manager ทำงานอยู่',
    ETIMEDOUT: 'หมดเวลาเชื่อมต่อ — ตรวจ Firewall พอร์ต 55000', ENOTFOUND: 'ไม่พบชื่อเครื่อง (Host)', EHOSTUNREACH: 'ติดต่อเครื่องปลายทางไม่ได้',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'ใบรับรอง SSL เป็นแบบ self-signed — เปิดตัวเลือก “ยอมรับใบรับรองที่ลงชื่อเอง” หรือติดตั้งใบรับรองที่เชื่อถือได้',
    SELF_SIGNED_CERT_IN_CHAIN: 'ใบรับรอง SSL เป็นแบบ self-signed — เปิดตัวเลือก “ยอมรับใบรับรองที่ลงชื่อเอง”',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'ตรวจสอบใบรับรอง SSL ไม่ได้ — เปิดตัวเลือก “ยอมรับใบรับรองที่ลงชื่อเอง”',
    ERR_TLS_CERT_ALTNAME_INVALID: 'ชื่อในใบรับรอง SSL ไม่ตรงกับ Host ที่ใส่',
  };
  return M[e && e.code] || (e && e.message) || String(e);
}
function flatten(o, pre = '', out = {}) {
  if (o == null) return out;
  if (typeof o === 'number') { out[pre] = o; return out; }
  if (typeof o !== 'object' || Array.isArray(o)) return out;
  for (const [k, v] of Object.entries(o)) flatten(v, pre ? `${pre}.${k}` : k, out);
  return out;
}

module.exports = function createWazuh({ getConfig, onAgentChange = () => {}, onUpdate = () => {}, log = console }) {
  let token = null, tokenExp = 0, tokenKey = '';
  let last = null, running = false, timer = null, pushTimer = null;
  const queue = [], pushLog = [], inbound = [];
  let prevAgents = null;
  const cfg = () => getConfig() || {};
  const configured = () => { const c = cfg(); return !!(c.url && c.user); };
  const base = () => String(cfg().url || '').replace(/\/+$/, '');

  async function authenticate(c = cfg()) {
    const url = `${String(c.url).replace(/\/+$/, '')}/security/user/authenticate?raw=true`;
    const r = await request(url, { method: 'POST', insecure: !c.verifyTls,
      headers: { Authorization: `Basic ${Buffer.from(`${c.user}:${c.password || ''}`).toString('base64')}` } });
    if (r.status === 401) throw new Error('ชื่อผู้ใช้หรือรหัสผ่าน Wazuh API ไม่ถูกต้อง');
    if (r.status === 403) throw new Error('ผู้ใช้นี้ไม่มีสิทธิ์เข้าใช้ Wazuh API (หรือถูกบล็อกชั่วคราวจากการล็อกอินผิดหลายครั้ง)');
    if (r.status >= 400) throw new Error(`ยืนยันตัวตนไม่สำเร็จ (HTTP ${r.status}) ${(r.json && (r.json.detail || r.json.title)) || ''}`);
    const t = r.json ? (r.json.data && r.json.data.token) : r.text.trim();
    if (!t || t.length < 20) throw new Error('ไม่ได้รับ token จาก Wazuh API');
    return t;
  }
  async function getToken(force = false) {
    const c = cfg(), k = JSON.stringify([c.url, c.user, c.password, c.verifyTls]);
    if (!force && token && tokenKey === k && Date.now() < tokenExp) return token;
    token = await authenticate(c); tokenKey = k; tokenExp = Date.now() + 780000; // ต่ออายุก่อนหมด (ค่าเริ่มต้น 900 วินาที)
    return token;
  }
  /** เรียก Wazuh API (ต่ออายุ token อัตโนมัติเมื่อได้ 401) */
  async function call(method, path, { query, body, timeout } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null && v !== ''))}` : '';
    let tries = 0;
    for (;;) {
      const t = await getToken(tries > 0);
      const r = await request(`${base()}${path}${qs}`, { method, body, timeout, insecure: !cfg().verifyTls, headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 401 && tries++ === 0) continue;
      if (r.status >= 400) {
        const j = r.json || {};
        const err = new Error(`${j.title || `HTTP ${r.status}`}${j.detail ? `: ${j.detail}` : ''}`);
        err.status = r.status; throw err;
      }
      if (!r.json) throw new Error('Wazuh API ตอบกลับไม่ใช่ JSON');
      return r.json;
    }
  }
  const items = (j) => (j && j.data && Array.isArray(j.data.affected_items) ? j.data.affected_items : []);

  /* ------------------------------------------------------------ collect */
  async function collect() {
    if (running || !configured()) return last;
    running = true;
    const errors = {};
    const t0 = Date.now();
    const safe = async (key, fn) => { try { return await fn(); } catch (e) { errors[key] = e.status ? e.message : netError(e); return null; } };
    try {
      const api = await safe('api', () => call('GET', '/'));
      if (!api) {
        last = { at: Date.now(), ok: false, error: errors.api, errors };
        onUpdate(); return last;
      }
      const [info, status, summary, agents, stats, daemons, cluster, validation] = await Promise.all([
        safe('info', () => call('GET', '/manager/info')),
        safe('status', () => call('GET', '/manager/status')),
        safe('summary', () => call('GET', '/agents/summary/status')),
        safe('agents', () => call('GET', '/agents', { query: { limit: 500, sort: '+id', select: 'id,name,ip,status,os.name,os.version,os.platform,version,lastKeepAlive,group,node_name,dateAdd' } })),
        safe('stats', () => call('GET', '/manager/stats')),
        safe('daemons', async () => {
          try { return { v: 2, j: await call('GET', '/manager/daemons/stats', { query: { daemons_list: 'wazuh-analysisd,wazuh-remoted' } }) }; }
          catch (e) { if (e.status !== 404 && e.status !== 405) throw e; return { v: 1, j: await call('GET', '/manager/stats/analysisd') }; }
        }),
        safe('cluster', () => call('GET', '/cluster/status')),
        safe('validation', () => call('GET', '/manager/configuration/validation')),
      ]);
      const a = api.data || {}, mi = items(info)[0] || {};
      const sd = summary && summary.data ? (summary.data.connection || summary.data) : null;
      const agentList = items(agents).map((x) => ({ id: x.id, name: x.name, ip: x.ip, status: x.status, os: x.os ? [x.os.name, x.os.version].filter(Boolean).join(' ') : '',
        platform: x.os ? x.os.platform : '', version: x.version || '', lastKeepAlive: x.lastKeepAlive || null, group: x.group || [], node: x.node_name || '', dateAdd: x.dateAdd || null }));
      // สถิติ daemon
      let analysisd = {}, remoted = {};
      if (daemons) {
        if (daemons.v === 2) {
          for (const d of items(daemons.j)) {
            const f = flatten(d.metrics || {}); if (d.uptime) f.uptime = d.uptime;
            if (/analysisd/.test(d.name)) analysisd = f; else if (/remoted/.test(d.name)) remoted = f;
          }
        } else analysisd = flatten(items(daemons.j)[0] || {});
      }
      // SCA + CIS-CAT รายเครื่อง (เฉพาะ agent ที่ active)
      const max = Math.max(0, Math.min(200, Number(cfg().scaMax) || 20));
      const active = agentList.filter((x) => x.status === 'active').slice(0, max);
      const sca = {}, ciscat = {};
      let scaDenied = null;
      for (let i = 0; i < active.length; i += 4) {
        await Promise.all(active.slice(i, i + 4).map(async (ag) => {
          try { sca[ag.id] = items(await call('GET', `/sca/${encodeURIComponent(ag.id)}`, { query: { limit: 50 } })).map((p) => ({
            policy_id: p.policy_id, name: p.name, description: p.description, pass: p.pass, fail: p.fail, invalid: p.invalid,
            total: p.total_checks, score: p.score, end_scan: p.end_scan })); }
          catch (e) { if (e.status === 403) scaDenied = e.message; sca[ag.id] = null; }
          try { const c = items(await call('GET', `/ciscat/${encodeURIComponent(ag.id)}/results`, { query: { limit: 1, sort: '-scan.time' } }))[0];
            ciscat[ag.id] = c ? { benchmark: c.benchmark, profile: c.profile, pass: c.pass, fail: c.fail, error: c.error, notchecked: c.notchecked, unknown: c.unknown, score: c.score, time: c.scan && c.scan.time } : null; }
          catch { ciscat[ag.id] = null; }
        }));
      }
      if (scaDenied) errors.sca = scaDenied;
      last = {
        at: Date.now(), ok: true, ms: Date.now() - t0, errors,
        manager: { title: a.title, apiVersion: a.api_version, revision: a.revision, hostname: a.hostname, timestamp: a.timestamp,
          version: mi.version, type: mi.type, compilationDate: mi.compilation_date, maxAgents: mi.max_agents, tz: mi.tz_name, openssl: mi.openssl_support,
          daemons: items(status)[0] || {}, cluster: cluster ? cluster.data : null, validation: items(validation) },
        summary: sd ? { active: sd.active || 0, disconnected: sd.disconnected || 0, never_connected: sd.never_connected || 0, pending: sd.pending || 0, total: sd.total || 0 } : null,
        agents: agentList,
        hourly: items(stats).map((h) => ({ hour: h.hour, alerts: h.totalAlerts || 0, events: h.events || 0, syscheck: h.syscheck || 0, firewall: h.firewall || 0,
          top: (h.alerts || []).sort((x, y) => (y.times || 0) - (x.times || 0)).slice(0, 5) })),
        analysisd, remoted, sca, ciscat,
      };
      // ตรวจ agent ที่สถานะเปลี่ยน
      const now = new Map(agentList.map((x) => [x.id, x]));
      if (prevAgents) for (const [id, ag] of now) { const p = prevAgents.get(id); if (p && p.status !== ag.status) onAgentChange(ag, p.status, ag.status); }
      prevAgents = now;
      onUpdate();
      return last;
    } finally { running = false; }
  }

  /* ------------------------------------------------------------ push events → POST /events */
  function enqueue(ev) {
    if (!cfg().pushEnabled || !configured()) return;
    queue.push(JSON.stringify(ev));
    if (queue.length > 5000) queue.splice(0, queue.length - 5000);
  }
  async function flushPush() {
    if (!queue.length || !configured()) return null;
    const batch = queue.splice(0, 100);
    const entry = { at: Date.now(), count: batch.length, ok: false, info: '' };
    try {
      const j = await call('POST', '/events', { body: { events: batch } });
      entry.ok = true; entry.info = j.message || 'ok';
      const failed = j.data && j.data.total_failed_items;
      if (failed) { entry.ok = false; entry.info = `ส่งไม่สำเร็จ ${failed} รายการ`; }
    } catch (e) {
      entry.info = e.status === 404 || e.status === 405 ? 'Wazuh เวอร์ชันนี้ไม่มี POST /events (ต้องการ 4.6 ขึ้นไป)' : e.status ? e.message : netError(e);
      if (!e.status || e.status >= 500 || e.status === 429) queue.unshift(...batch);   // ลองส่งใหม่รอบถัดไป
    }
    pushLog.push(entry); if (pushLog.length > 50) pushLog.shift();
    return entry;
  }
  async function pushTest(site) {
    queue.unshift(JSON.stringify({ integration: 'smart-topology', st: { event: 'test', severity: 'info', message: 'ทดสอบส่ง event จาก Smart Topology NOC', site, time: new Date().toISOString() } }));
    return flushPush();
  }

  /* ------------------------------------------------------------ inbound (Wazuh → Smart Topology) */
  function addInbound(rec) { inbound.unshift(rec); if (inbound.length > 200) inbound.pop(); }

  /* ------------------------------------------------------------ admin helpers */
  async function test(c) {
    const t = await authenticate(c);
    const r = await request(`${String(c.url).replace(/\/+$/, '')}/`, { insecure: !c.verifyTls, headers: { Authorization: `Bearer ${t}` } });
    const i = await request(`${String(c.url).replace(/\/+$/, '')}/manager/info`, { insecure: !c.verifyTls, headers: { Authorization: `Bearer ${t}` } });
    const d = (r.json && r.json.data) || {}, mi = items(i.json)[0] || {};
    return { apiVersion: d.api_version, hostname: d.hostname, title: d.title, version: mi.version, type: mi.type, managerInfo: i.status < 400 };
  }
  const configSection = (section) => call('GET', '/manager/configuration', { query: section ? { section } : undefined }).then((j) => items(j)[0] || {});
  const scaChecks = (agent, policy, result) => call('GET', `/sca/${encodeURIComponent(agent)}/checks/${encodeURIComponent(policy)}`, { query: { limit: 200, result: result || undefined } })
    .then((j) => items(j).map((x) => ({ id: x.id, title: x.title, result: x.result, rationale: x.rationale, remediation: x.remediation, description: x.description, compliance: x.compliance })));

  function schedule() {
    clearInterval(timer); clearInterval(pushTimer);
    if (!cfg().enabled || !configured()) return;
    const iv = Math.max(1, Number(cfg().intervalMin) || 5) * 60000;
    timer = setInterval(() => collect().catch((e) => log.warn('[wazuh]', e.message)), iv); timer.unref();
    pushTimer = setInterval(() => flushPush().catch(() => {}), 10000); pushTimer.unref();   // ≤ 6 ครั้ง/นาที (Wazuh จำกัด 30)
    setTimeout(() => collect().catch(() => {}), 2000).unref();
  }
  function reset() { token = null; tokenExp = 0; last = null; prevAgents = null; queue.length = 0; }
  const summary = () => (!configured() ? { configured: false } : { configured: true, enabled: !!cfg().enabled, ok: last ? last.ok : null, at: last ? last.at : null,
    agents: last && last.summary ? { active: last.summary.active, total: last.summary.total, disconnected: last.summary.disconnected } : null });
  const view = () => ({ configured: configured(), enabled: !!cfg().enabled, last, pushLog: pushLog.slice().reverse(), queue: queue.length, inbound: inbound.slice(0, 100) });

  return { collect, call, test, schedule, reset, enqueue, flushPush, pushTest, addInbound, configSection, scaChecks, summary, view };
};
module.exports.netError = netError;
