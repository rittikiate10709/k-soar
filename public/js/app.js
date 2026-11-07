'use strict';
/* ============================================================
   SMART TOPOLOGY — NOC front-end
   ============================================================ */
const STATUS = {
  online: { th: 'ออนไลน์', en: 'ONLINE', c: 'ok', color: '#12b07a' },
  warning: { th: 'ควรระวัง', en: 'WARNING', c: 'warn', color: '#f0a020' },
  offline: { th: 'ออฟไลน์', en: 'OFFLINE', c: 'bad', color: '#f0425f' },
  maintenance: { th: 'บำรุงรักษา', en: 'MAINT', c: 'maint', color: '#8b5cf6' },
  disabled: { th: 'ปิดการตรวจ', en: 'DISABLED', c: 'muted', color: '#94a3b8' },
  unknown: { th: 'รอตรวจสอบ', en: 'PENDING', c: 'muted', color: '#94a3b8' },
};
const SEV = { critical: { th: 'วิกฤต', c: 'bad' }, warning: { th: 'เตือน', c: 'warn' }, info: { th: 'ข้อมูล', c: 'info' } };
const ROLE_TH = { admin: 'ผู้ดูแลระบบ', operator: 'ผู้ปฏิบัติงาน', viewer: 'ผู้ดูอย่างเดียว' };

const S = {
  me: null, state: null, tab: store.get('nms_tab', 'dashboard'),
  mask: store.get('nms_mask', false),
  filter: { q: '', type: '', status: 'all' },
  view: store.get('nms_view', 'cards'),
  alertFilter: 'open',
  topo: store.get('nms_topo', { k: 1, x: 40, y: 80 }),
  dragging: false, connected: false, seenAlerts: new Set(), firstState: true,
};
const can = (role) => S.me && ({ viewer: 1, operator: 2, admin: 3 })[S.me.role] >= ({ viewer: 1, operator: 2, admin: 3 })[role];
const devs = () => (S.state ? S.state.devices : []);
const devById = (id) => devs().find((d) => d.id === id);
const fmtMs = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ms`);
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString('th-TH', { hour12: false }) : '—');
const fmtDT = (t) => (t ? new Date(t).toLocaleString('th-TH', { hour12: false, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s} วินาที`;
  if (s < 3600) return `${Math.floor(s / 60)} นาที`;
  if (s < 86400) return `${Math.floor(s / 3600)} ชม. ${Math.floor((s % 3600) / 60)} นาที`;
  return `${Math.floor(s / 86400)} วัน`;
}
function maskIp(ip) {
  if (!S.mask) return ip;
  const m = String(ip).match(/^(\d+\.\d+)\.\d+\.\d+$/);
  return m ? `${m[1]}.X.X` : String(ip).replace(/[^.:]+$/, 'X');
}
const target = (d) => maskIp(d.ip) + (d.method === 'tcp' ? `:${d.port}` : '');
const stPill = (s) => `<span class="pill ${STATUS[s]?.c || 'muted'}"><span class="sdot c-${STATUS[s]?.c || 'muted'}"></span>${STATUS[s]?.th || s}</span>`;
const isUp = (d) => d.status === 'online' || d.status === 'warning';
const monitored = () => devs().filter((d) => d.status !== 'disabled' && d.status !== 'maintenance');
function counts() {
  const c = { online: 0, warning: 0, offline: 0, maintenance: 0, disabled: 0, unknown: 0 };
  devs().forEach((d) => { c[d.status] = (c[d.status] || 0) + 1; });
  return c;
}
function activeAlerts() { return (S.state ? S.state.alerts : []).filter((a) => a.status !== 'resolved'); }

/* ---------------------------------------------------------- SVG charts */
function arc(cx, cy, r, a0, a1) {
  const p = (a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(a0), [x1, y1] = p(a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function gauge(pct, label, color) {
  const a0 = 135, span = 270, a1 = a0 + span * Math.min(1, Math.max(0, pct / 100));
  const kx = 100 + 74 * Math.cos((a1 * Math.PI) / 180), ky = 100 + 74 * Math.sin((a1 * Math.PI) / 180);
  return `<svg viewBox="0 0 200 175" width="220" height="190">
    <defs><linearGradient id="gg" x1="0" x2="1"><stop offset="0" stop-color="#f0425f"/><stop offset=".55" stop-color="#f0a020"/><stop offset="1" stop-color="#12b07a"/></linearGradient></defs>
    <path d="${arc(100, 100, 74, a0, a0 + span)}" stroke="var(--line2)" stroke-width="12" fill="none" stroke-linecap="round"/>
    ${pct > 0.3 ? `<path d="${arc(100, 100, 74, a0, a1)}" stroke="url(#gg)" stroke-width="12" fill="none" stroke-linecap="round"/>` : ''}
    <circle cx="${kx.toFixed(1)}" cy="${ky.toFixed(1)}" r="7" fill="var(--card)" stroke="var(--text)" stroke-width="2.5"/>
    <text x="100" y="98" text-anchor="middle" font-family="var(--mono)" font-size="24" font-weight="700" fill="var(--text)">${pct.toFixed(2)}%</text>
    <text x="100" y="118" text-anchor="middle" font-size="9.5" font-weight="700" letter-spacing=".08em" fill="${color}">${esc(label)}</text>
    <text x="40" y="170" font-family="var(--mono)" font-size="9" fill="var(--faint)">0%</text>
    <text x="100" y="18" text-anchor="middle" font-family="var(--mono)" font-size="9" fill="var(--faint)">50%</text>
    <text x="150" y="170" font-family="var(--mono)" font-size="9" fill="var(--faint)">100%</text></svg>`;
}
function spark(vals, { w = 400, h = 90, color = '#0e9b87', fill = true, min = null, max = null } = {}) {
  const v = vals.map((x) => (x == null || Number.isNaN(x) ? null : x));
  const nums = v.filter((x) => x != null);
  if (nums.length < 2) return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}"><text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" font-size="12" fill="var(--faint)">รอข้อมูลจากการตรวจสอบรอบถัดไป...</text></svg>`;
  const lo = min != null ? min : Math.min(...nums), hi = max != null ? max : Math.max(...nums);
  const rng = hi - lo || 1, step = w / Math.max(1, v.length - 1);
  const pts = v.map((x, i) => (x == null ? null : [i * step, h - 8 - ((x - lo) / rng) * (h - 16)]));
  let d = '', area = '', seg = [];
  const flush = () => {
    if (seg.length) {
      d += 'M' + seg.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
      if (fill && seg.length > 1) area += `M${seg[0][0].toFixed(1)} ${h}L` + seg.map((p) => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + `L${seg[seg.length - 1][0].toFixed(1)} ${h}Z`;
    }
    seg = [];
  };
  pts.forEach((p) => { if (p) seg.push(p); else flush(); });
  flush();
  const gaps = v.map((x, i) => (x == null ? `<rect x="${(i * step - step / 2).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${h}" fill="#f0425f" opacity=".08"/>` : '')).join('');
  const id = 'sg' + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".25"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    ${gaps}${fill ? `<path d="${area}" fill="url(#${id})"/>` : ''}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}
function donut(parts, total, label) {
  const r = 52, C = 2 * Math.PI * r;
  let off = 0;
  const segs = parts.filter((p) => p.v > 0).map((p) => {
    const len = (p.v / Math.max(1, total)) * C;
    const s = `<circle cx="70" cy="70" r="${r}" fill="none" stroke="${p.color}" stroke-width="18" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}" transform="rotate(-90 70 70)"/>`;
    off += len; return s;
  }).join('');
  return `<svg viewBox="0 0 140 140" width="150" height="150"><circle cx="70" cy="70" r="${r}" fill="none" stroke="var(--line2)" stroke-width="18"/>${segs}
    <text x="70" y="72" text-anchor="middle" font-family="var(--mono)" font-size="26" font-weight="700" fill="var(--text)">${total}</text>
    <text x="70" y="90" text-anchor="middle" font-size="9" fill="var(--brand)">${esc(label)}</text></svg>`;
}

