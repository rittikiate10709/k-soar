'use strict';
/**
 * SMART TOPOLOGY — API Gateway สำหรับระบบภายนอก
 *  - API Key (Bearer token) เก็บเฉพาะค่า hash (SHA-256) ไม่เก็บ token จริง
 *  - สิทธิ์ต่อ key: viewer / operator / admin / integration (รับข้อมูลจาก Wazuh เท่านั้น) / agent (ส่งสเปคเครื่องเท่านั้น)
 *  - จำกัดจำนวนครั้งต่อนาที (rate limit), จำกัด IP ต้นทาง (allowlist), วันหมดอายุ
 *  - CORS สำหรับเว็บแอปภายนอกที่เรียก API จากเบราว์เซอร์
 */
const crypto = require('crypto');

const ROLES = ['viewer', 'operator', 'admin', 'integration', 'agent'];
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

function normIp(ip) { return String(ip || '').replace(/^::ffff:/, '').trim(); }
function ip4(ip) { const p = ip.split('.'); if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || +x > 255)) return null; return p.reduce((a, b) => (a << 8) + +b, 0) >>> 0; }
/** ตรวจ IP กับรายการ เช่น 172.16.1.50, 172.16.0.0/16, ::1 */
function ipAllowed(ip, rules) {
  if (!rules || !rules.length) return true;
  ip = normIp(ip);
  const n = ip4(ip);
  return rules.some((r) => {
    r = String(r).trim();
    if (!r) return false;
    if (r.includes('/') && n != null) {
      const [base, bits] = r.split('/'); const b = ip4(base), k = Number(bits);
      if (b == null || !(k >= 0 && k <= 32)) return false;
      const mask = k === 0 ? 0 : (~0 << (32 - k)) >>> 0;
      return (n & mask) === (b & mask);
    }
    return normIp(r) === ip;
  });
}
function validRule(r) {
  r = String(r).trim();
  if (/^[\d.]+\/\d{1,2}$/.test(r)) { const [b, k] = r.split('/'); return ip4(b) != null && +k <= 32; }
  return ip4(r) != null || /^[0-9a-f:]+$/i.test(r);
}

module.exports = function createGateway({ getApi, save }) {
  const windows = new Map(); // keyId → { start, n }
  const lastSaved = new Map();

  function create({ name, role, ips = [], rate = 0, expiresDays = 0, createdBy = '' }) {
    if (!ROLES.includes(role)) throw new Error('สิทธิ์ของ API Key ไม่ถูกต้อง');
    const token = `stk_${crypto.randomBytes(24).toString('base64url')}`;
    const key = {
      id: crypto.randomBytes(5).toString('hex'), name, role, prefix: token.slice(0, 12), hash: sha(token),
      ips, rate: Math.max(0, Math.min(10000, Number(rate) || 0)), created: Date.now(), createdBy,
      expires: expiresDays > 0 ? Date.now() + expiresDays * 86400000 : null,
      enabled: true, lastUsed: null, lastIp: null, uses: 0,
    };
    getApi().keys.push(key); save();
    return { token, key };
  }
  /** ตรวจ Bearer token → { key } หรือ { error, status } */
  function verify(req, ip) {
    const h = String(req.headers.authorization || '');
    const m = h.match(/^Bearer\s+(stk_[A-Za-z0-9_-]{20,})$/);
    if (!m) return null;
    const api = getApi();
    if (!api.enabled) return { status: 403, error: 'ระบบปิดการเข้าถึงด้วย API Key อยู่ (ตั้งค่า → API)' };
    const hv = sha(m[1]);
    const key = api.keys.find((k) => k.hash.length === hv.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(hv)));
    if (!key) return { status: 401, error: 'API Key ไม่ถูกต้อง' };
    if (!key.enabled) return { status: 401, error: 'API Key นี้ถูกปิดใช้งาน' };
    if (key.expires && key.expires < Date.now()) return { status: 401, error: 'API Key หมดอายุแล้ว' };
    if (!ipAllowed(ip, key.ips)) return { status: 403, error: `IP ${normIp(ip)} ไม่ได้รับอนุญาตสำหรับ API Key นี้` };
    // rate limit (หน้าต่าง 60 วินาที)
    const limit = key.rate || api.defaultRate || 120;
    const now = Date.now();
    let w = windows.get(key.id);
    if (!w || now - w.start >= 60000) { w = { start: now, n: 0 }; windows.set(key.id, w); }
    w.n++;
    const rate = { limit, remaining: Math.max(0, limit - w.n), reset: Math.ceil((w.start + 60000 - now) / 1000) };
    if (w.n > limit) return { status: 429, error: `เรียก API เกินกำหนด ${limit} ครั้ง/นาที`, rate };
    key.lastUsed = now; key.lastIp = normIp(ip); key.uses = (key.uses || 0) + 1;
    if (now - (lastSaved.get(key.id) || 0) > 60000) { lastSaved.set(key.id, now); save(); }
    return { key, rate };
  }
  /** CORS: ตอบ header ให้ origin ที่อนุญาต · คืนค่า true ถ้าเป็น preflight ที่ตอบไปแล้ว */
  function cors(req, res) {
    const origin = req.headers.origin;
    if (!origin) return false;
    const list = getApi().cors || [];
    if (!list.includes('*') && !list.includes(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', list.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset');
    res.setHeader('Access-Control-Max-Age', '600');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    return false;
  }
  const view = (k) => ({ id: k.id, name: k.name, role: k.role, prefix: k.prefix, ips: k.ips, rate: k.rate, created: k.created, createdBy: k.createdBy,
    expires: k.expires, enabled: k.enabled, lastUsed: k.lastUsed, lastIp: k.lastIp, uses: k.uses || 0 });

  return { create, verify, cors, view, ipAllowed, validRule, ROLES };
};
module.exports.ipAllowed = ipAllowed;
module.exports.normIp = normIp;
