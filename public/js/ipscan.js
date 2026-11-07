'use strict';
/* ============================================================
   สแกน IP — กำหนดช่วง IP, สแกน, เปรียบเทียบจำนวน IP ที่ใช้งานจริงกับทะเบียนคอมพิวเตอร์
   ============================================================ */
const SC = { data: null, poll: null, filter: 'all', cur: null };
const SC_CLS = { asset: ['ทะเบียนคอมพิวเตอร์', '#0e9b87'], both: ['คอมพิวเตอร์ + อุปกรณ์เครือข่าย', '#0e9b87'], device: ['อุปกรณ์เครือข่าย', '#24a0e6'], unknown: ['ไม่อยู่ในทะเบียน', '#f59e0b'], off: ['อยู่ในทะเบียนแต่ไม่พบ', '#f0425f'], free: ['ว่าง', 'var(--line)'] };
const ipN = (ip) => ip.split('.').reduce((a, x) => a * 256 + Number(x), 0);
const nIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

function vIpScan() {
  $('#view').innerHTML = `<div id="scBody"><div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}</div></div></div>`;
  loadScan();
}
async function loadScan() {
  try { SC.data = await api('GET', '/api/ipscan'); renderScan(); if (SC.data.job.running) startPoll(); }
  catch (e) { const b = $('#scBody'); if (b) b.innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
}
function startPoll() {
  clearInterval(SC.poll);
  SC.poll = setInterval(async () => {
    if (S.tab !== 'ipscan') { clearInterval(SC.poll); return; }
    try {
      const j = await api('GET', '/api/ipscan/status');
      SC.data.job = j; renderJob();
      if (!j.running) { clearInterval(SC.poll); toast(`สแกนเสร็จ: ${j.done}/${j.total} IP พบ ${j.found} เครื่อง${j.cancel ? ' (ยกเลิก)' : ''}`, 'ok'); loadScan(); }
    } catch { /* ignore */ }
  }, 1500);
}
function renderJob() {
  const j = SC.data.job, el = $('#scJob'); if (!el) return;
  if (!j.running) { el.innerHTML = j.finishedAt ? `<span class="faint">สแกนล่าสุด ${fmtDT(j.finishedAt)} โดย ${esc(j.by)} · ${j.done}/${j.total} IP · พบ ${j.found}</span>` : ''; return; }
  const p = j.total ? Math.round((j.done / j.total) * 100) : 0;
  el.innerHTML = `<div class="sc-prog"><div><b>${icon('refresh', 14, 'spin')} กำลังสแกน ${esc(j.current || '')}</b> <span class="mono">${j.done}/${j.total} IP · พบ ${j.found}</span></div><i><em style="width:${p}%"></em></i></div>
    ${can('operator') ? `<button class="btn sm" data-act="sccancel">หยุด</button>` : ''}`;
}
function renderScan() {
  const D = SC.data, T = D.totals;
  const scanned = D.ranges.some((r) => r.summary && r.summary.scannedAt);
  $('#scBody').innerHTML = `
    <div class="card panel wz-bar">
      <div class="wz-title">${icon('scan', 22)}<div><b>สแกน IP ในเครือข่าย</b><div class="faint">${D.ranges.length} ช่วง · ${fNum(T.total || 0)} IP${D.settings.schedule.enabled ? ` · สแกนอัตโนมัติ${D.settings.schedule.everyHours >= 24 ? ` ทุกวัน ${D.settings.schedule.at} น.` : ` ทุก ${D.settings.schedule.everyHours} ชม.`}` : ''}</div></div></div>
      <span id="scJob" style="display:flex;align-items:center;gap:10px;flex:1"></span>
      ${can('operator') ? `<button class="btn sm primary" data-act="scrun" ${D.ranges.length ? '' : 'disabled'}>${icon('scan', 14)} สแกนทุกช่วง</button>` : ''}
      ${can('admin') ? `<button class="btn sm" data-act="scadd">${icon('plus', 14)} เพิ่มช่วง IP</button><button class="btn sm" data-act="scset">${icon('sliders', 14)} ตั้งค่า</button>` : ''}
    </div>
    ${D.ranges.length ? `
    <div class="grid g4 iv-kpis">
      <div class="card kpi"><div class="h">IP ที่ใช้งานจริง ${icon('activity', 18)}</div><div class="v">${fNum(T.alive || 0)}<small>/ ${fNum(T.total || 0)} IP</small></div><div class="row"><span>อัตราการใช้</span><span class="mono">${T.total ? Math.round(((T.alive || 0) / T.total) * 1000) / 10 : 0}%</span></div></div>
      <div class="card kpi"><div class="h">ทะเบียนคอมพิวเตอร์ ${icon('monitor', 18)}</div><div class="v">${fNum(T.registered)}<small>เครื่อง</small></div><div class="row"><span>พบตอนสแกน</span><span class="mono" style="color:var(--ok)">${fNum(T.asset || 0)}</span></div></div>
      <div class="card kpi"><div class="h">ไม่อยู่ในทะเบียน ${icon('alert', 18)}</div><div class="v" style="color:${T.unknown ? 'var(--warn)' : ''}">${fNum(T.unknown || 0)}<small>IP</small></div><div class="row"><span>อุปกรณ์เครือข่ายที่พบ</span><span class="mono">${fNum(T.device || 0)}</span></div></div>
      <div class="card kpi"><div class="h">อยู่ในทะเบียนแต่ไม่พบ ${icon('eyeoff', 18)}</div><div class="v" style="color:${T.assetsOffline ? 'var(--bad)' : ''}">${fNum(T.assetsOffline || 0)}<small>เครื่อง</small></div><div class="row"><span>ปิดเครื่อง / ย้าย / เปลี่ยน IP</span><span></span></div></div>
    </div>
    ${scanned ? compareCard(T) : '<div class="card panel"><div class="empty">ยังไม่ได้สแกน — กด “สแกนทุกช่วง” หรือปุ่มสแกนของแต่ละช่วง</div></div>'}
    <div class="card panel"><div class="ph"><h3>${icon('list', 17)}<span class="th">ช่วง IP ที่สแกน</span><span class="bar"></span>${D.ranges.length} ช่วง</h3></div>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>ชื่อช่วง</th><th>ช่วง IP</th><th style="min-width:150px">ใช้งาน</th><th>ทะเบียนคอม</th><th>อุปกรณ์</th><th>ไม่อยู่ในทะเบียน</th><th>ทะเบียนแต่ไม่พบ</th><th>สแกนล่าสุด</th><th></th></tr></thead><tbody>
      ${D.ranges.map((r) => { const s = r.summary || {}; return `<tr class="${r.enabled ? '' : 'dim'}">
        <td><b>${esc(r.name)}</b>${r.vlan ? ` <span class="pill muted mono">VLAN ${esc(r.vlan)}</span>` : ''}${r.note ? `<div class="faint" style="font-size:11px">${esc(r.note)}</div>` : ''}</td>
        <td class="mono" style="font-size:12px">${esc(r.spec)}<div class="faint">${esc(r.first)} – ${esc(r.last)} (${fNum(r.count)})</div></td>
        <td>${s.scannedAt ? `<div class="sc-util"><i><em style="width:${Math.min(100, s.util)}%;background:${s.util > 90 ? 'var(--bad)' : s.util > 75 ? 'var(--warn)' : 'var(--brand)'}"></em></i><span class="mono">${s.alive}/${s.total} · ${s.util}%</span></div>` : '<span class="faint">ยังไม่สแกน</span>'}</td>
        <td class="mono" style="color:var(--ok)">${s.scannedAt ? s.asset : '—'}</td><td class="mono">${s.scannedAt ? s.device : '—'}</td>
        <td class="mono" style="color:${s.unknown ? 'var(--warn)' : ''}">${s.scannedAt ? s.unknown : '—'}</td>
        <td class="mono" style="color:${s.assetsOffline ? 'var(--bad)' : ''}">${s.scannedAt ? s.assetsOffline : '—'}</td>
        <td style="font-size:12px">${s.scannedAt ? `${fmtDT(s.scannedAt)}<div class="faint">${(s.ms / 1000).toFixed(1)} วินาที${s.appeared ? ` · ใหม่ +${s.appeared}` : ''}${s.gone ? ` · หาย −${s.gone}` : ''}</div>` : '—'}</td>
        <td><div class="acts">${s.scannedAt ? `<button class="btn sm" data-act="scview" data-id="${r.id}">ดูผล</button>` : ''}
          ${can('operator') ? `<button class="btn sm" data-act="scrun1" data-id="${r.id}" title="สแกนช่วงนี้">${icon('scan', 14)}</button>` : ''}
          ${can('admin') ? `<button class="btn sm" data-act="scedit" data-id="${r.id}" title="แก้ไข">${icon('edit', 14)}</button><button class="btn sm danger" data-act="scdel" data-id="${r.id}" data-name="${esc(r.name)}" title="ลบ">${icon('trash', 14)}</button>` : ''}</div></td></tr>`; }).join('')}
      </tbody></table></div></div>
    ${D.history.length > 1 ? `<div class="card panel"><div class="ph"><h3>${icon('chart', 17)}<span class="th">จำนวน IP ที่ใช้งานจากการสแกนแต่ละครั้ง</span></h3></div><div id="scHist" class="rchart-host"></div></div>` : ''}`
    : `<div class="card panel wz-empty">${icon('scan', 44)}<h2>ยังไม่ได้กำหนดช่วง IP</h2><p class="muted">เพิ่มช่วง IP ของแต่ละ VLAN / อาคาร เช่น <span class="mono">172.16.10.0/24</span> หรือ <span class="mono">172.16.20.10-172.16.20.200</span>
      แล้วสแกนเพื่อนับจำนวน IP ที่ใช้งานจริง เทียบกับทะเบียนเครื่องคอมพิวเตอร์และอุปกรณ์เครือข่าย</p>${can('admin') ? `<button class="btn primary" data-act="scadd">${icon('plus', 16)} เพิ่มช่วง IP</button>` : ''}</div>`}`;
  renderJob();
  const h = $('#scHist');
  if (h) {
    const H = D.history.slice(-60);
    drawChart(h, { labels: H.map((x) => new Date(x.at).toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })), height: 200,
      bars: [{ values: H.map((x) => x.alive), color: '#0e9b87' }], yFmt: (v) => Math.round(v),
      tooltip: (i) => `<b>${esc(H[i].name)}</b><div>${new Date(H[i].at).toLocaleString('th-TH', { hour12: false })}</div><div>ใช้งาน <b>${H[i].alive}</b> / ${H[i].total} IP</div>` });
  }
}
function compareCard(T) {
  const rows = [['IP ที่ใช้งานจริง (สแกนพบ)', T.alive || 0, '#24a0e6'], ['ทะเบียนเครื่องคอมพิวเตอร์ (ทั้งหมด)', T.registered || 0, '#0e9b87'], ['— พบในการสแกน', T.asset || 0, '#5fc9b4'],
    ['อุปกรณ์เครือข่ายที่พบ', T.device || 0, '#8b5cf6'], ['IP ที่ไม่อยู่ในทะเบียนใดเลย', T.unknown || 0, '#f59e0b'], ['อยู่ในทะเบียนแต่ไม่พบตอนสแกน', T.assetsOffline || 0, '#f0425f']];
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const diff = (T.alive || 0) - (T.device || 0) - (T.registered || 0);
  return `<div class="card panel"><div class="ph"><h3>${icon('pie', 17)}<span class="th">เปรียบเทียบ IP ที่ใช้งานจริง กับ ทะเบียน</span></h3></div>
    <div class="sc-cmp">${rows.map(([l, n, c]) => `<div><span>${l}</span><i><b style="width:${(n / max) * 100}%;background:${c}"></b></i><em class="mono">${fNum(n)}</em></div>`).join('')}</div>
    <div class="hint" style="margin-top:8px">${diff > 0 ? `IP ที่ใช้งานมากกว่าทะเบียนคอมพิวเตอร์ + อุปกรณ์เครือข่าย <b>${fNum(diff)}</b> IP — ตรวจรายการ “ไม่อยู่ในทะเบียน” ในแต่ละช่วงเพื่อลงทะเบียนหรือตรวจสอบเครื่องแปลกปลอม`
    : 'จำนวนทะเบียนครอบคลุม IP ที่ใช้งานจริง'} · การจับคู่ใช้ IP และ MAC (MAC ได้เฉพาะช่วงที่อยู่ในเครือข่ายเดียวกับเซิร์ฟเวอร์)</div></div>`;
}