/* ---------------------------------------------------------- Header */
function renderHeader() {
  const site = S.state?.settings?.siteName || '';
  $('#brand').innerHTML = `${logoHtml()}<div style="min-width:0"><h1>SMART TOPOLOGY <span class="noc">${icon('activity', 10)} NOC</span></h1><p>ระบบจำลองศูนย์ข้อมูลและอุปกรณ์เครือข่าย${site ? ' · ' + esc(site) : ''}</p></div>`;
  const n = activeAlerts().length;
  const dark = document.documentElement.dataset.theme === 'dark';
  $('#tools').innerHTML = `
    <button class="ibtn ${S.mask ? 'on' : ''}" data-act="mask" title="ซ่อน/แสดง IP (IP Mask)">${icon(S.mask ? 'eyeoff' : 'eye', 17)}</button>
    <button class="ibtn hide-sm" data-act="tab" data-tab="topology" title="Topology">${icon('network', 17)}<span class="dot"></span></button>
    <button class="ibtn hide-sm" data-act="tab" data-tab="devices" title="อุปกรณ์">${icon('server', 17)}</button>
    <button class="ibtn" data-act="checkall" title="ตรวจสอบทุกอุปกรณ์ทันที">${icon('refresh', 17)}</button>
    <button class="ibtn hide-sm" data-act="fullscreen" title="เต็มจอ">${icon('maximize', 17)}</button>
    <button class="ibtn" data-act="theme" title="สลับโหมดสว่าง/มืด">${icon(dark ? 'sun' : 'moon', 17)}</button>
    <button class="btn notif" data-act="tab" data-tab="alerts">${icon('bell', 16)} <span class="hide-sm">Notification</span> <b>${n}</b></button>
    ${can('operator') ? `<button class="btn primary" data-act="add">${icon('plus', 16)} เพิ่มอุปกรณ์</button>` : ''}
    <div class="userchip" title="${esc(ROLE_TH[S.me.role])}">${icon('user', 16)}<span class="hide-sm">${esc(S.me.name)}</span><span class="role">${esc(S.me.role)}</span>
      <button class="ibtn" style="width:28px;height:28px;border:0" data-act="logout" title="ออกจากระบบ">${icon('logout', 16)}</button></div>`;
}
function renderStatus() {
  const st = S.state, t = st.trend[st.trend.length - 1];
  $('#statusbar').innerHTML = `
    <span class="pulse ${S.connected ? '' : 'bad'}"></span><b>${S.connected ? 'Monitoring' : 'กำลังเชื่อมต่อใหม่...'}</b><span class="sep"></span>
    <span class="mono muted">#${st.cycle} ICMP/TCP</span>
    <span class="mono" style="color:var(--brand)">${icon('refresh', 13, S.connected ? 'spin' : '')} ทุก ${st.settings.intervalSec} วินาที</span>
    <span style="margin-left:auto" class="mono muted">Latency <b style="color:var(--brand)">${t && t.avg != null ? t.avg.toFixed(2) + 'ms' : '—'}</b></span><span class="sep"></span>
    <span class="mono muted">ตรวจล่าสุด ${fmtTime(st.lastCycleAt)}</span><span class="sep"></span>
    <span class="mono" id="clock">${fmtTime(Date.now())}</span>`;
}
function renderKpis() {
  const D = devs(), c = counts(), mon = monitored();
  const up = mon.filter(isUp).length, avail = mon.length ? (up / mon.length) * 100 : 0;
  const core = D.find((d) => d.type === 'core') || D.find((d) => d.type === 'switch');
  const his = D.find((d) => d.type === 'database') || D.find((d) => d.type === 'server');
  const ds = S.state.dbsync || {};
  const DSL = { sync: ['Active', 'ok'], lag: ['Lag', 'warn'], diff: ['Diff', 'warn'], warning: ['ระวัง', 'warn'], broken: ['Broken', 'bad'], offline: ['Offline', 'bad'], norepl: ['No Repl', 'bad'], pending: ['รอตรวจ', 'muted'] };
  const hisCard = ds.configured
    ? `<div class="card kpi" data-act="tab" data-tab="dbsync" style="cursor:pointer"><div class="h">ระบบสารสนเทศโรงพยาบาล ${icon('database', 18)}</div>
      <div class="t" style="display:flex;gap:8px;align-items:center"><span style="color:var(--brand)">HIS Master &amp; Slave</span><span class="pill ${(DSL[ds.code] || DSL.pending)[1]}">${(DSL[ds.code] || DSL.pending)[0]}</span></div>
      <div class="row"><span>Replication Delay</span><span class="mono" style="color:${ds.lag == null ? 'var(--muted)' : 'var(--brand)'}">${ds.lag == null ? '—' : `${ds.lag} วินาที`}</span></div></div>`
    : `<div class="card kpi" ${his ? `data-act="detail" data-id="${his.id}" style="cursor:pointer"` : ''}><div class="h">ระบบสารสนเทศโรงพยาบาล ${icon('database', 18)}</div>
      ${his ? `<div class="t" style="display:flex;gap:8px;align-items:center"><span style="color:var(--brand);overflow:hidden;text-overflow:ellipsis">${esc(his.name)}</span>${stPill(his.status)}</div>
      <div class="row"><span>${his.method === 'tcp' ? `ตรวจพอร์ต ${his.port}` : 'ICMP'}</span><span class="mono">${fmtMs(his.latency)}</span></div>`
      : `<div class="t muted" style="font-weight:500;font-size:14px">ยังไม่ได้กำหนด Server / Database</div><div class="row">ตั้งค่าที่แท็บ “ฐานข้อมูล Master/Slave”</div>`}</div>`;
  const t = S.state.trend[S.state.trend.length - 1];
  const lossAll = mon.length ? Math.round((mon.filter((d) => d.status === 'offline').length / mon.length) * 1000) / 10 : 0;
  const vlans = new Set(D.map((d) => d.vlan).filter(Boolean)).size;
  const wan = D.filter((d) => d.type === 'isp');
  const nA = activeAlerts().length;
  const devBox = (d, ic, title) => `<div class="card kpi" ${d ? `data-act="detail" data-id="${d.id}" style="cursor:pointer"` : ''}>
      <div class="h">${title}${icon(ic, 18)}</div>
      ${d ? `<div class="t">${esc(d.name)} <span class="mono" style="font-size:12px;color:var(--brand);font-weight:500">${esc(TYPE_INFO[d.type]?.label || '')}</span></div>
      <div class="row"><span style="display:flex;align-items:center;gap:6px;min-width:0"><span class="sdot c-${STATUS[d.status].c}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.model || d.vendor || STATUS[d.status].th)}</span></span><span class="mono">${esc(target(d))}</span></div>`
      : `<div class="t muted" style="font-weight:500;font-size:14px">ยังไม่มีอุปกรณ์ประเภทนี้</div><div class="row">เพิ่มได้จากปุ่ม “เพิ่มอุปกรณ์”</div>`}</div>`;
  $('#kpis').innerHTML = `
    <div class="card kpi"><div class="h">อุปกรณ์ในเครือข่าย ${icon('network', 18)}</div>
      <div class="v">${D.length}<small style="color:var(--brand)">Availability ${avail.toFixed(0)}%</small></div>
      <div class="row" style="justify-content:flex-start"><span class="pill ok"><span class="sdot c-ok"></span>Online ${c.online + c.warning}</span><span class="pill bad"><span class="sdot c-bad"></span>Offline ${c.offline}</span></div></div>
    ${devBox(core, 'zap', 'Core Switch')}
    ${hisCard}
    <div class="card kpi"><div class="h">ความเร็วตอบสนองเฉลี่ย ${icon('activity', 18)}</div>
      <div class="v">${t && t.avg != null ? t.avg.toFixed(2) : '—'}<small>ms</small></div>
      <div class="row"><span>Device Loss</span><span class="mono">${lossAll.toFixed(1)}%</span></div></div>
    <div class="card kpi" data-act="tab" data-tab="alerts" style="cursor:pointer"><div class="h">ความปลอดภัย / แจ้งเตือน ${icon('shield', 18)}</div>
      <div class="v">${vlans}<small>VLANs</small><span class="pill ${nA ? 'warn' : 'ok'}" style="margin-left:auto;font-family:var(--sans)">${nA} Alerts</span></div>
      <div class="row"><span>WAN / Uplink</span><span class="mono" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${wan.length ? wan.map((w) => `${esc(w.name.split(' ')[0])} ${w.status === 'online' || w.status === 'warning' ? '●' : '○'}`).join(' / ') : '—'}</span></div></div>`;
}
function renderNav() {
  const c = counts(), tabs = [
    ['dashboard', 'dashboard', 'ภาพรวม'], ['topology', 'network', 'Network Topology'], ['devices', 'server', 'อุปกรณ์', devs().length],
    ['alerts', 'bell', 'การแจ้งเตือน', activeAlerts().length], ['reports', 'chart', 'รายงาน / สถิติ'], ['dbsync', 'database', 'ฐานข้อมูล Master/Slave'], ['inventory', 'monitor', 'ทะเบียนคอมพิวเตอร์'], ['ipscan', 'scan', 'สแกน IP'], ['wazuh', 'shield', 'Wazuh SIEM'], ...(can('admin') ? [['users', 'users', 'ผู้ใช้งาน']] : []), ['settings', 'sliders', 'ตั้งค่า']];
  $('#nav').innerHTML = tabs.map(([k, ic, l, n]) => `<button class="tab ${S.tab === k ? 'active' : ''}" data-act="tab" data-tab="${k}">${icon(ic, 16)} ${l}${n != null ? ` <span class="cnt">${n}</span>` : ''}</button>`).join('')
    + `<span class="grow"></span><span class="chips">
      <span class="pill ok">ปกติ ${c.online}</span><span class="pill warn">ควรระวัง ${c.warning}</span><span class="pill bad">ออฟไลน์ ${c.offline}</span><span class="pill maint">บำรุงรักษา ${c.maintenance}</span><span class="pill muted">ปิดตรวจ ${c.disabled}</span></span>`;
}

/* ---------------------------------------------------------- Dashboard */
function vDashboard() {
  const st = S.state, D = devs(), mon = monitored(), c = counts();
  if (!D.length) return emptyState();
  const up = mon.filter(isUp).length, avail = mon.length ? (up / mon.length) * 100 : 0;
  const tgt = st.settings.slaTarget;
  const [glabel, gcol] = avail >= tgt ? ['HEALTHY', '#0e9b87'] : avail >= 90 ? ['DEGRADED', '#f0425f'] : ['CRITICAL', '#f0425f'];
  const tr = st.trend, last = tr[tr.length - 1] || {};
  const avgs = tr.map((x) => x.avg).filter((x) => x != null);
  const lats = mon.map((d) => d.latency).filter((x) => x != null);
  const availTrend = tr.map((x) => (x.total ? (x.up / x.total) * 100 : null));
  const AA = activeAlerts(), sev = { critical: 0, warning: 0, info: 0 };
  AA.forEach((a) => { sev[a.severity] = (sev[a.severity] || 0) + 1; });
  const resolved = st.alerts.filter((a) => a.status === 'resolved').length;
  // histogram
  const B = [
    ['< 5ms', mon.filter((d) => d.latency != null && d.latency < 5).length, '#12b07a'],
    ['5-30ms', mon.filter((d) => d.latency >= 5 && d.latency < 30).length, '#14b8a6'],
    ['30-100ms', mon.filter((d) => d.latency >= 30 && d.latency < 100).length, '#1aa3e8'],
    ['> 100ms', mon.filter((d) => d.latency >= 100).length, '#f0a020'],
    ['Loss', mon.filter((d) => d.latency == null).length, '#f0425f']];
  const bmax = Math.max(1, ...B.map((b) => b[1]));
  const parts = [
    { k: 'online', v: c.online, color: '#12b07a' }, { k: 'warning', v: c.warning, color: '#f0a020' },
    { k: 'offline', v: c.offline, color: '#f0425f' }, { k: 'maintenance', v: c.maintenance, color: '#8b5cf6' },
    { k: 'disabled', v: c.disabled + c.unknown, color: '#94a3b8' }];
  const pc = (n) => (D.length ? Math.round((n / D.length) * 100) : 0);
  const crit = topoOrder(D.filter((d) => d.critical));
  const slow = [...mon].filter((d) => d.latency != null).sort((a, b) => b.latency - a.latency).slice(0, 7);
  const recent = [...st.alerts].reverse().slice(0, 7);
  const typeCount = {};
  D.forEach((d) => { typeCount[d.type] = (typeCount[d.type] || 0) + 1; });

  return `
  <div class="grid g4">
    <div class="card panel"><div class="ph"><h3>Network Availability SLA</h3><span class="right">${icon('shield', 17)}</span></div>
      <div class="gauge-wrap">${gauge(avail, glabel, gcol)}</div>
      <div class="foot"><span>Online: ${up}/${mon.length} จุด</span><span class="mono">เป้าหมาย: ${tgt}%</span></div></div>
    <div class="card panel"><div class="ph"><h3>ICMP RTT &amp; Jitter Trend</h3><span class="right">${icon('gauge', 17)}</span></div>
      <div class="big">${last.avg != null ? last.avg.toFixed(2) : '—'} <small>ms (Avg) ±${last.jitter != null ? last.jitter.toFixed(2) : '0'} ms</small></div>
      <div class="mini-stats"><span>Waveform (${tr.length} Samples)</span><span>Min: <b>${avgs.length ? Math.min(...avgs).toFixed(2) : '—'}ms</b></span><span>Max: <b>${avgs.length ? Math.max(...avgs).toFixed(2) : '—'}ms</b></span></div>
      <div class="chartbox">${spark(tr.map((x) => x.avg), { h: 92 })}</div></div>
    <div class="card panel"><div class="ph"><h3>Availability Trend</h3><span class="right">${icon('activity', 17)}</span></div>
      <div class="big">${up}<small> / ${mon.length} อุปกรณ์ตอบสนอง</small></div>
      <div class="mini-stats"><span>ค่าเฉลี่ยช่วงนี้: <b>${availTrend.filter((x) => x != null).length ? (availTrend.filter((x) => x != null).reduce((a, b) => a + b, 0) / availTrend.filter((x) => x != null).length).toFixed(1) : '—'}%</b></span><span>Latency อุปกรณ์: <b>${lats.length ? Math.min(...lats).toFixed(1) : '—'}–${lats.length ? Math.max(...lats).toFixed(1) : '—'}ms</b></span></div>
      <div class="chartbox">${spark(availTrend, { h: 92, color: '#1aa3e8', min: 0, max: 100 })}</div></div>
    <div class="card panel"><div class="ph"><h3>NOC Alerts</h3><span class="right" style="color:var(--warn)">${icon('alert', 17)}</span></div>
      <div style="display:flex;align-items:baseline;gap:10px"><span class="big" style="color:#e08a00">${AA.length}</span><span>Active Alerts</span><span class="mono faint" style="font-size:11px">Total: ${st.alerts.length}</span></div>
      <div class="mini-stats" style="justify-content:space-between"><span>Severity Distribution</span><b style="color:#d0284a">${AA.length} Active</b></div>
      <div class="sevbar">${AA.length ? `<span style="width:${(sev.critical / AA.length) * 100}%;background:#f0425f"></span><span style="width:${(sev.warning / AA.length) * 100}%;background:#f0a020"></span><span style="width:${(sev.info / AA.length) * 100}%;background:#1aa3e8"></span>` : '<span style="width:100%;background:#12b07a"></span>'}</div>
      <div class="sevs"><div class="sev critical">Critical<b>${sev.critical}</b></div><div class="sev warning">Warning<b>${sev.warning}</b></div><div class="sev info">Info<b>${sev.info}</b></div><div class="sev resolved">Resolved<b>${resolved}</b></div></div>
      <div class="foot"><a href="#" data-act="tab" data-tab="alerts">จัดการการแจ้งเตือน ›</a><span class="mono faint">${resolved}/${st.alerts.length} Resolved</span></div></div>
  </div>

  <div class="grid g2">
    <div class="card panel"><div class="ph"><h3>${icon('radio', 17)}<span class="th">การกระจายตัวของความหน่วง</span><span class="bar"></span>ICMP Latency Histogram</h3><span class="right">${mon.length} Devices</span></div>
      <div class="histo">${B.map(([l, n, col]) => `<div class="hcol"><span class="n" style="color:${col};border-color:${col}55;background:${col}12">${n}</span>
        <div class="box"><div class="fill" style="height:${n ? Math.max(4, (n / bmax) * 100) : 4}%;background:${col}${n ? '' : '55'}"></div></div>
        <div class="lb">${l}</div><div class="pc">${mon.length ? Math.round((n / mon.length) * 100) : 0}%</div></div>`).join('')}</div>
      <div class="foot"><span>เกณฑ์สากล ITU-T Y.1541 Class 0: &lt; 100ms</span><span class="mono">${B[3][1] + B[4][1] === 0 ? 'CARRIER GRADE PASS' : 'NEEDS ATTENTION'}</span></div></div>
    <div class="card panel"><div class="ph"><h3>${icon('pie', 17)}<span class="th">สัดส่วนสถานะอุปกรณ์ทั้งระบบ</span><span class="bar"></span>Device Status Breakdown</h3><span class="right" style="color:var(--brand)">Topology Health</span></div>
      <div class="donut-row">${donut(parts, D.length, 'อุปกรณ์ทั้งหมด')}
        <div class="legend">${[['online', 'Online'], ['warning', 'Warning'], ['offline', 'Offline'], ['maintenance', 'Maintenance'], ['disabled', 'Disabled / Pending']].map(([k, l]) => {
    const n = k === 'disabled' ? c.disabled + c.unknown : c[k];
    return `<div class="lg"><span class="sdot c-${STATUS[k].c}"></span>${l}<span class="v">${n} <small>(${pc(n)}%)</small></span></div>`;
  }).join('')}</div></div>
      <div class="foot" style="background:var(--soft);border:1px solid var(--line2);border-radius:5px;padding:9px 12px"><span>${icon('check', 14)} อุปกรณ์พร้อมทำงาน: ${c.online + c.warning} ตัว (${pc(c.online + c.warning)}%)</span><span class="mono">${Object.entries(typeCount).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${TYPE_INFO[k]?.label || k}: ${n}`).join(' · ')}</span></div></div>
  </div>

  <div class="card panel" style="margin-bottom:14px"><div class="ph"><h3>${icon('route', 17)}<span class="th">เส้นทางหลักของโครงข่าย</span><span class="bar"></span>Critical Path Pipeline</h3><span class="right" style="color:var(--brand)">End-to-End Flow</span></div>
    ${crit.length ? `<div class="pipeline">${crit.map((d, i) => `<div class="pipe ${STATUS[d.status].c}" data-act="detail" data-id="${d.id}">
      <div class="k">${i + 1}. ${esc(TYPE_INFO[d.type]?.label || d.type)}</div><div class="n">${esc(d.name)}</div>
      <div class="b"><span>${esc(target(d))}</span><span>${d.status === 'offline' ? 'LOSS' : d.status === 'online' || d.status === 'warning' ? fmtMs(d.latency) : STATUS[d.status].en}</span></div></div>`).join('')}</div>`
    : `<div class="empty">ยังไม่มีอุปกรณ์ที่ทำเครื่องหมาย “อุปกรณ์สำคัญ (Critical Path)” — แก้ไขอุปกรณ์แล้วเลือกตัวเลือกนี้</div>`}</div>

  <div class="grid g2">
    <div class="card panel"><div class="ph"><h3>${icon('bell', 17)}<span class="th">เหตุการณ์ล่าสุด</span><span class="bar"></span>Recent Events</h3><span class="right"><a href="#" data-act="tab" data-tab="alerts">ดูทั้งหมด ›</a></span></div>
      ${recent.length ? `<div class="list">${recent.map(alertRow).join('')}</div>` : `<div class="empty">${icon('check', 26)}<div>ยังไม่มีเหตุการณ์</div></div>`}</div>
    <div class="card panel"><div class="ph"><h3>${icon('activity', 17)}<span class="th">อุปกรณ์ที่ตอบสนองช้าที่สุด</span><span class="bar"></span>Top Latency</h3><span class="right">เกณฑ์เตือน ${st.settings.warnMs} ms</span></div>
      ${slow.length ? `<div class="list">${slow.map((d) => `<div class="li" data-act="detail" data-id="${d.id}" style="cursor:pointer"><span class="sdot c-${STATUS[d.status].c}"></span>
        <div class="main"><div>${esc(d.name)}</div><div class="sub mono">${esc(target(d))} · ${esc(d.location || TYPE_INFO[d.type]?.th || '')}</div></div>
        <div style="width:110px">${spark(d.history.slice(-20), { w: 110, h: 26, fill: false, color: STATUS[d.status].color })}</div>
        <b class="mono" style="width:76px;text-align:right;color:${STATUS[d.status].color}">${fmtMs(d.latency)}</b></div>`).join('')}</div>` : `<div class="empty">ยังไม่มีข้อมูล latency</div>`}</div>
  </div>`;
}
function alertRow(a) {
  const s = SEV[a.severity] || SEV.info;
  return `<div class="li"><span class="pill ${a.status === 'resolved' ? 'ok' : s.c}" style="width:76px;justify-content:center">${a.status === 'resolved' ? 'แก้ไขแล้ว' : s.th}</span>
    <div class="main"><div>${esc(a.message)}</div><div class="sub">${fmtDT(a.created)}${a.resolvedAt ? ` → ฟื้นตัว ${fmtTime(a.resolvedAt)}` : ` · นาน ${ago(a.created)}`}${a.ackBy ? ` · รับทราบโดย ${esc(a.ackBy)}` : ''}</div></div></div>`;
}
function emptyState() {
  return `<div class="card panel"><div class="empty" style="padding:60px 20px">${icon('network', 40)}
    <h2 style="color:var(--text);margin:10px 0 6px">ยังไม่มีอุปกรณ์ในระบบ</h2>
    <p>เริ่มต้นด้วยการเพิ่ม Switch / Router / Server หรือ IP ที่ต้องการเฝ้าระวัง</p>
    ${can('operator') ? `<div style="display:flex;gap:10px;justify-content:center;margin-top:18px;flex-wrap:wrap">
      <button class="btn primary" data-act="add">${icon('plus', 16)} เพิ่มอุปกรณ์</button>
      <button class="btn" data-act="add" data-mode="bulk">${icon('upload', 16)} เพิ่มหลายรายการ (CSV)</button>
      <button class="btn" data-act="demo">${icon('wand', 16)} โหลดข้อมูลตัวอย่าง</button></div>` : '<p>กรุณาติดต่อผู้ดูแลระบบเพื่อเพิ่มอุปกรณ์</p>'}</div></div>`;
}
function topoOrder(list) {
  const depth = (d) => { let n = 0, cur = d, g = 0; while (cur && cur.parentId && g++ < 50) { cur = devById(cur.parentId); n++; } return n; };
  return [...list].sort((a, b) => depth(a) - depth(b) || a.name.localeCompare(b.name, 'th'));
}

