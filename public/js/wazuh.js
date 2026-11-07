'use strict';
/* ============================================================
   Wazuh SIEM — สถานะ Manager, Agents, สถิติ Component, SCA / CIS-CAT,
   Configuration, Alert ที่รับเข้า และ Event ที่ส่งออก
   ใช้ฟังก์ชันร่วมจาก common.js, app.js, reports.js, admin.js
   ============================================================ */
const WZ = { data: null, timer: null, aq: '', cfgSection: 'global' };
const AG_ST = { active: ['ทำงาน', 'ok'], disconnected: ['ขาดการเชื่อมต่อ', 'bad'], never_connected: ['ยังไม่เคยเชื่อมต่อ', 'muted'], pending: ['รอยืนยัน', 'warn'] };
const WZ_SECTIONS = ['global', 'alerts', 'remote', 'syscheck', 'rootcheck', 'sca', 'vulnerability-detection', 'logging', 'auth', 'cluster', 'integration', 'active-response', 'command', 'localfile', 'wodle'];
const scoreCls = (s) => (s == null ? 'muted' : s >= 80 ? 'ok' : s >= 60 ? 'warn' : 'bad');
const lvCls = (l) => (l >= 12 ? 'bad' : l >= 7 ? 'warn' : 'info');
const wzAgo = (t) => { if (!t) return '—'; const s = Math.round((Date.now() - new Date(t)) / 1000); if (s < 0 || s > 315360000) return '—'; return s < 60 ? `${s} วินาที` : s < 3600 ? `${Math.floor(s / 60)} นาที` : s < 86400 ? `${Math.floor(s / 3600)} ชม.` : `${Math.floor(s / 86400)} วัน`; };

