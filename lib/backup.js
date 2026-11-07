'use strict';
/**
 * SMART TOPOLOGY — สำรอง / กู้คืนการตั้งค่าทั้งหมด
 *
 *  ไฟล์สำรองเป็น JSON: { format, version, app, createdAt, createdBy, encrypted, data | cipher }
 *  data ประกอบด้วยทุกค่าที่ตั้งจากหน้าเว็บ: อุปกรณ์ (รวมตำแหน่งบนแผนผัง), ผู้ใช้ (รหัสผ่านแบบ hash),
 *  การตั้งค่าตรวจสอบ, การแจ้งเตือนภายนอก (รวมคีย์), MySQL, Master/Slave + Custom Query, API Key, Wazuh,
 *  ตั้งค่าสำรองข้อมูล และ (เลือกได้) ประวัติการแจ้งเตือน
 *
 *  เข้ารหัสได้ด้วยรหัสผ่าน: scrypt (N=16384) → AES-256-GCM
 */
const crypto = require('crypto');

const FORMAT = 'smart-topology-backup';
const VERSION = 1;
const SECTIONS = ['settings', 'users', 'devices', 'notify', 'mysql', 'dbsync', 'api', 'wazuh', 'backup', 'seq', 'inventory', 'ipscan'];

function build(db, { includeAlerts = false, createdBy = '', app = '' } = {}) {
  const data = {};
  for (const k of SECTIONS) if (db[k] !== undefined) data[k] = JSON.parse(JSON.stringify(db[k]));
  if (includeAlerts) data.alerts = JSON.parse(JSON.stringify(db.alerts || []));
  return { format: FORMAT, version: VERSION, app, createdAt: new Date().toISOString(), createdBy, encrypted: false, data };
}
function encrypt(backup, pass) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(pass), salt, 32, { N: 16384, r: 8, p: 1 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(backup.data), 'utf8'), c.final()]);
  const { data, ...meta } = backup;
  return { ...meta, encrypted: true, kdf: 'scrypt-16384-8-1', cipher: 'aes-256-gcm',
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), payload: ct.toString('base64') };
}
function decrypt(env, pass) {
  if (!pass) { const e = new Error('ไฟล์นี้เข้ารหัสไว้ กรุณาใส่รหัสผ่านของไฟล์สำรอง'); e.needPass = true; throw e; }
  try {
    const key = crypto.scryptSync(String(pass), Buffer.from(env.salt, 'base64'), 32, { N: 16384, r: 8, p: 1 });
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
    d.setAuthTag(Buffer.from(env.tag, 'base64'));
    const pt = Buffer.concat([d.update(Buffer.from(env.payload, 'base64')), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch { const e = new Error('รหัสผ่านของไฟล์สำรองไม่ถูกต้อง หรือไฟล์ถูกแก้ไข'); e.needPass = true; throw e; }
}
/** อ่านไฟล์สำรอง (object หรือ string) → { meta, data } */
function parse(input, pass) {
  let obj = input;
  if (typeof input === 'string') { try { obj = JSON.parse(input.replace(/^﻿/, '')); } catch { throw new Error('ไฟล์ไม่ใช่ JSON ที่ถูกต้อง'); } }
  if (!obj || typeof obj !== 'object') throw new Error('ไฟล์สำรองไม่ถูกต้อง');
  // รองรับไฟล์ data/db.json โดยตรง (สำรองด้วยการคัดลอกไฟล์)
  if (!obj.format && Array.isArray(obj.users) && Array.isArray(obj.devices)) {
    return { meta: { format: 'db.json', version: 0, createdAt: null, encrypted: false, app: '' }, data: obj };
  }
  if (obj.format !== FORMAT) throw new Error('ไม่ใช่ไฟล์สำรองของ Smart Topology');
  if (Number(obj.version) > VERSION) throw new Error(`ไฟล์สำรองมาจากเวอร์ชันใหม่กว่า (format v${obj.version}) กรุณาอัปเดตโปรแกรมก่อน`);
  const data = obj.encrypted ? decrypt(obj, pass) : obj.data;
  if (!data || typeof data !== 'object') throw new Error('ไม่พบข้อมูลในไฟล์สำรอง');
  const { data: _d, payload: _p, ...meta } = obj;
  return { meta, data };
}
function summarize(data) {
  const n = (x) => (Array.isArray(x) ? x.length : 0);
  return {
    users: n(data.users), admins: (data.users || []).filter((u) => u.role === 'admin').length, devices: n(data.devices),
    alerts: Array.isArray(data.alerts) ? data.alerts.length : null,
    notifyChannels: n(data.notify && data.notify.channels), notifyEnabled: !!(data.notify && data.notify.enabled),
    mysql: !!(data.mysql && data.mysql.enabled && data.mysql.host), mysqlHost: data.mysql ? data.mysql.host : '',
    dbsync: !!(data.dbsync && data.dbsync.master && data.dbsync.master.host), dbQueries: n(data.dbsync && data.dbsync.queries),
    apiKeys: n(data.api && data.api.keys), wazuh: !!(data.wazuh && data.wazuh.url), siteName: data.settings ? data.settings.siteName : '',
    intervalSec: data.settings ? data.settings.intervalSec : null,
    assets: data.inventory ? n(data.inventory.assets) : null, assetChanges: data.inventory ? n(data.inventory.changes) : null,
    ipRanges: data.ipscan ? n(data.ipscan.ranges) : null,
  };
}
/**
 * ตรวจและประกอบฐานข้อมูลใหม่จากไฟล์สำรอง โดยเติมค่าเริ่มต้นให้ส่วนที่ไม่มี
 * D = { defaultDB, sections: { notify: fn, mysql: fn, dbsync: fn, ... }, roles, validateSql }
 */
function sanitize(data, D) {
  const out = D.defaultDB();
  const issues = [];
  // users
  const users = (Array.isArray(data.users) ? data.users : []).filter((u) => u && Number.isFinite(Number(u.id)) && typeof u.username === 'string'
    && typeof u.pass === 'string' && u.pass.includes(':') && D.roles.includes(u.role));
  if (!users.length) throw new Error('ไฟล์สำรองไม่มีบัญชีผู้ใช้ที่ใช้งานได้');
  if (!users.some((u) => u.role === 'admin')) throw new Error('ไฟล์สำรองไม่มีผู้ดูแลระบบ (admin) อย่างน้อย 1 คน');
  const seenU = new Set();
  out.users = users.filter((u) => !seenU.has(u.username.toLowerCase()) && seenU.add(u.username.toLowerCase())).map((u) => ({ ...u, id: Number(u.id) }));
  // devices
  const seenD = new Set();
  out.devices = (Array.isArray(data.devices) ? data.devices : []).filter((d) => d && Number.isFinite(Number(d.id)) && d.name && d.ip
    && !seenD.has(Number(d.id)) && seenD.add(Number(d.id))).map((d) => {
      const o = { ...d, id: Number(d.id) };            // คงลำดับ/ค่าเดิมทุกช่อง เติมเฉพาะช่องที่ไม่มี
      for (const [k, v] of Object.entries({ enabled: true, notify: true, method: 'icmp', type: 'other' })) if (o[k] === undefined) o[k] = v;
      return o;
    });
  const ids = new Set(out.devices.map((d) => d.id));
  out.devices.forEach((d) => { if (d.parentId != null && !ids.has(d.parentId)) { d.parentId = null; issues.push(`อุปกรณ์ “${d.name}” ไม่พบ Uplink เดิม — ตั้งเป็นอุปกรณ์ต้นทาง`); } });
  const dropped = (Array.isArray(data.devices) ? data.devices.length : 0) - out.devices.length;
  if (dropped > 0) issues.push(`ข้ามอุปกรณ์ที่ข้อมูลไม่ครบ ${dropped} รายการ`);
  // sections with defaults
  out.settings = Object.assign(out.settings, data.settings || {});
  for (const [k, fn] of Object.entries(D.sections)) out[k] = Object.assign(fn(), data[k] || {});
  if (out.dbsync) {
    out.dbsync.master = Object.assign(D.defaultDbSide(), (data.dbsync || {}).master || {});
    out.dbsync.slave = Object.assign(D.defaultDbSide(), (data.dbsync || {}).slave || {});
    const q = Array.isArray(out.dbsync.queries) ? out.dbsync.queries : [];
    out.dbsync.queries = q.filter((x) => { try { D.validateSql(x.sql); return x.id && x.name; } catch { issues.push(`ข้าม Query “${x && x.name}” (คำสั่ง SQL ไม่ผ่านการตรวจ)`); return false; } });
  }
  if (out.notify) out.notify.channels = Array.isArray(out.notify.channels) ? out.notify.channels : [];
  if (out.api) out.api.keys = Array.isArray(out.api.keys) ? out.api.keys.filter((k) => k && k.id && k.hash) : [];
  if (out.inventory) {
    out.inventory.assets = Array.isArray(out.inventory.assets) ? out.inventory.assets.filter((a) => a && Number.isFinite(Number(a.id)) && a.hostname) : [];
    out.inventory.changes = Array.isArray(out.inventory.changes) ? out.inventory.changes.filter((c) => c && c.at) : [];
  }
  if (out.ipscan) {
    out.ipscan.ranges = Array.isArray(out.ipscan.ranges) ? out.ipscan.ranges.filter((r) => r && r.id && r.spec) : [];
    if (!out.ipscan.results || typeof out.ipscan.results !== 'object') out.ipscan.results = {};
    if (!Array.isArray(out.ipscan.history)) out.ipscan.history = [];
  }
  out.alerts = Array.isArray(data.alerts) ? data.alerts.slice(-2000) : null;   // null = คงประวัติเดิม
  // seq: ใช้ค่าสูงสุดเสมอ ป้องกัน id ซ้ำ
  const max = (arr) => arr.reduce((a, x) => Math.max(a, Number(x.id) || 0), 0);
  const s = data.seq || {};
  out.seq = { device: Math.max(Number(s.device) || 0, max(out.devices)), user: Math.max(Number(s.user) || 0, max(out.users)),
    alert: Math.max(Number(s.alert) || 0, max(out.alerts || [])) };
  return { db: out, issues };
}

module.exports = { FORMAT, VERSION, build, encrypt, decrypt, parse, summarize, sanitize };