/* ---------------------------------------------------------- Topology */
const NW = 210, NH = 70;
function layout(D) {
  const pos = {}, kids = new Map(), ids = new Set(D.map((d) => d.id));
  D.forEach((d) => { const p = ids.has(d.parentId) ? d.parentId : null; if (!kids.has(p)) kids.set(p, []); kids.get(p).push(d); });
  let leaf = 0; const seen = new Set();
  const place = (d, depth) => {
    if (seen.has(d.id)) return; seen.add(d.id);
    const ch = (kids.get(d.id) || []);
    if (!ch.length) { pos[d.id] = { x: leaf * (NW + 30), y: depth * 150 }; leaf++; return; }
    ch.forEach((k) => place(k, depth + 1));
    const xs = ch.filter((k) => pos[k.id]).map((k) => pos[k.id].x);
    pos[d.id] = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: depth * 150 };
  };
  (kids.get(null) || []).forEach((r) => place(r, 0));
  D.forEach((d) => { if (!pos[d.id]) place(d, 0); });
  D.forEach((d) => { if (Number.isFinite(d.x) && Number.isFinite(d.y)) pos[d.id] = { x: d.x, y: d.y }; });
  return pos;
}
function vTopology() {
  const D = devs();
  if (!D.length) return emptyState();
  return `<div class="card topo-card">
    <div class="topo-bar"><span class="sdot c-ok"></span><b>NETWORK TOPOLOGY</b><span class="muted">| ${D.length} Devices | <span id="zoomPct">${Math.round(S.topo.k * 100)}%</span> Zoom</span></div>
    <div class="topo-tools">
      <button class="ibtn" data-act="tfit" title="จัดให้พอดีจอ">${icon('scan', 17)}</button>
      <button class="ibtn" data-act="tzoom" data-z="1.2" title="ขยาย">${icon('zoomin', 17)}</button>
      <button class="ibtn" data-act="tzoom" data-z="0.83" title="ย่อ">${icon('zoomout', 17)}</button>
      ${can('operator') ? `<button class="ibtn" data-act="treset" title="จัดวางอัตโนมัติใหม่">${icon('rotate', 17)}</button>` : ''}
    </div>
    <svg id="topo"><g id="topoG"></g></svg>
    <div class="topo-legend"><span><span class="sdot c-ok"></span> Link Up</span><span><span class="sdot c-bad"></span> Link Down</span><span><span class="sdot c-warn"></span> Latency สูง</span><span>${can('operator') ? 'ลากโหนดเพื่อจัดวาง · ' : ''}ลากพื้นหลังเพื่อเลื่อน · Scroll เพื่อซูม · คลิกโหนดเพื่อดูรายละเอียด</span></div>
  </div>`;
}
function drawTopology() {
  const g = $('#topoG'); if (!g) return;
  const D = devs(); S.pos = layout(D);
  const P = S.pos;
  let links = '', labels = '', nodes = '';
  D.forEach((d) => {
    const p = devById(d.parentId); if (!p || !P[p.id] || !P[d.id]) return;
    const a = P[p.id], b = P[d.id];
    const x1 = a.x + NW / 2, y1 = a.y + NH, x2 = b.x + NW / 2, y2 = b.y;
    const down = d.status === 'offline' || p.status === 'offline';
    const idle = ['disabled', 'maintenance', 'unknown'].includes(d.status);
    const cls = down ? 'down' : idle ? 'idle' : 'up';
    const my = (y1 + y2) / 2;
    links += `<path class="lnk ${cls}" d="M${x1} ${y1}C${x1} ${my},${x2} ${my},${x2} ${y2}"/>`;
    const txt = down ? 'LINK DOWN' : idle ? STATUS[d.status].en : (d.linkLabel || (d.status === 'warning' ? 'HIGH LATENCY' : 'LINK UP'));
    const col = down ? '#ef4462' : idle ? '#94a3b8' : d.status === 'warning' ? '#e08a00' : '#0f9d77';
    const tw = txt.length * 5.6 + 12;
    labels += `<g class="lbl" transform="translate(${(x1 + x2) / 2 - tw / 2},${my - 8})"><rect width="${tw}" height="15" rx="2" fill="var(--card)" stroke="${col}"/><text x="${tw / 2}" y="10.5" text-anchor="middle" fill="${col}">${esc(txt)}</text></g>`;
  });
  D.forEach((d) => {
    const p = P[d.id]; if (!p) return;
    const st = STATUS[d.status], vc = vendorColor(d.vendor);
    const vend = String(d.vendor || TYPE_INFO[d.type]?.label || '').toUpperCase().slice(0, 9);
    const vw = vend.length * 5.4 + 8;
    const name = d.name.length > 26 ? d.name.slice(0, 25) + '…' : d.name;
    const loc = String(d.location || TYPE_INFO[d.type]?.th || '').slice(0, 20);
    const light = d.type === 'firewall';
    const ports = Array.from({ length: 12 }, (_, i) => `<rect x="${8 + i * 7.5}" y="30" width="5.5" height="5" rx=".6" fill="${light ? '#5b6779' : '#2b3850'}"/><rect x="${9.5 + i * 7.5}" y="27.4" width="2.4" height="1.4" fill="${d.status === 'online' ? '#12b07a' : d.status === 'offline' ? '#475569' : st.color}"/>`).join('');
    nodes += `<g class="tnode" data-id="${d.id}" transform="translate(${p.x},${p.y})">
      <rect class="nbody" width="${NW}" height="${NH}" rx="4" fill="${light ? '#eef1f5' : 'var(--node)'}" stroke="${d.status === 'offline' ? '#7f2333' : light ? '#cbd5e1' : 'var(--node-line)'}" stroke-width="1.5"/>
      <rect x="7" y="8" width="${vw}" height="11" rx="1.5" fill="${vc}"/><text x="11" y="16.5" font-family="monospace" font-size="7" font-weight="700" fill="#fff">${esc(vend)}</text>
      <text x="${vw + 12}" y="17" font-size="10" font-weight="600" fill="${light ? '#111827' : '#e5edf7'}">${esc(name)}</text>
      <circle cx="${NW - 9}" cy="12" r="4" fill="${st.color}"/>
      ${ports}
      <rect x="${NW - 56}" y="27" width="48" height="11" rx="2" fill="${light ? '#e0f2ef' : '#0b2a28'}" stroke="#15524a"/><text x="${NW - 32}" y="35" text-anchor="middle" font-family="monospace" font-size="6.5" fill="#2dd4bf">${d.method === 'tcp' ? 'TCP:' + d.port : 'ICMP'}</text>
      <text x="8" y="59" font-family="monospace" font-size="9" fill="${light ? '#334155' : '#cbd5e1'}">${esc(maskIp(d.ip))}</text>
      <text x="${NW - 8}" y="59" text-anchor="end" font-size="8" fill="${light ? '#64748b' : '#8193ab'}">${esc(d.status === 'online' || d.status === 'warning' ? fmtMs(d.latency) : loc)}</text>
      <title>${esc(d.name)} · ${esc(d.ip)} · ${st.th}</title></g>`;
  });
  g.innerHTML = links + labels + nodes;
  applyTopoTransform();
}
function applyTopoTransform() {
  const g = $('#topoG'); if (!g) return;
  g.setAttribute('transform', `translate(${S.topo.x},${S.topo.y}) scale(${S.topo.k})`);
  const z = $('#zoomPct'); if (z) z.textContent = Math.round(S.topo.k * 100) + '%';
  store.set('nms_topo', S.topo);
}
function topoFit() {
  const svg = $('#topo'); if (!svg || !S.pos) return;
  const pts = Object.values(S.pos); if (!pts.length) return;
  const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x)) + NW;
  const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y)) + NH;
  const W = svg.clientWidth, H = svg.clientHeight, pad = 70;
  const k = Math.min(1.4, Math.max(0.2, Math.min((W - pad * 2) / (maxX - minX || 1), (H - pad * 2 - 30) / (maxY - minY || 1))));
  S.topo = { k, x: (W - (maxX - minX) * k) / 2 - minX * k, y: pad + 20 + ((H - pad * 2 - 30) - (maxY - minY) * k) / 2 - minY * k };
  applyTopoTransform();
}
function bindTopology() {
  const svg = $('#topo'); if (!svg) return;
  let mode = null, start = null, node = null, moved = false;
  const pt = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  svg.addEventListener('pointerdown', (e) => {
    const n = e.target.closest('.tnode');
    const p = pt(e); moved = false;
    if (n) {
      node = +n.dataset.id; const np = S.pos[node];
      mode = 'node'; start = { px: p.x, py: p.y, x: np.x, y: np.y, el: n };
    } else { mode = 'pan'; start = { px: p.x, py: p.y, x: S.topo.x, y: S.topo.y }; svg.classList.add('panning'); }
    svg.setPointerCapture(e.pointerId); S.dragging = true;
  });
  svg.addEventListener('pointermove', (e) => {
    if (!mode) return;
    const p = pt(e), dx = p.x - start.px, dy = p.y - start.py;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    if (mode === 'pan') { S.topo.x = start.x + dx; S.topo.y = start.y + dy; applyTopoTransform(); }
    else if (mode === 'node' && moved && can('operator')) {
      const np = { x: Math.round(start.x + dx / S.topo.k), y: Math.round(start.y + dy / S.topo.k) };
      const d = devById(node); if (d) { d.x = np.x; d.y = np.y; }
      drawTopology();
    }
  });
  const end = async () => {
    if (!mode) return;
    svg.classList.remove('panning');
    const m = mode; mode = null; S.dragging = false;
    if (m === 'node') {
      if (!moved) openDetail(node);
      else if (can('operator')) { const d = devById(node); api('PUT', `/api/devices/${node}/position`, { x: d.x, y: d.y }).catch((e) => toast(e.message, 'bad')); }
    }
  };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
  svg.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = pt(e), f = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(p.x, p.y, f);
  }, { passive: false });
}
function zoomAt(px, py, f) {
  const k = Math.min(2.5, Math.max(0.15, S.topo.k * f)), r = k / S.topo.k;
  S.topo = { k, x: px - (px - S.topo.x) * r, y: py - (py - S.topo.y) * r };
  applyTopoTransform();
}