/* ---------------------------------------------------------------- range detail */
async function scView(id) {
  let r; try { r = await api('GET', `/api/ipscan/ranges/${id}`); } catch (e) { toast(e.message, 'bad'); return; }
  SC.cur = r; SC.filter = 'all';
  const c = r.compare;
  const m = modal(`<div class="mh">${icon('scan', 20)}<h2>${esc(r.range.name)} <span class="mono faint" style="font-size:14px">${esc(r.range.spec)}</span></h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <div class="mb">
      <div class="sc-sum">
        <div><b>${c.alive}</b><span>ใช้งาน / ${c.total} IP (${c.util}%)</span></div>
        <div style="color:#0e9b87"><b>${c.asset}</b><span>ทะเบียนคอมพิวเตอร์</span></div>
        <div style="color:#24a0e6"><b>${c.device}</b><span>อุปกรณ์เครือข่าย</span></div>
        <div style="color:#d97706"><b>${c.unknown}</b><span>ไม่อยู่ในทะเบียน</span></div>
        <div style="color:#f0425f"><b>${c.assetsOffline + c.devicesOffline}</b><span>ทะเบียนแต่ไม่พบ</span></div>
      </div>
      <div class="faint" style="font-size:12px;margin:6px 0 10px">สแกนเมื่อ ${fmtDT(c.scannedAt)} · ใช้เวลา ${(c.ms / 1000).toFixed(1)} วินาที${c.appearedIps.length ? ` · IP ใหม่จากครั้งก่อน: <span class="mono">${esc(c.appearedIps.slice(0, 10).join(', '))}${c.appearedIps.length > 10 ? '…' : ''}</span>` : ''}${c.goneIps.length ? ` · หายไป: <span class="mono">${esc(c.goneIps.slice(0, 10).join(', '))}${c.goneIps.length > 10 ? '…' : ''}</span>` : ''}</div>
      ${c.total <= 1024 ? `<div class="sub-h">แผนผัง IP</div><div class="sc-grid" id="scGrid"></div>${legend(Object.values(SC_CLS).filter((x, i) => i !== 1).map((x) => [x[1], x[0]]))}` : ''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 8px" id="scF">${[['all', 'ทั้งหมด'], ['unknown', 'ไม่อยู่ในทะเบียน'], ['asset', 'ทะเบียนคอมพิวเตอร์'], ['device', 'อุปกรณ์เครือข่าย'], ['off', 'ทะเบียนแต่ไม่พบ']].map(([k, l]) => `<button class="btn sm ${k === 'all' ? 'primary' : ''}" data-f="${k}">${l}</button>`).join('')}
        <span style="flex:1"></span><a class="btn sm" href="/api/ipscan/ranges/${r.range.id}/export.csv">${icon('download', 14)} CSV</a></div>
      <div id="scHosts"></div>
    </div><div class="mf"><button class="btn primary" data-act="mclose">ปิด</button></div>`, 'wide');
  m.querySelector('.modal').style.maxWidth = '1100px';
  if (c.total <= 1024) {
    const alive = new Map(c.hosts.map((h) => [h.ip, h])), off = new Map([...c.offAssets.map((a) => [a.ip, a.hostname]), ...c.offDevices.map((d) => [d.ip, d.name])]);
    let g = '';
    for (let n = ipN(c.first); n <= ipN(c.last); n++) {
      const ip = nIp(n), h = alive.get(ip), cls = h ? h.cls : off.has(ip) ? 'off' : 'free';
      const t = h ? `${ip} · ${SC_CLS[cls][0]}${h.asset ? ` · ${h.asset.hostname}` : h.device ? ` · ${h.device.name}` : h.name ? ` · ${h.name}` : ''}` : off.has(ip) ? `${ip} · ไม่พบ: ${off.get(ip)}` : `${ip} · ว่าง`;
      g += `<i class="c-${cls}" title="${esc(t)}" style="background:${SC_CLS[cls][1]}">${ip.split('.')[3]}</i>`;
    }
    m.querySelector('#scGrid').innerHTML = g;
  }
  m.querySelectorAll('#scF button[data-f]').forEach((b) => b.addEventListener('click', () => { SC.filter = b.dataset.f; m.querySelectorAll('#scF button[data-f]').forEach((x) => x.classList.toggle('primary', x === b)); renderHosts(); }));
  renderHosts();
}
function renderHosts() {
  const c = SC.cur.compare, f = SC.filter, out = $('#scHosts');
  if (f === 'off') {
    const L = [...c.offAssets.map((a) => ({ ...a, k: 'asset' })), ...c.offDevices.map((d) => ({ ...d, hostname: d.name, k: 'device' }))];
    out.innerHTML = L.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>IP</th><th>ชื่อในทะเบียน</th><th>ประเภท</th><th>หน่วยงาน</th><th>สถานะล่าสุด</th></tr></thead><tbody>
      ${L.map((x) => `<tr ${x.k === 'asset' ? `class="click" data-act="ivopen" data-id="${x.id}"` : ''}><td class="mono">${esc(x.ip || '—')}</td><td><b>${esc(x.hostname)}</b>${x.assetTag ? ` <span class="faint mono">${esc(x.assetTag)}</span>` : ''}</td>
        <td>${x.k === 'asset' ? 'คอมพิวเตอร์' : esc(x.type)}</td><td>${esc(x.department || '—')}</td><td>${x.k === 'asset' ? `${ivStPill(x.state)}${x.lastSeen ? ` <span class="faint">${ago(x.lastSeen)}</span>` : ''}` : stPill(x.status)}</td></tr>`).join('')}</tbody></table></div>`
      : '<div class="empty">ทุกเครื่องในทะเบียนพบตอนสแกน</div>';
    return;
  }
  const L = c.hosts.filter((h) => f === 'all' || h.cls === f || (f === 'asset' && h.cls === 'both'));
  out.innerHTML = L.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>IP</th><th>ชื่อ (DNS)</th><th>MAC</th><th>ตรวจพบ</th><th>การจับคู่</th><th>ชื่อในทะเบียน</th><th></th></tr></thead><tbody>
    ${L.map((h) => `<tr><td class="mono"><b>${esc(h.ip)}</b></td><td style="font-size:12px">${esc(h.name || '—')}</td><td class="mono" style="font-size:11.5px">${esc(h.mac || '—')}</td>
      <td class="mono" style="font-size:11.5px">${esc(h.via)} · ${h.rtt} ms</td>
      <td><span class="pill" style="background:${SC_CLS[h.cls][1]}22;color:${h.cls === 'unknown' ? '#a15c00' : SC_CLS[h.cls][1]}">${SC_CLS[h.cls][0]}</span>${h.asset && h.asset.byMac ? ' <span class="faint" title="จับคู่ด้วย MAC — IP ในทะเบียนไม่ตรง">(MAC)</span>' : ''}</td>
      <td>${h.asset ? `<a href="#" data-act="ivopen" data-id="${h.asset.id}">${esc(h.asset.hostname)}</a>${h.asset.department ? ` <span class="faint">${esc(h.asset.department)}</span>` : ''}` : h.device ? esc(h.device.name) : '<span class="faint">—</span>'}</td>
      <td>${h.cls === 'unknown' && can('operator') ? `<div class="acts"><button class="btn sm" data-act="screg" data-ip="${esc(h.ip)}" data-mac="${esc(h.mac || '')}" data-name="${esc(h.name || '')}">ลงทะเบียนคอม</button><button class="btn sm" data-act="scdev" data-ip="${esc(h.ip)}" data-name="${esc(h.name || '')}">เพิ่มเป็นอุปกรณ์</button></div>` : ''}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="empty">ไม่มีรายการ</div>';
}

/* ---------------------------------------------------------------- modals */
function rangeModal(r) {
  const v = r || { enabled: true };
  const m = modal(`<div class="mh">${icon(r ? 'edit' : 'plus', 20)}<h2>${r ? 'แก้ไขช่วง IP' : 'เพิ่มช่วง IP ที่จะสแกน'}</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="scForm"><div class="mb"><div id="scErr" class="err hidden"></div><div class="form">
      <div><label>ชื่อช่วง <span class="req">*</span></label><input class="inp" name="name" required maxlength="80" value="${esc(v.name || '')}" placeholder="เช่น VLAN 10 — OPD ชั้น 1"></div>
      <div><label>VLAN</label><input class="inp mono" name="vlan" value="${esc(v.vlan || '')}" placeholder="10"></div>
      <div class="full"><label>ช่วง IP <span class="req">*</span></label><input class="inp mono" name="spec" required value="${esc(v.spec || '')}" placeholder="172.16.10.0/24  หรือ  172.16.10.10-172.16.10.200  หรือ  172.16.10.10-200">
        <div class="hint" id="scPrev">CIDR /16 ถึง /32 หรือช่วง IP · สูงสุด 4,096 IP ต่อช่วง (ไม่รวม network / broadcast)</div></div>
      <div class="full"><label>หมายเหตุ</label><input class="inp" name="note" value="${esc(v.note || '')}" placeholder="เช่น อาคารผู้ป่วยนอก, Wi-Fi เจ้าหน้าที่"></div>
      <label class="check full"><input type="checkbox" name="enabled" ${v.enabled ? 'checked' : ''}> รวมในการสแกนทุกช่วง / สแกนอัตโนมัติ</label>
    </div></div><div class="mf"><button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('check', 16)} บันทึก</button></div></form>`);
  const f = m.querySelector('#scForm'), pv = m.querySelector('#scPrev');
  let t; f.spec.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
    if (!f.spec.value.trim()) return;
    const x = await api('POST', '/api/ipscan/preview', { spec: f.spec.value });
    pv.innerHTML = x.ok ? `<span style="color:var(--ok)">✓ ${esc(x.first)} – ${esc(x.last)} รวม ${fNum(x.count)} IP</span>` : `<span style="color:var(--bad)">${esc(x.error)}</span>`;
  }, 300); });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { name: f.name.value, vlan: f.vlan.value, spec: f.spec.value, note: f.note.value, enabled: f.enabled.checked };
    try { if (r) await api('PUT', `/api/ipscan/ranges/${r.id}`, body); else await api('POST', '/api/ipscan/ranges', body); closeModal(); toast('บันทึกช่วง IP แล้ว', 'ok'); loadScan(); }
    catch (ex) { const er = $('#scErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}
function scanSetModal() {
  const s = SC.data.settings;
  const m = modal(`<div class="mh">${icon('sliders', 20)}<h2>ตั้งค่าการสแกน IP</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="ssForm"><div class="mb"><div id="ssErr" class="err hidden"></div><div class="form">
      <div><label>จำนวน IP ที่สแกนพร้อมกัน</label><input class="inp" type="number" min="1" max="256" name="concurrency" value="${s.concurrency}"><div class="hint">ค่าเริ่มต้น 64 · ลดลงถ้า Firewall/IPS มองว่าเป็นการโจมตี</div></div>
      <div><label>รอคำตอบต่อ IP (ms)</label><input class="inp" type="number" min="200" max="5000" name="timeoutMs" value="${s.timeoutMs}"></div>
      <div class="full"><label>TCP port ที่ใช้ตรวจเมื่อ ping ไม่ตอบ (สูงสุด 12)</label><input class="inp mono" name="ports" value="${esc(s.ports.join(', '))}">
        <div class="hint">Windows Firewall มักปิด ping — ระบบจะลองเชื่อมต่อพอร์ตเหล่านี้แทน (445 SMB, 3389 RDP, 135 RPC, 139, 22 SSH, 80/443 เว็บ, 9100 เครื่องพิมพ์, 554 กล้อง)</div></div>
      <label class="check full"><input type="checkbox" name="resolveNames" ${s.resolveNames ? 'checked' : ''}> หาชื่อเครื่องจาก DNS (Reverse lookup)</label>
      <label class="check full"><input type="checkbox" name="schEnabled" ${s.schedule.enabled ? 'checked' : ''}> สแกนอัตโนมัติ</label>
      <div><label>ทุก</label><select class="inp" name="everyHours">${[1, 2, 3, 4, 6, 8, 12, 24].map((h) => `<option value="${h}" ${s.schedule.everyHours === h ? 'selected' : ''}>${h === 24 ? 'วันละครั้ง' : `${h} ชั่วโมง`}</option>`).join('')}</select></div>
      <div><label>เวลา (เมื่อสแกนวันละครั้ง)</label><input class="inp mono" name="at" value="${esc(s.schedule.at)}" placeholder="01:00"></div>
    </div></div><div class="mf"><button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('check', 16)} บันทึก</button></div></form>`);
  m.querySelector('#ssForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('PUT', '/api/ipscan/settings', { concurrency: f.concurrency.value, timeoutMs: f.timeoutMs.value, ports: f.ports.value, resolveNames: f.resolveNames.checked,
        schedule: { enabled: f.schEnabled.checked, everyHours: Number(f.everyHours.value), at: f.at.value } });
      closeModal(); toast('บันทึกการตั้งค่าแล้ว', 'ok'); loadScan();
    } catch (ex) { const er = $('#ssErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (!a.startsWith('sc')) return;
  try {
    if (a === 'scrun' || a === 'scrun1') { SC.data.job = await api('POST', '/api/ipscan/run', a === 'scrun1' ? { rangeIds: [el.dataset.id] } : {}); renderJob(); startPoll(); }
    else if (a === 'sccancel') { await api('POST', '/api/ipscan/cancel'); }
    else if (a === 'scadd') rangeModal(null);
    else if (a === 'scedit') rangeModal(SC.data.ranges.find((r) => r.id === el.dataset.id));
    else if (a === 'scdel') { if (await confirmBox('ลบช่วง IP', `ลบ <b>${esc(el.dataset.name)}</b> และผลการสแกนของช่วงนี้?`, 'ลบ')) { await api('DELETE', `/api/ipscan/ranges/${el.dataset.id}`); loadScan(); } }
    else if (a === 'scset') scanSetModal();
    else if (a === 'scview') scView(el.dataset.id);
    else if (a === 'screg') {
      closeModal();
      IV.presetIp = el.dataset.ip; IV.presetMac = el.dataset.mac;
      if (!IV.data) { try { IV.data = await api('GET', '/api/inventory'); } catch { /* ignore */ } }
      invEditModal(null);
      const f = $('#ivForm'); if (f && el.dataset.name) f.hostname.value = el.dataset.name.split('.')[0].toUpperCase();
    }
    else if (a === 'scdev') {
      closeModal(); deviceModal(null);
      const f = $('#devForm'); if (f) { f.ip.value = el.dataset.ip; if (el.dataset.name) f.name.value = el.dataset.name.split('.')[0]; }
    }
  } catch (ex) { toast(ex.message, 'bad'); }
});