function vWazuh() {
  $('#view').innerHTML = `<div id="wzBody"><div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}<div>กำลังโหลด...</div></div></div></div>`;
  loadWz();
  clearInterval(WZ.timer);
  WZ.timer = setInterval(() => { if (S.tab === 'wazuh' && !$('#modalRoot .modal') && !document.hidden) loadWz(true); }, 30000);
}
async function loadWz(silent) {
  try {
    WZ.data = await api('GET', '/api/wazuh');
    const y = window.scrollY; renderWz(); if (silent) window.scrollTo(0, y);
  } catch (e) { if (!silent) $('#wzBody').innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
}

function renderWz() {
  const d = WZ.data, L = d.last, body = $('#wzBody');
  if (!d.configured) {
    body.innerHTML = `<div class="card panel wz-empty">${icon('shield', 44)}<h2>ยังไม่ได้เชื่อมต่อ Wazuh</h2>
      <p class="muted">เชื่อมต่อ Wazuh Server API (พอร์ต 55000) เพื่อดึงสถานะ Agent, สถิติ Component, ผลตรวจ SCA / CIS-CAT
      ส่งการแจ้งเตือนของ Smart Topology เข้า Wazuh และรับ Alert ระดับสูงจาก Wazuh กลับมาแสดงที่นี่</p>
      ${can('admin') ? `<button class="btn primary" data-act="wzcfg">${icon('sliders', 16)} ตั้งค่าการเชื่อมต่อ Wazuh</button>` : '<p class="muted">กรุณาติดต่อผู้ดูแลระบบเพื่อตั้งค่า</p>'}</div>
      ${d.inbound.length ? inboundCard(d) : ''}`;
    return;
  }
  const m = (L && L.manager) || {}, s = (L && L.summary) || {};
  const daemons = Object.entries(m.daemons || {});
  const run = daemons.filter(([, v]) => v === 'running').length;
  const errs = Object.entries((L && L.errors) || {}).filter(([, v]) => !(L && L.error && v === L.error));
  body.innerHTML = `
    <div class="card panel wz-bar">
      <div class="wz-title">${icon('shield', 22)}<div><b>Wazuh SIEM</b><div class="faint mono">${esc(d.config ? d.config.url : '')}</div></div></div>
      <span class="pill ${!d.enabled ? 'muted' : L && L.ok ? 'ok' : 'bad'}"><span class="sdot c-${!d.enabled ? 'muted' : L && L.ok ? 'ok' : 'bad'}"></span>${!d.enabled ? 'ปิดการเชื่อมต่อ' : L && L.ok ? 'เชื่อมต่อแล้ว' : 'เชื่อมต่อไม่ได้'}</span>
      <span class="faint">${L ? `อัปเดต ${fmtDT(L.at)}${L.ms != null ? ` · ${L.ms} ms` : ''}` : 'ยังไม่ได้ดึงข้อมูล'}</span>
      <span class="grow"></span>
      ${can('operator') ? `<button class="btn sm" data-act="wzrefresh">${icon('refresh', 14)} ดึงข้อมูลตอนนี้</button>` : ''}
      ${can('admin') ? `<button class="btn sm" data-act="wzpush">${icon('upload', 14)} ส่ง Event ทดสอบ</button><button class="btn sm primary" data-act="wzcfg">${icon('sliders', 14)} ตั้งค่า</button>` : ''}
    </div>
    ${L && L.error ? `<div class="err">${esc(L.error)}</div>` : ''}
    ${errs.length ? `<div class="err" style="background:var(--warn-soft);border-color:#f7d79a;color:#8a5a00">ดึงข้อมูลบางส่วนไม่สำเร็จ: ${errs.map(([k, v]) => `<b>${esc(k)}</b> ${esc(v)}`).join(' · ')}</div>` : ''}
    <div class="grid g4 wz-kpis">
      <div class="card kpi"><div class="h">Wazuh Manager ${icon('server', 18)}</div><div class="v" style="font-size:24px">${esc(m.version || '—')}</div>
        <div class="row"><span>API</span><span class="mono">${esc(m.apiVersion || '—')}</span></div></div>
      <div class="card kpi"><div class="h">Agents ทำงาน ${icon('activity', 18)}</div><div class="v">${s.active ?? '—'}<small>/ ${s.total ?? '—'}</small></div>
        <div class="row"><span>ขาดการเชื่อมต่อ</span><span class="mono" style="color:${s.disconnected ? 'var(--bad)' : ''}">${s.disconnected ?? 0}</span></div></div>
      <div class="card kpi"><div class="h">Daemons ${icon('cpu', 18)}</div><div class="v">${run}<small>/ ${daemons.length} running</small></div>
        <div class="row"><span>Cluster</span><span>${m.cluster ? (m.cluster.enabled === 'yes' ? `เปิด (${m.cluster.running === 'yes' ? 'ทำงาน' : 'หยุด'})` : 'ไม่ใช้') : '—'}</span></div></div>
      <div class="card kpi"><div class="h">Alerts วันนี้ ${icon('bell', 18)}</div><div class="v">${fNum(((L && L.hourly) || []).reduce((a, h) => a + (h.alerts || 0), 0))}</div>
        <div class="row"><span>Events</span><span class="mono">${fNum(((L && L.hourly) || []).reduce((a, h) => a + (h.events || 0), 0))}</span></div></div>
    </div>
    <div class="grid g2">
      <div class="card panel"><div class="ph"><h3>${icon('server', 17)}<span class="th">Manager</span><span class="bar"></span>${esc(m.hostname || '')}</h3></div>
        <div class="kv">
          <div><span>Hostname</span><span class="mono">${esc(m.hostname || '—')}</span></div>
          <div><span>ประเภท / Node</span><span>${esc(m.type || '—')}${m.cluster && m.cluster.node_name ? ` · ${esc(m.cluster.node_name)}` : ''}</span></div>
          <div><span>Build</span><span class="mono">${esc(m.compilationDate ? String(m.compilationDate).slice(0, 10) : '—')}${m.revision ? ` · rev ${esc(m.revision)}` : ''}</span></div>
          <div><span>Max agents</span><span class="mono">${esc(m.maxAgents || '—')}</span></div>
          <div><span>ตรวจไฟล์ ossec.conf</span><span>${(m.validation || []).map((v) => `<span class="pill ${v.status === 'OK' ? 'ok' : 'bad'}" title="${esc(v.details || '')}">${esc(v.name)} ${esc(v.status)}</span>`).join(' ') || '—'}</span></div>
        </div>
        <div class="sub-h" style="margin-top:12px">Daemons</div>
        <div class="wz-daemons">${daemons.map(([k, v]) => `<span class="pill ${v === 'running' ? 'ok' : v === 'stopped' ? 'muted' : 'bad'}">${esc(k.replace(/^wazuh-/, ''))}</span>`).join('')}</div>
      </div>
      <div class="card panel"><div class="ph"><h3>${icon('activity', 17)}<span class="th">สถิติ Component</span><span class="bar"></span>analysisd · remoted</h3></div>
        ${statsHtml(L)}
      </div>
    </div>
    <div class="card panel"><div class="ph"><h3>${icon('chart', 17)}<span class="th">Alerts / Events รายชั่วโมง (วันนี้)</span><span class="bar"></span>/manager/stats</h3></div>
      ${legend([['#f0425f', 'Alerts'], ['#24a0e6', 'Events (แกนเดียวกัน ÷100)', true], ['#f59e0b', 'Syscheck (FIM)', true]])}
      <div id="wzChart" class="rchart-host"></div></div>
    <div class="card panel"><div class="ph"><h3>${icon('server', 17)}<span class="th">Agents · SCA · CIS-CAT</span><span class="bar"></span>${(L && L.agents || []).length} เครื่อง</h3>
      <span class="right" style="text-transform:none"><input class="inp" id="wzAq" placeholder="ค้นหาชื่อ / IP / OS" value="${esc(WZ.aq)}" style="width:220px;height:32px"></span></div>
      <div id="wzAgents"></div></div>
    ${can('admin') ? `<div class="card panel"><div class="ph"><h3>${icon('sliders', 17)}<span class="th">ค่า Configuration ของ Manager</span><span class="bar"></span>/manager/configuration</h3></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select class="inp" id="wzSec" style="width:auto">${WZ_SECTIONS.map((x) => `<option ${x === WZ.cfgSection ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <button class="btn sm" data-act="wzcfgget">${icon('download', 14)} ดึงค่า</button><span class="hint">อ่านอย่างเดียว · ใช้ตรวจว่า ossec.conf ตั้งค่าตามที่ต้องการ</span></div>
      <pre class="code-block wz-json" id="wzCfgOut">เลือก section แล้วกด “ดึงค่า”</pre></div>` : ''}
    <div class="grid g2">${inboundCard(d)}${pushCard(d)}</div>`;
  drawWzChart();
  renderAgents();
  const aq = $('#wzAq'); if (aq) aq.addEventListener('input', (e) => { WZ.aq = e.target.value; renderAgents(); });
  const sec = $('#wzSec'); if (sec) sec.addEventListener('change', (e) => { WZ.cfgSection = e.target.value; });
}
function statsHtml(L) {
  const a = (L && L.analysisd) || {}, r = (L && L.remoted) || {};
  const g = (o, ...ks) => { for (const k of ks) if (o[k] != null) return o[k]; return null; };
  const pct = (v) => (v == null ? '—' : `${(Number(v) * (Number(v) <= 1 ? 100 : 1)).toFixed(1)}%`);
  const bar = (v) => { const p = v == null ? 0 : Math.min(100, Number(v) * (Number(v) <= 1 ? 100 : 1)); return `<span class="wz-meter"><i style="width:${p}%;background:${p > 70 ? 'var(--bad)' : p > 40 ? 'var(--warn)' : 'var(--ok)'}"></i></span>`; };
  if (!Object.keys(a).length && !Object.keys(r).length) return '<div class="empty">ไม่มีข้อมูลสถิติ (ต้องมีสิทธิ์ manager:read)</div>';
  return `<div class="kv">
    <div><span>Events ที่รับ / ประมวลผล</span><span class="mono">${fNum(g(a, 'events.received', 'total_events_decoded'))} / ${fNum(g(a, 'events.processed', 'events_processed'))}</span></div>
    <div><span>Alerts ที่เขียน</span><span class="mono">${fNum(g(a, 'events.written_breakdown.alerts', 'alerts_written'))}</span></div>
    <div><span>Events ที่ทิ้ง (dropped)</span><span class="mono">${fNum(g(a, 'events.dropped', 'events_dropped') ?? Object.entries(a).filter(([k]) => k.includes('dropped_breakdown')).reduce((s, [, v]) => s + Number(v || 0), 0))}</span></div>
    <div><span>Event queue</span><span class="mono">${bar(g(a, 'queues.eventqueue.usage', 'event_queue_usage'))} ${pct(g(a, 'queues.eventqueue.usage', 'event_queue_usage'))}</span></div>
    <div><span>Alerts queue</span><span class="mono">${bar(g(a, 'queues.alerts.usage', 'alerts_queue_usage'))} ${pct(g(a, 'queues.alerts.usage', 'alerts_queue_usage'))}</span></div>
    <div><span>remoted: ข้อความจาก Agent</span><span class="mono">${fNum(g(r, 'messages.received_breakdown.event', 'evt_count'))}</span></div>
    <div><span>remoted: TCP sessions</span><span class="mono">${fNum(g(r, 'tcp_sessions'))}</span></div>
    <div><span>remoted: รับ / ส่ง</span><span class="mono">${fBytesN(g(r, 'bytes.received', 'recv_bytes'))} / ${fBytesN(g(r, 'bytes.sent', 'sent_bytes'))}</span></div>
    <div><span>ทำงานตั้งแต่</span><span class="mono">${a.uptime ? fmtDT(a.uptime) : '—'}</span></div></div>`;
}
function drawWzChart() {
  const host = $('#wzChart'), L = WZ.data.last; if (!host) return;
  const hs = (L && L.hourly) || [];
  if (!hs.length) { host.innerHTML = '<div class="empty">ยังไม่มีสถิติวันนี้</div>'; return; }
  const by = {}; hs.forEach((h) => { by[h.hour] = h; });
  const hours = Array.from({ length: 24 }, (_, i) => i), cur = new Date().getHours();
  const v = (k, f = 1) => hours.map((i) => (by[i] ? by[i][k] / f : (i <= cur ? null : null)));
  drawChart(host, { labels: hours.map((i) => `${p2(i)}:00`), height: 230,
    bars: [{ values: v('alerts'), color: '#f0425f', name: 'Alerts' }],
    lines: [{ values: v('events', 100), color: '#24a0e6', dashed: true }, { values: v('syscheck'), color: '#f59e0b', dashed: true }],
    tooltip: (i) => { const h = by[i]; return h ? `<b>${p2(i)}:00–${p2(i + 1)}:00</b><div>Alerts: <b>${fNum(h.alerts)}</b></div><div>Events: ${fNum(h.events)}</div><div>Syscheck: ${fNum(h.syscheck)} · Firewall: ${fNum(h.firewall)}</div>
      ${(h.top || []).length ? `<div class="faint" style="margin-top:4px">Rule ที่พบมาก: ${h.top.slice(0, 3).map((t) => `${t.sigid} (L${t.level}) ×${t.times}`).join(', ')}</div>` : ''}` : `<b>${p2(i)}:00</b><div class="faint">ไม่มีข้อมูล</div>`; } });
}
function renderAgents() {
  const host = $('#wzAgents'), L = WZ.data.last; if (!host) return;
  const q = WZ.aq.trim().toLowerCase();
  const list = ((L && L.agents) || []).filter((a) => !q || `${a.id} ${a.name} ${a.ip} ${a.os} ${(a.group || []).join(' ')}`.toLowerCase().includes(q));
  if (!list.length) { host.innerHTML = '<div class="empty">ไม่พบ Agent</div>'; return; }
  const devIp = new Map(devs().map((d) => [d.ip, d]));
  host.innerHTML = `<div class="tblwrap"><table class="tbl"><thead><tr><th>ID</th><th>Agent</th><th>สถานะ</th><th>OS / เวอร์ชัน</th><th>SCA (CIS)</th><th>CIS-CAT</th><th></th></tr></thead><tbody>
    ${list.map((a) => {
      const st = AG_ST[a.status] || [a.status, 'muted'], sca = (L.sca || {})[a.id], cc = (L.ciscat || {})[a.id], dv = devIp.get(a.ip);
      const best = sca && sca.length ? sca[0] : null;
      return `<tr><td class="mono">${esc(a.id)}</td>
        <td><b>${esc(a.name)}</b><div class="mono faint" style="font-size:11.5px">${esc(a.ip || '')}${dv ? ` · <span title="อุปกรณ์ใน Smart Topology">${icon('network', 11)} ${esc(dv.name)}</span>` : ''}</div></td>
        <td><span class="pill ${st[1]}">${st[0]}</span>${a.status !== 'active' && a.lastKeepAlive ? `<div class="faint" style="font-size:11px">ล่าสุด ${wzAgo(a.lastKeepAlive)}ที่แล้ว</div>` : ''}</td>
        <td style="font-size:12px">${esc(a.os || '—')}<div class="faint">${esc(a.version || '')}${(a.group || []).length ? ` · ${esc(a.group.join(', '))}` : ''}</div></td>
        <td>${best ? `<span class="wz-score ${scoreCls(best.score)}">${best.score}%</span><div class="faint" style="font-size:11px">ผ่าน ${best.pass} · ไม่ผ่าน ${best.fail}${sca.length > 1 ? ` · +${sca.length - 1} policy` : ''}</div>` : '<span class="faint">—</span>'}</td>
        <td>${cc ? `<span class="wz-score ${scoreCls(cc.score)}">${cc.score}%</span><div class="faint" style="font-size:11px">ผ่าน ${cc.pass} · ไม่ผ่าน ${cc.fail}</div>` : '<span class="faint">—</span>'}</td>
        <td>${best || cc ? `<button class="btn sm" data-act="wzagent" data-aid="${esc(a.id)}">รายละเอียด</button>` : ''}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="hint" style="margin-top:6px">SCA = Security Configuration Assessment ของ Wazuh (ตรวจตาม CIS Benchmark ในตัว) · CIS-CAT = ผลจากโปรแกรม CIS-CAT Pro ที่รันผ่าน wodle ciscat · ดึงคะแนนสูงสุด ${WZ.data.config ? WZ.data.config.scaMax : 20} เครื่องต่อรอบ</div>`;
}
function agentModal(aid) {
  const L = WZ.data.last, a = L.agents.find((x) => x.id === aid), sca = (L.sca || {})[aid] || [], cc = (L.ciscat || {})[aid];
  const m = modal(`<div class="mh">${icon('shield', 20)}<h2>${esc(a.name)} <span class="mono faint" style="font-size:14px">#${esc(a.id)} · ${esc(a.ip)}</span></h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <div class="mb">
      <div class="sub-h">SCA — Security Configuration Assessment</div>
      ${sca.length ? sca.map((p) => `<div class="wz-pol"><div class="wz-polh"><span class="wz-score ${scoreCls(p.score)}">${p.score}%</span><div><b>${esc(p.name)}</b><div class="faint mono" style="font-size:11.5px">${esc(p.policy_id)} · สแกนล่าสุด ${fmtDT(p.end_scan)}</div></div></div>
        <div class="wz-stack"><i class="ok" style="flex:${p.pass}"></i><i class="bad" style="flex:${p.fail}"></i><i class="muted" style="flex:${p.invalid || 0}"></i></div>
        <div class="faint" style="font-size:12px">ผ่าน ${p.pass} · ไม่ผ่าน ${p.fail} · ไม่เกี่ยวข้อง ${p.invalid || 0} · ทั้งหมด ${p.total}</div>
        <div style="margin-top:6px;display:flex;gap:6px"><button class="btn sm" data-act="wzchecks" data-aid="${esc(aid)}" data-pol="${esc(p.policy_id)}" data-r="failed">ดูข้อที่ไม่ผ่าน</button><button class="btn sm" data-act="wzchecks" data-aid="${esc(aid)}" data-pol="${esc(p.policy_id)}" data-r="passed">ข้อที่ผ่าน</button></div>
        <div class="wz-checks" id="chk-${esc(p.policy_id)}"></div></div>`).join('') : '<div class="empty">ไม่มีผล SCA</div>'}
      <div class="sub-h" style="margin-top:14px">CIS-CAT</div>
      ${cc ? `<div class="kv"><div><span>Benchmark</span><span>${esc(cc.benchmark)}</span></div><div><span>Profile</span><span class="mono" style="font-size:11.5px">${esc(cc.profile || '—')}</span></div>
        <div><span>คะแนน</span><span class="wz-score ${scoreCls(cc.score)}">${cc.score}%</span></div><div><span>ผ่าน / ไม่ผ่าน / Error / ไม่ได้ตรวจ / ไม่ทราบ</span><span class="mono">${cc.pass} / ${cc.fail} / ${cc.error} / ${cc.notchecked} / ${cc.unknown}</span></div>
        <div><span>เวลาสแกน</span><span>${fmtDT(cc.time)}</span></div></div>` : '<div class="empty">ไม่มีผล CIS-CAT (ต้องติดตั้ง CIS-CAT Pro และเปิด wodle ciscat บน Agent)</div>'}
    </div><div class="mf"><button class="btn primary" data-act="mclose">ปิด</button></div>`, 'wide');
  return m;
}
async function loadChecks(el) {
  const out = document.getElementById(`chk-${el.dataset.pol}`);
  out.innerHTML = `<div class="empty">${icon('refresh', 18, 'spin')}</div>`;
  try {
    const r = await api('GET', `/api/wazuh/sca/${encodeURIComponent(el.dataset.aid)}/${encodeURIComponent(el.dataset.pol)}?result=${el.dataset.r}`);
    out.innerHTML = r.checks.length ? r.checks.map((c) => `<details class="wz-chk"><summary><span class="pill ${c.result === 'failed' ? 'bad' : c.result === 'passed' ? 'ok' : 'muted'}">${esc(c.result)}</span> <span class="mono faint">${c.id}</span> ${esc(c.title)}
      ${(c.compliance || []).filter((x) => x.key === 'cis').map((x) => `<span class="pill muted mono">CIS ${esc(x.value)}</span>`).join('')}</summary>
      ${c.rationale ? `<p><b>เหตุผล:</b> ${esc(c.rationale)}</p>` : ''}${c.remediation ? `<p><b>วิธีแก้ไข:</b> ${esc(c.remediation)}</p>` : ''}
      ${(c.compliance || []).length ? `<p class="faint mono" style="font-size:11px">${c.compliance.map((x) => `${esc(x.key)}: ${esc(x.value)}`).join(' · ')}</p>` : ''}</details>`).join('')
      : '<div class="empty">ไม่มีรายการ</div>';
  } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function inboundCard(d) {
  return `<div class="card panel"><div class="ph"><h3>${icon('download', 17)}<span class="th">Alert ที่รับจาก Wazuh</span><span class="bar"></span>Wazuh → Smart Topology</h3></div>
    ${d.inbound.length ? `<div class="wz-feed">${d.inbound.slice(0, 30).map((x) => `<div class="wz-item ${x.accepted ? '' : 'dim'}">
      <span class="wz-lv ${lvCls(x.level)}">L${x.level}</span>
      <div><b>${esc(x.description)}</b><div class="faint" style="font-size:11.5px">rule ${esc(x.ruleId)} · ${esc(x.agent || '')} ${x.ip ? `(${esc(x.ip)})` : ''} · ${fmtDT(x.at)}
        ${x.accepted ? (x.isNew ? ' · <span style="color:var(--bad)">สร้างการแจ้งเตือนใหม่</span>' : ' · รวมกับการแจ้งเตือนเดิม') : ` · ข้าม: ${esc(x.skipped || '')}`}</div></div></div>`).join('')}</div>`
    : `<div class="empty">ยังไม่มี Alert ที่รับเข้ามา<div class="hint">ติดตั้งสคริปต์ custom-smarttopology บน Wazuh Manager (ดูปุ่ม “ตั้งค่า” → ขั้นตอนรับ Alert)</div></div>`}</div>`;
}
function pushCard(d) {
  return `<div class="card panel"><div class="ph"><h3>${icon('upload', 17)}<span class="th">Event ที่ส่งเข้า Wazuh</span><span class="bar"></span>POST /events</h3>
    <span class="right">${d.config && d.config.pushEnabled ? `<span class="pill ok">เปิด ≥ ${esc(d.config.pushMinSeverity)}</span>` : '<span class="pill muted">ปิด</span>'}${d.queue ? ` <span class="pill warn">รอส่ง ${d.queue}</span>` : ''}</span></div>
    ${d.pushLog.length ? `<div class="wz-feed">${d.pushLog.slice(0, 30).map((x) => `<div class="wz-item"><span class="sdot c-${x.ok ? 'ok' : 'bad'}"></span>
      <div><b>${x.ok ? 'ส่งสำเร็จ' : 'ส่งไม่สำเร็จ'}</b> ${x.count} event<div class="faint" style="font-size:11.5px">${fmtDT(x.at)} · ${esc(x.info || '')}</div></div></div>`).join('')}</div>`
    : '<div class="empty">ยังไม่มีการส่ง Event</div>'}</div>`;
}

/* ---------------------------------------------------------------- config modal */
function wzCfgModal() {
  const c = Object.assign({ url: '', user: 'wazuh', password: '', verifyTls: false, intervalMin: 5, scaMax: 20, pushEnabled: false, pushMinSeverity: 'warning',
    inboundEnabled: true, inboundMinLevel: 7, inboundNotifyLevel: 12, inboundAutoResolveMin: 60, agentAlerts: true, enabled: false }, WZ.data.config || {});
  const hook = `${location.origin}/api/v1/integrations/wazuh`;
  const m = modal(`<div class="mh">${icon('shield', 20)}<h2>ตั้งค่าการเชื่อมต่อ Wazuh</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="wzForm"><div class="mb"><div id="wzErr" class="err hidden"></div>
      <div class="mtabs" id="wzTabs"><button type="button" data-wt="1" class="on">1. Wazuh API</button><button type="button" data-wt="2">2. ส่ง Event เข้า Wazuh</button><button type="button" data-wt="3">3. รับ Alert จาก Wazuh</button></div>
      <div class="wzt" data-wt="1"><div class="form">
        <div class="full" style="display:flex;align-items:center;gap:10px"><label class="switch"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}><span></span></label><b>เปิดการดึงข้อมูลจาก Wazuh Server API</b></div>
        <div class="full"><label>URL ของ Wazuh Server API <span class="req">*</span></label><input class="inp mono" name="url" value="${esc(c.url)}" placeholder="https://172.16.1.30:55000"><div class="hint">พอร์ตเริ่มต้น 55000 (ไม่ใช่พอร์ต 443 ของ Dashboard)</div></div>
        <div><label>ชื่อผู้ใช้ API <span class="req">*</span></label><input class="inp mono" name="user" value="${esc(c.user)}" autocomplete="off"></div>
        <div><label>รหัสผ่าน</label><input class="inp" type="password" name="password" value="${esc(c.password)}" autocomplete="new-password"><div class="hint">เว้น •••••••• ไว้ = ใช้รหัสเดิม</div></div>
        <label class="check full"><input type="checkbox" name="verifyTls" ${c.verifyTls ? 'checked' : ''}> ตรวจสอบใบรับรอง TLS (ปิดไว้ถ้า Wazuh ใช้ self-signed certificate ค่าเริ่มต้น)</label>
        <div><label>ดึงข้อมูลทุก (นาที)</label><input class="inp" type="number" min="1" max="1440" name="intervalMin" value="${c.intervalMin}"></div>
        <div><label>ดึงผล SCA/CIS-CAT สูงสุด (เครื่อง/รอบ)</label><input class="inp" type="number" min="0" max="200" name="scaMax" value="${c.scaMax}"></div>
        <label class="check full"><input type="checkbox" name="agentAlerts" ${c.agentAlerts ? 'checked' : ''}> แจ้งเตือนเมื่อ Wazuh Agent ขาดการเชื่อมต่อ / กลับมาทำงาน</label>
        <div class="full"><button type="button" class="btn" data-act="wztest">${icon('activity', 15)} ทดสอบการเชื่อมต่อ</button> <span id="wzTestOut" class="hint"></span></div>
      </div></div>
      <div class="wzt hidden" data-wt="2"><div class="form">
        <label class="check full"><input type="checkbox" name="pushEnabled" ${c.pushEnabled ? 'checked' : ''}> ส่งการแจ้งเตือนของ Smart Topology เข้า Wazuh (เกิดปัญหา / แก้ไขแล้ว)</label>
        <div><label>ส่งเฉพาะระดับตั้งแต่</label><select class="inp" name="pushMinSeverity">${['info', 'warning', 'critical'].map((x) => `<option ${c.pushMinSeverity === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div class="full hint">ใช้ <span class="mono">POST /events</span> ของ Wazuh Server API (Wazuh 4.6 ขึ้นไป) รวมส่งทุก 10 วินาที ครั้งละไม่เกิน 100 event · ผู้ใช้ API ต้องมีสิทธิ์ <span class="mono">event:ingest</span>
          · ติดตั้งไฟล์ rule ให้ Wazuh สร้าง alert จาก event: <a href="/integrations/wazuh/smart_topology_rules.xml" download>smart_topology_rules.xml</a> → <span class="mono">/var/ossec/etc/rules/</span></div>
      </div></div>
      <div class="wzt hidden" data-wt="3"><div class="form">
        <label class="check full"><input type="checkbox" name="inboundEnabled" ${c.inboundEnabled ? 'checked' : ''}> รับ Alert จาก Wazuh เข้ามาเป็นการแจ้งเตือน</label>
        <div><label>รับเฉพาะ rule level ≥</label><input class="inp" type="number" min="0" max="16" name="inboundMinLevel" value="${c.inboundMinLevel}"></div>
        <div><label>ส่งแจ้งเตือนภายนอก (หมอพร้อม/LINE) เมื่อ level ≥</label><input class="inp" type="number" min="0" max="16" name="inboundNotifyLevel" value="${c.inboundNotifyLevel}"></div>
        <div><label>ปิดอัตโนมัติเมื่อไม่พบซ้ำภายใน (นาที)</label><input class="inp" type="number" min="1" name="inboundAutoResolveMin" value="${c.inboundAutoResolveMin}"></div>
        <div class="full"><div class="sub-h">ขั้นตอนติดตั้งบน Wazuh Manager</div>
          <ol class="wz-steps">
            <li>สร้าง API Key ประเภท <b>Integration</b> <button type="button" class="btn sm" data-act="wzkey">${icon('key', 13)} สร้าง Key สำหรับ Wazuh</button></li>
            <li>ดาวน์โหลดสคริปต์ <a href="/integrations/wazuh/custom-smarttopology" download>custom-smarttopology</a> ไปไว้ที่ <span class="mono">/var/ossec/integrations/</span> แล้ว <span class="mono">chmod 750</span>, <span class="mono">chown root:wazuh</span></li>
            <li>เพิ่มใน <span class="mono">/var/ossec/etc/ossec.conf</span> แล้ว <span class="mono">systemctl restart wazuh-manager</span>
              <div class="code-block" style="user-select:all;color:var(--text)">${esc(ossecSnippet(hook, 'stk_xxxxxxxx', c.inboundMinLevel))}</div></li>
          </ol></div>
      </div></div>
    </div>
    <div class="mf"><button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('check', 16)} บันทึก</button></div></form>`, 'wide');
  m.querySelectorAll('#wzTabs button').forEach((b) => b.addEventListener('click', () => {
    m.querySelectorAll('#wzTabs button').forEach((x) => x.classList.toggle('on', x === b));
    m.querySelectorAll('.wzt').forEach((x) => x.classList.toggle('hidden', x.dataset.wt !== b.dataset.wt));
  }));
  m.querySelector('#wzForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { WZ.data = await api('PUT', '/api/wazuh/config', wzForm()); closeModal(); toast('บันทึกการตั้งค่า Wazuh แล้ว', 'ok'); renderWz(); }
    catch (ex) { const er = $('#wzErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}
function wzForm() {
  const f = $('#wzForm'), o = {};
  ['url', 'user', 'password', 'intervalMin', 'scaMax', 'pushMinSeverity', 'inboundMinLevel', 'inboundNotifyLevel', 'inboundAutoResolveMin'].forEach((k) => { o[k] = f[k].value; });
  ['enabled', 'verifyTls', 'agentAlerts', 'pushEnabled', 'inboundEnabled'].forEach((k) => { o[k] = f[k].checked; });
  return o;
}
function ossecSnippet(hook, key, level) {
  return `<integration>\n  <name>custom-smarttopology</name>\n  <hook_url>${hook}</hook_url>\n  <api_key>${key}</api_key>\n  <level>${level}</level>\n  <alert_format>json</alert_format>\n</integration>`;
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (!a.startsWith('wz')) return;
  try {
    if (a === 'wzcfg') wzCfgModal();
    else if (a === 'wzrefresh') { el.disabled = true; el.innerHTML = `${icon('refresh', 14, 'spin')} กำลังดึง...`; WZ.data = Object.assign(WZ.data, await api('POST', '/api/wazuh/refresh')); renderWz(); toast(WZ.data.last && WZ.data.last.ok ? 'ดึงข้อมูล Wazuh เรียบร้อย' : 'ดึงข้อมูลไม่สำเร็จ', WZ.data.last && WZ.data.last.ok ? 'ok' : 'bad'); }
    else if (a === 'wzpush') { const { result: r } = await api('POST', '/api/wazuh/push-test'); toast(r.ok ? `ส่ง Event ทดสอบสำเร็จ: ${r.info}` : `ส่งไม่สำเร็จ: ${r.info}`, r.ok ? 'ok' : 'bad'); loadWz(true); }
    else if (a === 'wztest') {
      const out = $('#wzTestOut'); out.textContent = 'กำลังทดสอบ...'; out.style.color = '';
      const r = await api('POST', '/api/wazuh/test', wzForm());
      out.innerHTML = r.ok ? `✓ เชื่อมต่อสำเร็จ — Wazuh ${esc(r.version || r.apiVersion || '')} (${esc(r.hostname || '')})` : `✗ ${esc(r.error)}`;
      out.style.color = r.ok ? 'var(--ok)' : 'var(--bad)';
    }
    else if (a === 'wzagent') agentModal(el.dataset.aid);
    else if (a === 'wzchecks') loadChecks(el);
    else if (a === 'wzcfgget') {
      const out = $('#wzCfgOut'); out.textContent = 'กำลังดึง...';
      try { const r = await api('GET', `/api/wazuh/configuration?section=${encodeURIComponent($('#wzSec').value)}`); out.textContent = JSON.stringify(r.config, null, 2); }
      catch (ex) { out.textContent = ex.message; }
    }
    else if (a === 'wzkey') {
      const lvl = $('#wzForm') ? $('#wzForm').inboundMinLevel.value : 7;
      apiKeyModal({ name: 'Wazuh Manager', role: 'integration', expiresDays: 0,
        after: (tok) => `<div class="sub-h" style="margin-top:14px">วางใน /var/ossec/etc/ossec.conf ของ Wazuh Manager</div>
          <div class="code-block" style="user-select:all;color:var(--text)">${esc(ossecSnippet(`${location.origin}/api/v1/integrations/wazuh`, tok, lvl))}</div>
          <div class="hint">จากนั้น <span class="mono">systemctl restart wazuh-manager</span> และดูผลที่ <span class="mono">/var/ossec/logs/integrations.log</span></div>` });
    }
  } catch (ex) { toast(ex.message, 'bad'); }
});