/* ---------------------------------------------------------- Devices */
function vDevicesSkeleton() {
  const types = Object.entries(TYPE_INFO).map(([k, v]) => `<option value="${k}" ${S.filter.type === k ? 'selected' : ''}>${v.label} — ${v.th}</option>`).join('');
  return `<div class="card panel" style="margin-bottom:14px">
    <div class="toolbar" style="margin:0">
      <div class="field" style="flex:2;min-width:240px">${icon('search', 16)}<input class="inp" id="fq" placeholder="ค้นหาชื่อ, IP, รุ่น, ตำแหน่ง, VLAN..." value="${esc(S.filter.q)}"></div>
      <select class="sel" id="ft" style="flex:1;min-width:200px;height:40px"><option value="">ทุกประเภทอุปกรณ์ (All Devices)</option>${types}</select>
      <div class="seg"><button data-act="view" data-v="cards" class="${S.view === 'cards' ? 'on' : ''}" title="มุมมองการ์ด">${icon('grid', 16)}</button><button data-act="view" data-v="table" class="${S.view === 'table' ? 'on' : ''}" title="มุมมองตาราง">${icon('list', 16)}</button></div>
      ${can('operator') ? `<button class="btn primary" data-act="add">${icon('plus', 16)} เพิ่มอุปกรณ์ / IP</button><button class="btn" data-act="add" data-mode="bulk">${icon('upload', 16)} นำเข้า CSV</button>` : ''}
      <a class="btn" href="/api/export.csv">${icon('download', 16)} ส่งออก</a>
    </div>
    <div class="chips" style="margin-top:12px" id="fchips"></div>
  </div><div id="dlist"></div>`;
}
function filtered() {
  const q = S.filter.q.trim().toLowerCase();
  return devs().filter((d) => (!S.filter.type || d.type === S.filter.type)
    && (S.filter.status === 'all' || d.status === S.filter.status || (S.filter.status === 'disabled' && d.status === 'unknown'))
    && (!q || [d.name, d.ip, d.model, d.vendor, d.location, d.vlan, d.code, d.mac, d.description].some((v) => String(v || '').toLowerCase().includes(q))));
}
function vDevicesList() {
  const c = counts();
  const ch = [['all', 'ทั้งหมด', devs().length], ['online', 'ปกติ', c.online], ['warning', 'ควรระวัง', c.warning], ['offline', 'ออฟไลน์', c.offline], ['maintenance', 'บำรุงรักษา', c.maintenance], ['disabled', 'ปิดตรวจ', c.disabled + c.unknown]];
  $('#fchips').innerHTML = ch.map(([k, l, n]) => `<button class="chip ${S.filter.status === k ? 'on' : ''}" data-act="fst" data-s="${k}">${k !== 'all' ? `<span class="sdot c-${STATUS[k].c}"></span>` : ''}${l} <span class="mono">${n}</span></button>`).join('');
  const L = filtered();
  if (!devs().length) { $('#dlist').innerHTML = emptyState(); return; }
  if (!L.length) { $('#dlist').innerHTML = `<div class="card"><div class="empty">${icon('search', 26)}<div>ไม่พบอุปกรณ์ตามเงื่อนไขที่ค้นหา</div></div></div>`; return; }
  if (S.view === 'table') {
    $('#dlist').innerHTML = `<div class="card tblwrap"><table class="tbl"><thead><tr><th>สถานะ</th><th>รหัส / ชื่ออุปกรณ์</th><th>IP / เป้าหมาย</th><th>ประเภท</th><th>ตำแหน่ง</th><th>VLAN</th><th>Uplink</th><th>Latency</th><th>Loss</th><th>ตรวจล่าสุด</th><th></th></tr></thead><tbody>
      ${L.map((d) => { const p = devById(d.parentId); return `<tr><td>${stPill(d.status)}</td>
        <td><div class="mono faint" style="font-size:11px">${esc(d.code)}${d.critical ? ' · <span style="color:var(--bad)">CRITICAL</span>' : ''}</div><a href="#" data-act="detail" data-id="${d.id}" style="color:var(--text);font-weight:600">${esc(d.name)}</a></td>
        <td class="mono" style="color:var(--brand)">${esc(target(d))}</td><td>${esc(TYPE_INFO[d.type]?.label)}</td><td>${esc(d.location)}</td><td class="mono">${esc(d.vlan)}</td>
        <td>${p ? esc(p.name) : '<span class="faint">—</span>'}</td><td class="mono">${fmtMs(d.latency)}</td><td class="mono">${d.loss == null ? '—' : d.loss + '%'}</td><td class="mono faint">${fmtTime(d.lastCheck)}</td>
        <td><div class="acts"><button class="btn sm" data-act="ping" data-id="${d.id}" title="ตรวจสอบทันที">${icon('refresh', 14)}</button>
        ${can('operator') ? `<button class="btn sm" data-act="edit" data-id="${d.id}" title="แก้ไข">${icon('edit', 14)}</button><button class="btn sm danger" data-act="del" data-id="${d.id}" title="ลบ">${icon('trash', 14)}</button>` : ''}</div></td></tr>`; }).join('')}
      </tbody></table></div>`;
    return;
  }
  $('#dlist').innerHTML = `<div class="dgrid">${L.map((d) => `
    <div class="card dcard">
      <div class="dimg">${d.critical ? '<span class="crit pill bad">CRITICAL PATH</span>' : ''}<span class="st"><span class="sdot c-${STATUS[d.status].c}"></span>${STATUS[d.status].en}</span>${illus(d, 250)}</div>
      <div class="dbody">
        <div class="dtop"><span class="code">${esc(d.code)}</span><span class="pill info" title="${esc(TYPE_INFO[d.type]?.th)}">${esc(TYPE_INFO[d.type]?.th || d.type)}</span></div>
        <div class="dname" data-act="detail" data-id="${d.id}">${esc(d.name)}</div>
        <div class="dmodel">${esc([d.vendor, d.model].filter(Boolean).join(' · ') || TYPE_INFO[d.type]?.label)}</div>
        <div class="kv">
          <div><span>Management IP:</span><span class="mono">${esc(maskIp(d.ip))}<button class="copy" data-act="copy" data-v="${esc(d.ip)}" title="คัดลอก IP">${icon('copy', 13)}</button></span></div>
          <div><span>วิธีตรวจ:</span><span>${d.method === 'tcp' ? `TCP Port ${d.port}` : 'ICMP Ping'}</span></div>
          <div><span>Subnet &amp; VLAN:</span><span><b>${d.vlan ? 'VLAN ' + esc(d.vlan) : '—'}</b></span></div>
          <div><span>Latency / Loss:</span><span class="mono">${fmtMs(d.latency)} · ${d.loss == null ? '—' : d.loss + '%'}</span></div>
          <div><span>แผนก / ตำแหน่ง:</span><span title="${esc(d.location)}">${esc(d.location || '—')}</span></div>
        </div>
        <div class="dact"><button class="btn" data-act="ping" data-id="${d.id}">${icon("refresh", 15)} ${d.method === "tcp" ? "TCP Check" : "ICMP Ping"}</button>
          ${can('operator') ? `<button class="btn" style="flex:0 0 auto" data-act="edit" data-id="${d.id}" title="แก้ไข">${icon('edit', 15)}</button>` : ''}
          <button class="btn" style="flex:0 0 auto;color:var(--brand)" data-act="detail" data-id="${d.id}">ตรวจสอบ ${icon('arrow', 15)}</button></div>
      </div></div>`).join('')}</div>`;
}

/* ---------------------------------------------------------- Alerts */
function vAlerts() {
  const all = [...S.state.alerts].reverse();
  const L = all.filter((a) => S.alertFilter === 'all' || (S.alertFilter === 'open' ? a.status !== 'resolved' : a.status === 'resolved'));
  const n = { open: all.filter((a) => a.status !== 'resolved').length, resolved: all.filter((a) => a.status === 'resolved').length };
  return `<div class="card panel">
    <div class="toolbar"><div class="chips">
      <button class="chip ${S.alertFilter === 'open' ? 'on' : ''}" data-act="afilter" data-f="open">ยังไม่แก้ไข <span class="mono">${n.open}</span></button>
      <button class="chip ${S.alertFilter === 'resolved' ? 'on' : ''}" data-act="afilter" data-f="resolved">แก้ไขแล้ว <span class="mono">${n.resolved}</span></button>
      <button class="chip ${S.alertFilter === 'all' ? 'on' : ''}" data-act="afilter" data-f="all">ทั้งหมด <span class="mono">${all.length}</span></button></div>
      <span style="flex:1"></span>${can('operator') ? `<button class="btn" data-act="clearresolved">${icon('trash', 15)} ล้างรายการที่แก้ไขแล้ว</button>` : ''}</div>
    ${L.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>ระดับ</th><th>อุปกรณ์</th><th>รายละเอียด</th><th>เกิดเมื่อ</th><th>ระยะเวลา</th><th>สถานะ</th><th></th></tr></thead><tbody>
      ${L.map((a) => { const s = SEV[a.severity] || SEV.info; return `<tr><td><span class="pill ${s.c}">${s.th}</span></td>
        <td><a href="#" data-act="detail" data-id="${a.deviceId}" style="color:var(--text);font-weight:600">${esc(a.deviceName)}</a><div class="mono faint" style="font-size:11px">${esc(maskIp(a.ip))}</div></td>
        <td>${esc(a.message)}</td><td class="mono">${fmtDT(a.created)}</td>
        <td class="mono">${a.resolvedAt ? msDur(a.resolvedAt - a.created) : ago(a.created)}</td>
        <td>${a.status === 'resolved' ? '<span class="pill ok">แก้ไขแล้ว</span>' : a.status === 'acknowledged' ? `<span class="pill info">รับทราบ (${esc(a.ackBy)})</span>` : '<span class="pill bad">Active</span>'}</td>
        <td><div class="acts">${can('operator') && a.status === 'active' ? `<button class="btn sm" data-act="ack" data-id="${a.id}">${icon('check', 14)} รับทราบ</button>` : ''}
        ${can('operator') && a.status !== 'resolved' ? `<button class="btn sm" data-act="resolve" data-id="${a.id}">ปิดเรื่อง</button>` : ''}</div></td></tr>`; }).join('')}
      </tbody></table></div>` : `<div class="empty">${icon('check', 30)}<div>ไม่มีรายการแจ้งเตือนในหมวดนี้</div></div>`}</div>`;
}
function msDur(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} วินาที`;
  if (s < 3600) return `${Math.floor(s / 60)} นาที ${s % 60} วิ`;
  return `${Math.floor(s / 3600)} ชม. ${Math.floor((s % 3600) / 60)} นาที`;
}

/* ---------------------------------------------------------- Users */
async function vUsers() {
  const view = $('#view');
  view.innerHTML = `<div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}</div></div>`;
  try {
    const { users } = await api('GET', '/api/users');
    view.innerHTML = `<div class="grid g21">
      <div class="card panel"><div class="ph"><h3>${icon('users', 17)}<span class="th">ผู้ใช้งานระบบ</span></h3><span class="right">${users.length} Users</span></div>
        <div class="tblwrap"><table class="tbl"><thead><tr><th>ชื่อผู้ใช้</th><th>ชื่อ</th><th>สิทธิ์</th><th>เข้าระบบล่าสุด</th><th></th></tr></thead><tbody>
        ${users.map((u) => `<tr><td class="mono">${esc(u.username)}${u.id === S.me.id ? ' <span class="pill info">คุณ</span>' : ''}</td><td>${esc(u.name)}</td>
          <td><select class="sel" style="height:32px;width:auto" data-act="role" data-id="${u.id}">${Object.entries(ROLE_TH).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
          <td class="mono faint">${fmtDT(u.lastLogin)}</td>
          <td><div class="acts"><button class="btn sm" data-act="resetpw" data-id="${u.id}" data-name="${esc(u.username)}">${icon('key', 14)} รีเซ็ตรหัส</button>
          ${u.id !== S.me.id ? `<button class="btn sm danger" data-act="deluser" data-id="${u.id}" data-name="${esc(u.username)}">${icon('trash', 14)}</button>` : ''}</div></td></tr>`).join('')}
        </tbody></table></div>
        <div class="foot"><span><b>admin</b> จัดการทุกอย่าง · <b>operator</b> เพิ่ม/แก้ไขอุปกรณ์และแจ้งเตือน · <b>viewer</b> ดูอย่างเดียว</span></div></div>
      <div class="card panel"><div class="ph"><h3>${icon('plus', 17)}<span class="th">เพิ่มผู้ใช้ใหม่</span></h3></div>
        <form id="userForm" class="form">
          <div id="userErr" class="err hidden full"></div>
          <div><label>ชื่อผู้ใช้ <span class="req">*</span></label><input class="inp" name="username" required pattern="[a-zA-Z0-9._\\-]{3,40}" placeholder="เช่น noc01"></div>
          <div><label>ชื่อ-นามสกุล</label><input class="inp" name="name" placeholder="ชื่อที่แสดง"></div>
          <div><label>รหัสผ่าน <span class="req">*</span></label><input class="inp" name="password" type="password" minlength="8" required autocomplete="new-password"></div>
          <div><label>สิทธิ์การใช้งาน</label><select class="sel" name="role">${Object.entries(ROLE_TH).map(([k, v]) => `<option value="${k}" ${k === 'operator' ? 'selected' : ''}>${v} (${k})</option>`).join('')}</select></div>
          <label class="check full"><input type="checkbox" name="mustChange" checked> บังคับเปลี่ยนรหัสผ่านเมื่อเข้าระบบครั้งแรก</label>
          <div class="full"><button class="btn primary" type="submit">${icon('plus', 16)} เพิ่มผู้ใช้</button></div>
        </form></div></div>`;
    $('#userForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('POST', '/api/users', { username: f.get('username'), name: f.get('name'), password: f.get('password'), role: f.get('role'), mustChange: !!f.get('mustChange') });
        toast('เพิ่มผู้ใช้เรียบร้อย', 'ok'); vUsers();
      } catch (ex) { const er = $('#userErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
    });
  } catch (e) { view.innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
}

/* ---------------------------------------------------------- Settings */
function vSettings() {
  const s = S.state.settings, dis = can('admin') ? '' : 'disabled';
  return `<div class="grid g2">
    <div class="card panel"><div class="ph"><h3>${icon('sliders', 17)}<span class="th">การตั้งค่าการเฝ้าระวัง</span></h3>${can('admin') ? '' : '<span class="right">เฉพาะผู้ดูแลระบบ</span>'}</div>
      <form id="setForm" class="form"><div id="setMsg" class="full hidden"></div>
        <div class="full"><label>ชื่อหน่วยงาน / โรงพยาบาล</label><input class="inp" name="siteName" value="${esc(s.siteName)}" ${dis}></div>
        <div><label>รอบการตรวจสอบ (วินาที)</label><input class="inp" type="number" min="3" max="3600" name="intervalSec" value="${s.intervalSec}" ${dis}><div class="hint">แนะนำ 10–60 วินาที</div></div>
        <div><label>Timeout ต่อการตรวจ (ms)</label><input class="inp" type="number" min="200" max="10000" name="timeoutMs" value="${s.timeoutMs}" ${dis}></div>
        <div><label>เกณฑ์ Latency เตือน (ms)</label><input class="inp" type="number" min="1" max="10000" name="warnMs" value="${s.warnMs}" ${dis}><div class="hint">เกินค่านี้ = สถานะ “ควรระวัง”</div></div>
        <div><label>เป้าหมาย SLA (%)</label><input class="inp" type="number" step="0.1" min="50" max="100" name="slaTarget" value="${s.slaTarget}" ${dis}></div>
        ${can('admin') ? `<div class="full"><button class="btn primary" type="submit">${icon('check', 16)} บันทึกการตั้งค่า</button></div>` : ''}
      </form></div>
    <div class="card panel"><div class="ph"><h3>${icon('lock', 17)}<span class="th">บัญชีของฉัน</span></h3><span class="right">${esc(S.me.username)} · ${esc(ROLE_TH[S.me.role])}</span></div>
      <button class="btn" data-act="changepw">${icon('key', 16)} เปลี่ยนรหัสผ่าน</button>
      <div class="ph" style="margin-top:24px"><h3>${icon('download', 17)}<span class="th">ข้อมูลอุปกรณ์</span></h3></div>
      <p class="muted" style="margin-top:0">ส่งออกรายการอุปกรณ์เป็น CSV (เปิดใน Excel ได้) และนำเข้ากลับได้จากเมนู “นำเข้า CSV”</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/api/export.csv">${icon('download', 16)} ส่งออก CSV</a>
      ${can('operator') ? `<button class="btn" data-act="add" data-mode="bulk">${icon('upload', 16)} นำเข้า CSV</button><button class="btn" data-act="demo">${icon('wand', 16)} เพิ่มข้อมูลตัวอย่าง</button>` : ''}</div>
      <div class="ph" style="margin-top:24px"><h3>${icon('activity', 17)}<span class="th">วิธีการตรวจสอบ</span></h3></div>
      <div class="code-block">ICMP  → ใช้คำสั่ง ping ของเซิร์ฟเวอร์ (Windows / Linux / macOS)
TCP   → เชื่อมต่อพอร์ตบริการ เช่น 3306 (MySQL/HIS), 443 (HTTPS), 22 (SSH)
สถานะ → ตอบ ≤ เกณฑ์ = ปกติ · ตอบ > เกณฑ์ = ควรระวัง · ไม่ตอบ 2 รอบติด = ออฟไลน์</div></div></div>
    ${can('admin') ? `<div class="card panel" id="mysqlBox"><div class="empty">${icon('refresh', 22, 'spin')}</div></div>` : ''}
    ${can('admin') ? `<div class="card panel" id="notifyBox"><div class="empty">${icon('refresh', 22, 'spin')}</div></div>` : ''}
    ${can('admin') ? `<div class="card panel" id="apiBox"><div class="empty">${icon('refresh', 22, 'spin')}</div></div>` : ''}
    ${can('admin') ? `<div class="card panel" id="backupBox"><div class="empty">${icon('refresh', 22, 'spin')}</div></div>` : ''}`;
}

/* ---------------------------------------------------------- External notification */
const CH_TYPES = { moph: 'MOPH Notify (หมอพร้อม)', webhook: 'Webhook (JSON)', telegram: 'Telegram Bot' };
const NF_KIND = { down: ['ล่ม', 'bad'], repeat: ['แจ้งซ้ำ', 'bad'], recover: ['กลับมา', 'ok'], warning: ['ช้า', 'warn'], test: ['ทดสอบ', 'info'], report: ['รายงาน', 'info'] };
async function loadNotify() {
  try { S.notify = await api('GET', '/api/notify'); renderNotify(); } catch (e) { const b = $('#notifyBox'); if (b) b.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function chField(i, f, label, val, opt = {}) {
  return `<div class="${opt.full ? 'full' : ''}"><label>${label}${opt.req ? ' <span class="req">*</span>' : ''}</label>
    ${opt.area ? `<textarea class="inp" rows="3" data-ci="${i}" data-cf="${f}" placeholder="${esc(opt.ph || '')}" spellcheck="false">${esc(val)}</textarea>`
    : `<input class="inp ${opt.mono ? 'mono' : ''}" data-ci="${i}" data-cf="${f}" value="${esc(val)}" placeholder="${esc(opt.ph || '')}" autocomplete="off" spellcheck="false">`}
    ${opt.hint ? `<div class="hint">${opt.hint}</div>` : ''}</div>`;
}
function channelCard(c, i) {
  let f = '';
  if (c.type === 'moph') {
    f = chField(i, 'url', 'API URL', c.url, { full: true, mono: true, ph: S.notify.defaultUrl })
      + chField(i, 'clientKey', 'client-key', c.clientKey, { req: true, mono: true, ph: 'client-key จากหมอพร้อม' })
      + chField(i, 'secretKey', 'secret-key', c.secretKey, { req: true, mono: true, ph: 'secret-key จากหมอพร้อม' })
      + `<div><label>รูปแบบข้อความ</label><select class="sel" data-ci="${i}" data-cf="format"><option value="flex" ${c.format !== 'text' ? 'selected' : ''}>Flex Message (การ์ดสี)</option><option value="text" ${c.format === 'text' ? 'selected' : ''}>ข้อความธรรมดา</option></select></div>`;
  } else if (c.type === 'telegram') {
    f = chField(i, 'botToken', 'Bot Token', c.botToken, { req: true, mono: true, ph: '123456:ABC-DEF...' })
      + chField(i, 'chatId', 'Chat ID', c.chatId, { req: true, mono: true, ph: 'เช่น -1001234567890' });
  } else {
    f = chField(i, 'url', 'Webhook URL', c.url, { full: true, req: true, mono: true, ph: 'https://...' })
      + chField(i, 'headers', 'HTTP Headers (บรรทัดละ 1 รายการ)', c.headers, { full: true, area: true, ph: 'Authorization: Bearer xxxx\nX-Api-Key: xxxx', hint: 'ส่ง JSON: event, title, text, content, site, time, devices[]' });
  }
  return `<div class="chcard ${c.enabled ? '' : 'off'}">
    <div class="chhead"><span class="pill info">${esc(CH_TYPES[c.type])}</span>
      <input class="inp" style="height:32px;flex:1;min-width:120px" data-ci="${i}" data-cf="name" value="${esc(c.name)}" placeholder="ชื่อช่องทาง เช่น กลุ่มไอที">
      <label class="check"><input type="checkbox" data-ci="${i}" data-cf="enabled" ${c.enabled ? 'checked' : ''}> ใช้งาน</label>
      <button type="button" class="btn sm" data-act="nftest" data-ci="${i}">${icon('zap', 14)} ทดสอบส่ง</button>
      <button type="button" class="btn sm danger" data-act="nfdel" data-ci="${i}" title="ลบช่องทาง">${icon('trash', 14)}</button></div>
    <div class="form">${f}</div></div>`;
}
function renderNotify() {
  const N = S.notify, box = $('#notifyBox'); if (!box || !N) return;
  const ck = (k, l, hint = '') => `<label class="check"><input type="checkbox" data-nf="${k}" ${N[k] ? 'checked' : ''}> ${l}${hint ? ` <span class="faint" style="font-weight:400">${hint}</span>` : ''}</label>`;
  box.innerHTML = `
    <div class="ph"><h3>${icon('bell', 17)}<span class="th">การแจ้งเตือนภายนอก</span><span class="bar"></span>External Notification</h3>
      <span class="right" style="text-transform:none"><label class="switch"><input type="checkbox" data-nf="enabled" ${N.enabled ? 'checked' : ''}><span></span></label>
      <b style="font:600 13px var(--sans);color:${N.enabled ? 'var(--brand)' : 'var(--muted)'}">${N.enabled ? 'เปิดใช้งาน' : 'ปิดอยู่'}</b></span></div>
    <div id="nfMsg" class="hidden"></div>
    <div class="nfgrid">
      <div>
        <div class="sub-h">เงื่อนไขการแจ้งเตือน</div>
        <div class="nfrules">
          ${ck('onDown', 'แจ้งเมื่ออุปกรณ์ Down / ขาดการเชื่อมต่อ', '(ไม่ตอบ 2 รอบติด)')}
          ${ck('onRecover', 'แจ้งเมื่ออุปกรณ์กลับมาใช้งานได้', '(พร้อมระยะเวลาที่ล่ม)')}
          ${ck('onWarning', 'แจ้งเมื่อ Latency สูงเกินเกณฑ์')}
          ${ck('criticalOnly', 'แจ้งเฉพาะอุปกรณ์สำคัญ (Critical Path)')}
          ${ck('suppressChildren', 'ไม่แจ้งอุปกรณ์ปลายทาง ถ้า Uplink ล่มอยู่แล้ว', '(ลดข้อความซ้ำ)')}
        </div>
        <div class="form" style="margin-top:14px">
          <div><label>แจ้งซ้ำหากยังไม่กลับมา ทุก (นาที)</label><input class="inp" type="number" min="0" max="1440" data-nf="repeatMin" value="${N.repeatMin}"><div class="hint">0 = ไม่แจ้งซ้ำ · หยุดแจ้งซ้ำเมื่อกด “รับทราบ”</div></div>
          <div><label>ลิงก์ระบบ NOC (แสดงปุ่มในข้อความ)</label><input class="inp mono" data-nf="publicUrl" value="${esc(N.publicUrl)}" placeholder="http://10.0.0.5:3000"></div>
        </div>
        <div class="code-block" style="margin-top:14px">ระบบรวมเหตุการณ์ในรอบตรวจเดียวกันเป็นข้อความเดียว
ปิดการแจ้งรายอุปกรณ์ได้ที่ “แก้ไขอุปกรณ์” → ส่งแจ้งเตือนภายนอก
โหมดบำรุงรักษา = ไม่ส่งแจ้งเตือน</div>
      </div>
      <div>
        <div class="sub-h" style="display:flex;align-items:center;gap:8px">ช่องทางการส่ง <span class="mono faint">${N.channels.length}</span>
          <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">${Object.entries(CH_TYPES).map(([k, v]) => `<button type="button" class="btn sm" data-act="nfadd" data-t="${k}">${icon('plus', 14)} ${v.split(' ')[0]}</button>`).join('')}</span></div>
        ${N.channels.length ? N.channels.map(channelCard).join('') : `<div class="empty" style="border:1px dashed var(--line);border-radius:8px">ยังไม่มีช่องทาง — กด “+ MOPH” เพื่อเพิ่มการแจ้งเตือนผ่านหมอพร้อม</div>`}
      </div>
    </div>
    <div style="display:flex;gap:8px;margin-top:16px;align-items:center"><button class="btn primary" data-act="nfsave">${icon('check', 16)} บันทึกการตั้งค่าการแจ้งเตือน</button>
      <span class="faint" style="font-size:12px">กด “ทดสอบส่ง” ได้ก่อนบันทึก</span></div>
    <div class="sub-h" style="margin-top:22px">ประวัติการส่งล่าสุด</div><div id="nfLog"></div>`;
  renderNotifyLog();
}
function renderNotifyLog() {
  const el = $('#nfLog'); if (!el) return;
  const L = S.notify.log || [];
  el.innerHTML = L.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>เวลา</th><th>ช่องทาง</th><th>เหตุการณ์</th><th>ผล</th><th>รายละเอียดตอบกลับ</th></tr></thead><tbody>
    ${L.map((x) => `<tr><td class="mono">${fmtDT(x.t)}</td><td>${esc(x.channel)}</td><td><span class="pill ${(NF_KIND[x.kind] || ['', 'muted'])[1]}">${esc((NF_KIND[x.kind] || [x.kind])[0])}</span></td>
      <td>${x.ok ? `<span class="pill ok">สำเร็จ ${x.status || ''}</span>` : `<span class="pill bad">ล้มเหลว ${x.status || ''}</span>`}</td>
      <td class="mono faint" style="font-size:11.5px;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(x.info)}">${esc(x.info || '—')}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="empty">ยังไม่มีการส่งแจ้งเตือน</div>';
}
function nfInput(e) {
  const t = e.target, N = S.notify; if (!N || !t.closest('#notifyBox')) return;
  const v = t.type === 'checkbox' ? t.checked : t.value;
  if (t.dataset.nf) { N[t.dataset.nf] = v; if (t.dataset.nf === 'enabled') renderNotify(); }
  else if (t.dataset.cf) { const c = N.channels[+t.dataset.ci]; c[t.dataset.cf] = v; if (t.dataset.cf === 'enabled') t.closest('.chcard').classList.toggle('off', !v); }
}
document.addEventListener('input', nfInput);
document.addEventListener('change', (e) => { if (e.target.type === 'checkbox' || e.target.tagName === 'SELECT') nfInput(e); });

/* ---------------------------------------------------------- Modals */
function modal(html, cls = '') {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="backdrop" data-act="mclose-bg"><div class="modal ${cls}" role="dialog" aria-modal="true">${html}</div></div>`;
  const first = root.querySelector('input:not([type=hidden]),select,textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return root.firstElementChild;
}
function closeModal() { $('#modalRoot').innerHTML = ''; S.detailId = null; }
function confirmBox(title, msg, okText = 'ยืนยัน', danger = true) {
  return new Promise((res) => {
    const m = modal(`<div class="mh"><h2>${esc(title)}</h2></div><div class="mb">${msg}</div>
      <div class="mf"><button class="btn" data-r="0">ยกเลิก</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okText)}</button></div>`);
    m.querySelector('.modal').style.maxWidth = '460px';
    m.addEventListener('click', (e) => { const b = e.target.closest('[data-r]'); if (b) { closeModal(); res(b.dataset.r === '1'); } });
  });
}
function deviceModal(d = null, mode = 'single') {
  const D = devs();
  const exclude = new Set();
  if (d) { const walk = (id) => { exclude.add(id); D.filter((x) => x.parentId === id).forEach((x) => walk(x.id)); }; walk(d.id); }
  const parents = topoOrder(D.filter((x) => !exclude.has(x.id)));
  const v = d || { type: 'switch', method: 'icmp', enabled: true };
  const types = Object.entries(TYPE_INFO).map(([k, t]) => `<option value="${k}" ${v.type === k ? 'selected' : ''}>${t.label} — ${t.th}</option>`).join('');
  const m = modal(`
    <div class="mh">${icon(d ? 'edit' : 'plus', 20)}<h2>${d ? 'แก้ไขอุปกรณ์' : 'เพิ่มอุปกรณ์ Switch / Router / IP'}</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    ${d ? '' : `<div class="mtabs"><button data-mt="single" class="${mode === 'single' ? 'on' : ''}">เพิ่มทีละรายการ</button><button data-mt="bulk" class="${mode === 'bulk' ? 'on' : ''}">เพิ่มหลายรายการ (CSV)</button></div>`}
    <form id="devForm" class="${mode === 'bulk' ? 'hidden' : ''}">
      <div class="mb"><div id="devErr" class="err hidden"></div>
      <div class="form">
        <div><label>ชื่ออุปกรณ์ <span class="req">*</span></label><input class="inp" name="name" required maxlength="120" value="${esc(v.name)}" placeholder="เช่น Core Switch ห้อง Server"></div>
        <div><label>IP Address / Hostname <span class="req">*</span></label><input class="inp mono" name="ip" required value="${esc(v.ip)}" placeholder="เช่น 10.0.0.1"></div>
        <div><label>ประเภทอุปกรณ์</label><select class="sel" name="type">${types}</select></div>
        <div><label>รหัสอุปกรณ์ (Asset Code)</label><input class="inp mono" name="code" maxlength="40" value="${esc(v.code)}" placeholder="สร้างอัตโนมัติถ้าเว้นว่าง"></div>
        <div><label>วิธีตรวจสอบ</label><select class="sel" name="method"><option value="icmp" ${v.method !== 'tcp' ? 'selected' : ''}>ICMP Ping</option><option value="tcp" ${v.method === 'tcp' ? 'selected' : ''}>TCP Port (ตรวจบริการ)</option></select></div>
        <div id="portWrap" class="${v.method === 'tcp' ? '' : 'hidden'}"><label>พอร์ต TCP</label><input class="inp mono" type="number" min="1" max="65535" name="port" value="${esc(v.port || '')}" placeholder="เช่น 3306, 443, 22"></div>
        <div><label>ยี่ห้อ (Vendor)</label><input class="inp" name="vendor" list="vendors" maxlength="40" value="${esc(v.vendor)}" placeholder="Cisco, Aruba, Fortinet..."><datalist id="vendors">${Object.keys(VENDOR_COLORS).map((x) => `<option value="${x[0].toUpperCase() + x.slice(1)}">`).join('')}</datalist></div>
        <div><label>รุ่น (Model)</label><input class="inp" name="model" maxlength="120" value="${esc(v.model)}" placeholder="เช่น Catalyst 9300-24T"></div>
        <div><label>แผนก / ตำแหน่งติดตั้ง</label><input class="inp" name="location" maxlength="160" value="${esc(v.location)}" placeholder="เช่น ห้อง Server ชั้น 2"></div>
        <div><label>VLAN</label><input class="inp mono" name="vlan" maxlength="20" value="${esc(v.vlan)}" placeholder="เช่น 31"></div>
        <div><label>เชื่อมต่อกับ (Uplink / Parent)</label><select class="sel" name="parentId"><option value="">— ไม่มี (อุปกรณ์ต้นทาง) —</option>${parents.map((p) => `<option value="${p.id}" ${v.parentId === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.ip)})</option>`).join('')}</select><div class="hint">ใช้สร้างเส้นเชื่อมในแผนผัง Topology</div></div>
        <div><label>ชื่อสาย / ลิงก์</label><input class="inp" name="linkLabel" maxlength="40" value="${esc(v.linkLabel)}" placeholder="เช่น Fiber 10Gbps, UTP 1G"></div>
        <div><label>MAC Address</label><input class="inp mono" name="mac" maxlength="40" value="${esc(v.mac)}" placeholder="ไม่บังคับ"></div>
        <div class="full"><label>หมายเหตุ</label><textarea class="inp" name="description" rows="2" maxlength="500" style="font-family:var(--sans)">${esc(v.description)}</textarea></div>
        <div class="full checks">
          <label class="check"><input type="checkbox" name="critical" ${v.critical ? 'checked' : ''}> อุปกรณ์สำคัญ (Critical Path)</label>
          <label class="check"><input type="checkbox" name="maintenance" ${v.maintenance ? 'checked' : ''}> โหมดบำรุงรักษา (ไม่แจ้งเตือน)</label>
          <label class="check"><input type="checkbox" name="enabled" ${v.enabled !== false ? 'checked' : ''}> เปิดการตรวจสอบ</label>
          <label class="check"><input type="checkbox" name="notify" ${v.notify !== false ? 'checked' : ''}> ส่งแจ้งเตือนภายนอก (หมอพร้อม / Webhook)</label>
        </div>
      </div></div>
      <div class="mf">${d && can('operator') ? `<button type="button" class="btn danger" data-act="del" data-id="${d.id}" style="margin-right:auto">${icon('trash', 15)} ลบ</button>` : ''}
        <button type="button" class="btn" data-act="mclose">ยกเลิก</button><button type="submit" class="btn primary">${icon('check', 16)} ${d ? 'บันทึก' : 'เพิ่มและเริ่มตรวจสอบ'}</button></div>
    </form>
    ${d ? '' : `<form id="bulkForm" class="${mode === 'bulk' ? '' : 'hidden'}"><div class="mb"><div id="bulkMsg"></div>
      <p class="muted" style="margin-top:0">วางข้อมูล 1 อุปกรณ์ต่อ 1 บรรทัด (คัดลอกจาก Excel ได้) — ช่องที่จำเป็นคือ <b>name</b> และ <b>ip</b></p>
      <div class="code-block" style="margin-bottom:10px">name,ip,type,vendor,model,location,vlan,uplink,tcp_port
Core Switch,10.0.0.1,core,Cisco,C9300-24T,ห้อง Server,1,,
SW-OPD-01,10.0.31.2,switch,Aruba,1930 24G,OPD ชั้น 1,31,Core Switch,
HIS Database,10.250.0.10,database,Dell,R750,Data Center,250,Core Switch,3306</div>
      <textarea class="inp" name="text" rows="9" placeholder="วางข้อมูลที่นี่..."></textarea>
      <div class="hint" style="margin-top:6px">type: ${Object.keys(TYPE_INFO).join(', ')} · uplink = ชื่อหรือ IP ของอุปกรณ์ที่เชื่อมต่อ (ต้องอยู่บรรทัดก่อนหน้าหรือมีในระบบแล้ว)</div>
      <label class="btn sm" style="margin-top:10px">${icon('upload', 14)} เลือกไฟล์ .csv<input type="file" accept=".csv,text/csv,text/plain" id="csvFile" hidden></label>
      </div><div class="mf"><button type="button" class="btn" data-act="mclose">ปิด</button><button type="submit" class="btn primary">${icon('upload', 16)} นำเข้าอุปกรณ์</button></div></form>`}`);
  const f = $('#devForm', m);
  f.method.addEventListener('change', () => $('#portWrap', m).classList.toggle('hidden', f.method.value !== 'tcp'));
  $$('[data-mt]', m).forEach((b) => b.addEventListener('click', () => {
    $$('[data-mt]', m).forEach((x) => x.classList.toggle('on', x === b));
    $('#devForm', m).classList.toggle('hidden', b.dataset.mt !== 'single');
    $('#bulkForm', m).classList.toggle('hidden', b.dataset.mt !== 'bulk');
  }));
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(f));
    ['critical', 'maintenance', 'enabled', 'notify'].forEach((k) => { body[k] = f[k].checked; });
    try {
      const r = d ? await api('PUT', `/api/devices/${d.id}`, body) : await api('POST', '/api/devices', body);
      closeModal(); toast(d ? `บันทึก “${r.device.name}” แล้ว` : `เพิ่ม “${r.device.name}” แล้ว กำลังตรวจสอบ...`, 'ok');
    } catch (ex) { const er = $('#devErr', m); er.textContent = ex.message; er.classList.remove('hidden'); er.scrollIntoView({ block: 'nearest' }); }
  });
  const bf = $('#bulkForm', m);
  if (bf) {
    $('#csvFile', m).addEventListener('change', (e) => {
      const file = e.target.files[0]; if (!file) return;
      const rd = new FileReader(); rd.onload = () => { bf.text.value = String(rd.result).replace(/^﻿/, ''); }; rd.readAsText(file, 'utf-8');
    });
    bf.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await api('POST', '/api/devices/bulk', { text: bf.text.value });
        $('#bulkMsg', m).innerHTML = `<div class="ok-msg">เพิ่มสำเร็จ ${r.added} รายการ${r.errors.length ? ` · ไม่สำเร็จ ${r.errors.length} รายการ` : ''}</div>`
          + (r.errors.length ? `<div class="err">${r.errors.map((x) => `บรรทัด ${x.line}: ${esc(x.error)}`).join('<br>')}</div>` : '');
        if (!r.errors.length) bf.text.value = '';
      } catch (ex) { $('#bulkMsg', m).innerHTML = `<div class="err">${esc(ex.message)}</div>`; }
    });
  }
}
function openDetail(id) { S.detailId = id; renderDetail(true); }
function renderDetail(open) {
  const d = devById(S.detailId);
  if (!d) { if (S.detailId) closeModal(); return; }
  const p = devById(d.parentId), kids = devs().filter((x) => x.parentId === d.id);
  const h = d.history.filter((x) => x != null);
  const al = S.state.alerts.filter((a) => a.deviceId === d.id).reverse().slice(0, 6);
  const html = `
    <div class="mh">${icon('server', 20)}<h2>${esc(d.name)}</h2>${stPill(d.status)}<button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <div class="mb">
      <div class="detail-head"><div class="img">${illus(d, 180)}</div>
        <div style="flex:1;min-width:0"><div class="mono faint">${esc(d.code)} · ${esc(TYPE_INFO[d.type]?.label)}${d.critical ? ' · <span style="color:var(--bad)">CRITICAL PATH</span>' : ''}</div>
          <div style="font-size:15px;font-weight:600;margin:4px 0">${esc([d.vendor, d.model].filter(Boolean).join(' · ') || TYPE_INFO[d.type]?.th)}</div>
          <div class="kv" style="margin-top:8px">
            <div><span>เป้าหมาย:</span><span class="mono">${esc(target(d))} (${d.method === 'tcp' ? 'TCP' : 'ICMP'})</span></div>
            <div><span>ตำแหน่ง / VLAN:</span><span>${esc(d.location || '—')} · ${d.vlan ? 'VLAN ' + esc(d.vlan) : '—'}</span></div>
            <div><span>Uplink:</span><span>${p ? `<a href="#" data-act="detail" data-id="${p.id}">${esc(p.name)}</a>` : '—'}${d.linkLabel ? ' · ' + esc(d.linkLabel) : ''}</span></div>
            <div><span>แจ้งเตือนภายนอก:</span><span>${d.notify === false ? '<span class="pill muted">ปิด</span>' : '<span class="pill ok">เปิด</span>'}</span></div>
            <div><span>สถานะนี้ตั้งแต่:</span><span>${fmtDT(d.since)} (${ago(d.since)})</span></div>
            ${d.mac ? `<div><span>MAC:</span><span class="mono">${esc(d.mac)}</span></div>` : ''}
          </div></div></div>
      <div class="stats4">
        <div class="stat"><div class="k">Latency ล่าสุด</div><div class="v" style="color:${STATUS[d.status].color}">${fmtMs(d.latency)}</div></div>
        <div class="stat"><div class="k">เฉลี่ย (${h.length} ครั้ง)</div><div class="v">${h.length ? fmtMs(h.reduce((a, b) => a + b, 0) / h.length) : '—'}</div></div>
        <div class="stat"><div class="k">Min / Max</div><div class="v" style="font-size:14px">${h.length ? `${fmtMs(Math.min(...h))} / ${fmtMs(Math.max(...h))}` : '—'}</div></div>
        <div class="stat"><div class="k">Packet Loss (20 รอบ)</div><div class="v" style="color:${d.loss ? '#f0425f' : 'inherit'}">${d.loss == null ? '—' : d.loss + '%'}</div></div>
      </div>
      <div class="mini-stats" style="justify-content:space-between;margin:0 0 6px"><span>ประวัติการตอบสนอง (${d.history.length} รอบล่าสุด · แถบแดง = ไม่ตอบสนอง)</span><span>ตรวจล่าสุด ${fmtTime(d.lastCheck)}</span></div>
      <div class="chartbox" style="margin:0">${spark(d.history, { h: 110, color: STATUS[d.status].color === '#94a3b8' ? '#0e9b87' : STATUS[d.status].color, min: 0 })}</div>
      ${kids.length ? `<div style="margin-top:16px"><b>อุปกรณ์ที่เชื่อมต่อ (${kids.length})</b><div class="list">${kids.map((k) => `<div class="li" data-act="detail" data-id="${k.id}" style="cursor:pointer"><span class="sdot c-${STATUS[k.status].c}"></span><div class="main"><div>${esc(k.name)}</div></div><span class="mono faint">${esc(target(k))}</span><span class="mono">${fmtMs(k.latency)}</span></div>`).join('')}</div></div>` : ''}
      ${al.length ? `<div style="margin-top:16px"><b>เหตุการณ์ของอุปกรณ์นี้</b><div class="list">${al.map(alertRow).join('')}</div></div>` : ''}
      ${d.description ? `<div style="margin-top:16px"><b>หมายเหตุ</b><p class="muted" style="margin:4px 0 0;white-space:pre-wrap">${esc(d.description)}</p></div>` : ''}
    </div>
    <div class="mf"><button class="btn" data-act="ping" data-id="${d.id}">${icon('refresh', 15)} ตรวจสอบทันที</button>
      ${can('operator') ? `<button class="btn" data-act="edit" data-id="${d.id}">${icon('edit', 15)} แก้ไข</button>` : ''}
      <button class="btn primary" data-act="mclose">ปิด</button></div>`;
  if (open || !$('#modalRoot .modal.detail')) modal(html, 'wide detail');
  else $('#modalRoot .modal.detail').innerHTML = html;
}
function pwModal(force = false, userId = null, uname = '') {
  const admin = !!userId;
  const m = modal(`<div class="mh">${icon('key', 20)}<h2>${admin ? `ตั้งรหัสผ่านใหม่ให้ ${esc(uname)}` : force ? 'กรุณาเปลี่ยนรหัสผ่านก่อนใช้งาน' : 'เปลี่ยนรหัสผ่าน'}</h2>${force ? '' : `<button class="ibtn x" data-act="mclose">${icon('x', 18)}</button>`}</div>
    <form id="pwForm"><div class="mb"><div id="pwErr" class="err hidden"></div>
      ${force ? '<div class="ok-msg" style="background:var(--warn-soft);border-color:#f7d79a;color:#8a5a00">บัญชีนี้ใช้รหัสผ่านเริ่มต้น เพื่อความปลอดภัยกรุณาตั้งรหัสผ่านใหม่</div>' : ''}
      <div class="form">${admin ? '' : '<div class="full"><label>รหัสผ่านปัจจุบัน</label><input class="inp" type="password" name="current" required autocomplete="current-password"></div>'}
      <div><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัว)</label><input class="inp" type="password" name="n1" minlength="8" required autocomplete="new-password"></div>
      <div><label>ยืนยันรหัสผ่านใหม่</label><input class="inp" type="password" name="n2" minlength="8" required autocomplete="new-password"></div></div></div>
      <div class="mf">${force ? `<button type="button" class="btn" data-act="logout">ออกจากระบบ</button>` : '<button type="button" class="btn" data-act="mclose">ยกเลิก</button>'}<button class="btn primary" type="submit">${icon('check', 16)} บันทึก</button></div></form>`);
  m.querySelector('.modal').style.maxWidth = '540px';
  if (force) m.dataset.act = '';
  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, er = $('#pwErr');
    if (f.n1.value !== f.n2.value) { er.textContent = 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน'; er.classList.remove('hidden'); return; }
    try {
      if (admin) await api('PUT', `/api/users/${userId}`, { password: f.n1.value });
      else await api('POST', '/api/me/password', { current: f.current.value, newPassword: f.n1.value });
      if (!admin) S.me.mustChange = false;
      closeModal(); toast('เปลี่ยนรหัสผ่านเรียบร้อย', 'ok');
    } catch (ex) { er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}

/* ---------------------------------------------------------- Render loop */
function switchTab(t) {
  if (t === 'users' && !can('admin')) t = 'dashboard';
  S.tab = t; store.set('nms_tab', t);
  renderNav();
  const view = $('#view');
  if (t === 'users') { vUsers(); return; }
  if (t === 'devices') { view.innerHTML = vDevicesSkeleton(); bindDeviceFilters(); vDevicesList(); return; }
  if (t === 'settings') { view.innerHTML = vSettings(); bindSettings(); return; }
  if (t === 'reports') { vReports(); return; }
  if (t === 'dbsync') { vDbSync(); return; }
  if (t === 'wazuh') { vWazuh(); return; }
  if (t === 'inventory') { vInventory(); return; }
  if (t === 'ipscan') { vIpScan(); return; }
  if (t === 'topology') { view.innerHTML = vTopology(); bindTopology(); drawTopology(); if (!store.get('nms_topo_set', false)) { topoFit(); store.set('nms_topo_set', true); } return; }
  updateView();
}
function updateView() {
  const view = $('#view');
  switch (S.tab) {
    case 'dashboard': view.innerHTML = vDashboard(); break;
    case 'alerts': view.innerHTML = vAlerts(); break;
    case 'devices': if ($('#dlist')) vDevicesList(); else switchTab('devices'); break;
    case 'topology': if (!S.dragging) { if ($('#topo')) drawTopology(); else switchTab('topology'); } break;
    default: break; // users/settings: ไม่ re-render ระหว่างกรอกฟอร์ม
  }
}
function bindDeviceFilters() {
  let t;
  $('#fq').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { S.filter.q = e.target.value; vDevicesList(); }, 150); });
  $('#ft').addEventListener('change', (e) => { S.filter.type = e.target.value; vDevicesList(); });
}
function bindSettings() {
  if (can('admin')) { loadNotify(); loadMysql(); loadApiBox(); loadBackupBox(); }
  const f = $('#setForm'); if (!f) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#setMsg');
    try {
      const body = Object.fromEntries(new FormData(f));
      await api('PUT', '/api/settings', body);
      msg.className = 'full ok-msg'; msg.textContent = 'บันทึกการตั้งค่าเรียบร้อย';
    } catch (ex) { msg.className = 'full err'; msg.textContent = ex.message; }
  });
}
function onState(st) {
  const prev = S.state; S.state = st;
  // แจ้งเตือนใหม่ (toast)
  st.alerts.forEach((a) => {
    if (!S.seenAlerts.has(a.id)) {
      S.seenAlerts.add(a.id);
      if (!S.firstState && a.status === 'active') toast(a.message, a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : '');
    }
  });
  S.firstState = false;
  renderHeader(); renderStatus(); renderKpis(); renderNav();
  if (!prev) switchTab(S.tab); else updateView();
  if (S.detailId && $('#modalRoot .modal.detail')) renderDetail(false);
}
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { S.connected = true; onState(JSON.parse(e.data)); });
  es.onerror = async () => {
    S.connected = false; if (S.state) renderStatus();
    try { await api('GET', '/api/me'); } catch { /* redirected to login */ }
  };
}

/* ---------------------------------------------------------- Actions */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act, id = el.dataset.id ? +el.dataset.id : null;
  if (act === 'mclose-bg') { if (e.target === el && !(S.me && S.me.mustChange)) closeModal(); return; }
  if (el.tagName === 'A') e.preventDefault();
  try {
    switch (act) {
      case 'tab': closeModal(); switchTab(el.dataset.tab); window.scrollTo({ top: 0, behavior: 'smooth' }); break;
      case 'mask': S.mask = !S.mask; store.set('nms_mask', S.mask); renderHeader(); renderKpis(); if (S.tab === 'devices') vDevicesList(); else updateView(); break;
      case 'theme': applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); renderHeader(); updateView(); break;
      case 'fullscreen': if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); break;
      case 'checkall': el.querySelector('svg')?.classList.add('spin'); await api('POST', '/api/check-all'); toast('ตรวจสอบอุปกรณ์ทั้งหมดเรียบร้อย', 'ok'); break;
      case 'logout': await api('POST', '/api/logout').catch(() => {}); location.href = '/login'; break;
      case 'add': deviceModal(null, el.dataset.mode || 'single'); break;
      case 'edit': deviceModal(devById(id)); break;
      case 'detail': openDetail(id); break;
      case 'mclose': closeModal(); break;
      case 'del': {
        const d = devById(id);
        if (await confirmBox('ลบอุปกรณ์', `ต้องการลบ <b>${esc(d.name)}</b> (${esc(d.ip)}) ออกจากระบบหรือไม่?<br><span class="muted">อุปกรณ์ที่เชื่อมต่ออยู่จะย้ายไปเชื่อมกับ Uplink ถัดขึ้นไป</span>`, 'ลบอุปกรณ์')) {
          await api('DELETE', `/api/devices/${id}`); toast('ลบอุปกรณ์แล้ว', 'ok');
        }
        break;
      }
      case 'ping': {
        el.disabled = true; const old = el.innerHTML; el.innerHTML = `${icon('refresh', 15, 'spin')} กำลังตรวจ...`;
        try { const r = await api('POST', `/api/devices/${id}/check`); toast(`${r.device.name}: ${r.device.latency != null ? 'ตอบสนอง ' + fmtMs(r.device.latency) : 'ไม่ตอบสนอง'}`, r.device.latency != null ? 'ok' : 'bad'); }
        finally { el.disabled = false; el.innerHTML = old; }
        break;
      }
      case 'copy': await copyText(el.dataset.v); toast(el.dataset.v.length > 40 || el.dataset.v.startsWith('stk_') ? 'คัดลอกแล้ว' : `คัดลอก ${el.dataset.v} แล้ว`); break;
      case 'view': S.view = el.dataset.v; store.set('nms_view', S.view); $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.view)); vDevicesList(); break;
      case 'fst': S.filter.status = el.dataset.s; vDevicesList(); break;
      case 'afilter': S.alertFilter = el.dataset.f; updateView(); break;
      case 'ack': await api('POST', `/api/alerts/${id}/ack`); break;
      case 'resolve': await api('POST', `/api/alerts/${id}/resolve`); break;
      case 'clearresolved': if (await confirmBox('ล้างรายการ', 'ลบประวัติการแจ้งเตือนที่แก้ไขแล้วทั้งหมด?', 'ล้างรายการ')) await api('POST', '/api/alerts/clear-resolved'); break;
      case 'demo': { const r = await api('POST', '/api/devices/demo'); toast(`เพิ่มอุปกรณ์ตัวอย่าง ${r.added} รายการ`, 'ok'); break; }
      case 'tzoom': { const svg = $('#topo'); zoomAt(svg.clientWidth / 2, svg.clientHeight / 2, +el.dataset.z); break; }
      case 'tfit': topoFit(); break;
      case 'treset': if (await confirmBox('จัดวางอัตโนมัติ', 'ล้างตำแหน่งที่จัดวางไว้และจัดเรียงแผนผังใหม่ตามลำดับชั้น?', 'จัดวางใหม่', false)) { await api('DELETE', '/api/devices/positions'); devs().forEach((d) => { delete d.x; delete d.y; }); drawTopology(); topoFit(); } break;
      case 'nfadd': {
        const t = el.dataset.t;
        S.notify.channels.push({ type: t, enabled: true, name: '', url: t === 'moph' ? S.notify.defaultUrl : '', format: 'flex', clientKey: '', secretKey: '', botToken: '', chatId: '', headers: '' });
        renderNotify(); break;
      }
      case 'nfdel': {
        const c = S.notify.channels[+el.dataset.ci];
        if (await confirmBox('ลบช่องทาง', `ลบช่องทาง <b>${esc(c.name || CH_TYPES[c.type])}</b>? (มีผลเมื่อกดบันทึก)`, 'ลบ')) { S.notify.channels.splice(+el.dataset.ci, 1); renderNotify(); }
        break;
      }
      case 'nftest': {
        el.disabled = true; const old = el.innerHTML; el.innerHTML = `${icon('refresh', 14, 'spin')} กำลังส่ง...`;
        try {
          const { result: r } = await api('POST', '/api/notify/test', { channel: S.notify.channels[+el.dataset.ci] });
          toast(r.ok ? `ส่งทดสอบสำเร็จ (HTTP ${r.status})` : `ส่งไม่สำเร็จ: ${r.status || ''} ${r.info}`, r.ok ? 'ok' : 'bad');
          const fresh = await api('GET', '/api/notify'); S.notify.log = fresh.log; renderNotifyLog();
        } finally { el.disabled = false; el.innerHTML = old; }
        break;
      }
      case 'nfsave': {
        const msg = $('#nfMsg');
        try {
          S.notify = await api('PUT', '/api/notify', S.notify); renderNotify();
          const m2 = $('#nfMsg'); m2.className = 'ok-msg'; m2.textContent = 'บันทึกการตั้งค่าการแจ้งเตือนเรียบร้อย'; toast('บันทึกการตั้งค่าการแจ้งเตือนแล้ว', 'ok');
        } catch (ex) { msg.className = 'err'; msg.textContent = ex.message; msg.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
        break;
      }
      case 'changepw': pwModal(false); break;
      case 'resetpw': pwModal(false, id, el.dataset.name); break;
      case 'deluser': if (await confirmBox('ลบผู้ใช้', `ต้องการลบผู้ใช้ <b>${esc(el.dataset.name)}</b> หรือไม่?`, 'ลบผู้ใช้')) { await api('DELETE', `/api/users/${id}`); toast('ลบผู้ใช้แล้ว', 'ok'); vUsers(); } break;
      default: break;
    }
  } catch (ex) { toast(ex.message, 'bad'); }
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'role') {
    try { await api('PUT', `/api/users/${el.dataset.id}`, { role: el.value }); toast('ปรับสิทธิ์แล้ว', 'ok'); } catch (ex) { toast(ex.message, 'bad'); vUsers(); }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !(S.me && S.me.mustChange)) closeModal(); });
setInterval(() => { const c = $('#clock'); if (c) c.textContent = fmtTime(Date.now()); }, 1000);

/* ---------------------------------------------------------- Boot */
(async function boot() {
  try {
    const { user } = await api('GET', '/api/me');
    S.me = user;
    connect();
    if (user.mustChange) setTimeout(() => pwModal(true), 400);
  } catch { /* api() redirects to /login */ }
})();
