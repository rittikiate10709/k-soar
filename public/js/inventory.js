'use strict';
/* ============================================================
   ทะเบียนเครื่องคอมพิวเตอร์ — รายการเครื่อง, รายละเอียดสเปค, รายงานการเปลี่ยนแปลง,
   ค้นหาซอฟต์แวร์, ติดตั้ง Agent   (ใช้ฟังก์ชันร่วมจาก common.js / app.js / reports.js / admin.js)
   ============================================================ */
const IV = Object.assign({ sub: 'list', q: '', state: '', dept: '', sort: 'hostname', rep: { mode: 'month', date: '', from: '', to: '', cats: [], dept: '', q: '' } }, store.get('nms_inv', {}));
IV.data = null; IV.report = null;
const IV_CAT = {
  new: ['ลงทะเบียนใหม่', '#0e9b87'], os: ['ระบบปฏิบัติการ', '#24a0e6'], hardware: ['ฮาร์ดแวร์', '#f0425f'], network: ['เครือข่าย', '#8b5cf6'],
  software: ['ซอฟต์แวร์', '#f59e0b'], firmware: ['BIOS / Firmware', '#64748b'], info: ['ข้อมูลทะเบียน', '#14b8a6'], removed: ['ลบออก', '#94a3b8'],
};
const IV_ST = { online: ['ออนไลน์', 'ok'], idle: ['ไม่ได้รายงานสักพัก', 'warn'], stale: ['ขาดการรายงาน', 'bad'], manual: ['ลงทะเบียนเอง', 'info'],
  spare: ['สำรอง', 'muted'], repair: ['ส่งซ่อม', 'maint'], retired: ['จำหน่าย/เลิกใช้', 'muted'] };
const ivSave = () => { const { data, report, ...k } = IV; store.set('nms_inv', k); };
const gbTxt = (mb) => (mb == null ? '—' : mb >= 1024 ? `${Math.round((mb / 1024) * 10) / 10} GB` : `${mb} MB`);
const ivStPill = (s) => { const x = IV_ST[s] || [s, 'muted']; return `<span class="pill ${x[1]}">${x[0]}</span>`; };
const osShortTxt = (os) => (os && os.name ? `${os.name.replace(/^Microsoft /, '')}${os.release ? ` ${os.release}` : ''}` : '—');
const diskShort = (a) => (a.disks || []).map((d) => `${d.sizeGB >= 1000 ? `${Math.round(d.sizeGB / 100) / 10} TB` : `${d.sizeGB ?? '?'} GB`}${d.type ? ` ${d.type}` : ''}`).join(' + ') || '—';
const cpuShort = (m) => String(m || '—').replace(/\(R\)|\(TM\)|CPU|Processor|\d+(st|nd|rd|th) Gen/gi, '').replace(/@.*$/, '').replace(/\s+/g, ' ').trim();

function vInventory() {
  const subs = [['list', 'รายการเครื่อง'], ['report', 'รายงานการเปลี่ยนแปลง'], ['software', 'ค้นหาซอฟต์แวร์'], ['agent', 'ติดตั้ง Agent']];
  $('#view').innerHTML = `<div class="card panel rbar">
      <div class="seg">${subs.map(([k, l]) => `<button data-act="ivsub" data-s="${k}" class="${IV.sub === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <span class="grow" style="flex:1"></span><span class="faint" id="ivInfo"></span></div>
    <div id="ivBody"><div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}</div></div></div>`;
  if (IV.sub === 'list') loadInv();
  else if (IV.sub === 'report') vInvReport();
  else if (IV.sub === 'software') vInvSoftware();
  else vInvAgent();
}

/* ------------------------------------------------------------------ list */
async function loadInv() {
  try { IV.data = await api('GET', '/api/inventory'); renderInvList(); }
  catch (e) { $('#ivBody').innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
}
function hbars(list, total) {
  if (!list.length) return '<div class="empty" style="padding:14px">ยังไม่มีข้อมูล</div>';
  const max = Math.max(...list.map((x) => x.n));
  return `<div class="iv-hb">${list.slice(0, 7).map((x) => `<div><span title="${esc(x.k)}">${esc(x.k)}</span><i><b style="width:${(x.n / max) * 100}%"></b></i><em>${x.n}${total ? ` · ${Math.round((x.n / total) * 100)}%` : ''}</em></div>`).join('')}</div>`;
}
function renderInvList() {
  const D = IV.data, st = D.stats;
  $('#ivInfo').textContent = `ทั้งหมด ${st.total} เครื่อง · Agent ส่งรายงานทุก ${D.settings.intervalMin} นาที`;
  $('#ivBody').innerHTML = `
    <div class="grid g4 iv-kpis">
      <div class="card kpi"><div class="h">เครื่องที่ใช้งาน ${icon('monitor', 18)}</div><div class="v">${st.inUse}<small>เครื่อง</small></div><div class="row"><span>มี Agent / ลงทะเบียนเอง</span><span class="mono">${st.agent} / ${st.manual}</span></div></div>
      <div class="card kpi"><div class="h">Agent ออนไลน์ ${icon('activity', 18)}</div><div class="v" style="color:var(--ok)">${st.online}</div><div class="row"><span>ไม่ได้รายงานสักพัก</span><span class="mono">${st.idle}</span></div></div>
      <div class="card kpi"><div class="h">ขาดการรายงาน ${icon('alert', 18)}</div><div class="v" style="color:${st.stale ? 'var(--bad)' : ''}">${st.stale}</div><div class="row"><span>เกิน ${D.settings.staleDays} วัน</span><span class="mono">ดิสก์ใกล้เต็ม ${st.lowDisk}</span></div></div>
      <div class="card kpi"><div class="h">การเปลี่ยนแปลง ${icon('rotate', 18)}</div><div class="v">${fNum(st.changes24h)}<small>24 ชม.</small></div><div class="row"><span>7 วันล่าสุด</span><span class="mono">${fNum(st.changes7d)}</span></div></div>
    </div>
    <div class="grid g4 iv-dist">
      <div class="card panel"><div class="ph"><h3>${icon('monitor', 16)}<span class="th">ระบบปฏิบัติการ</span></h3></div>${hbars(st.os, st.inUse)}</div>
      <div class="card panel"><div class="ph"><h3>${icon('cpu', 16)}<span class="th">CPU</span></h3></div>${hbars(st.cpu, st.inUse)}</div>
      <div class="card panel"><div class="ph"><h3>${icon('database', 16)}<span class="th">RAM</span></h3></div>${hbars(st.ram, st.inUse)}</div>
      <div class="card panel"><div class="ph"><h3>${icon('server', 16)}<span class="th">ชนิดดิสก์</span></h3></div>${hbars(st.diskType)}</div>
    </div>
    <div class="card panel">
      <div class="ph"><h3>${icon('list', 17)}<span class="th">ทะเบียนเครื่องคอมพิวเตอร์</span><span class="bar"></span><span id="ivCount"></span></h3>
        <span class="right" style="text-transform:none;display:flex;gap:6px">${can('operator') ? `<button class="btn sm primary" data-act="ivadd">${icon('plus', 14)} ลงทะเบียนเอง</button>` : ''}
          <a class="btn sm" href="/api/inventory/export.csv">${icon('download', 14)} CSV</a></span></div>
      <div class="iv-filter">
        <input class="inp" id="ivQ" placeholder="ค้นหา ชื่อเครื่อง / IP / MAC / เลขครุภัณฑ์ / ผู้ใช้ / CPU / Serial" value="${esc(IV.q)}">
        <select class="sel" id="ivState"><option value="">ทุกสถานะ</option>${Object.entries(IV_ST).map(([k, v]) => `<option value="${k}" ${IV.state === k ? 'selected' : ''}>${v[0]}</option>`).join('')}</select>
        <select class="sel" id="ivDept"><option value="">ทุกหน่วยงาน</option>${D.departments.map((d) => `<option ${IV.dept === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
        <select class="sel" id="ivSort">${[['hostname', 'เรียงตามชื่อ'], ['lastSeen', 'รายงานล่าสุด'], ['ramMB', 'RAM น้อย→มาก'], ['dept', 'หน่วยงาน']].map(([k, l]) => `<option value="${k}" ${IV.sort === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </div>
      <div id="ivTable"></div>
    </div>`;
  let t;
  $('#ivQ').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { IV.q = e.target.value; ivSave(); renderInvTable(); }, 150); });
  $('#ivState').addEventListener('change', (e) => { IV.state = e.target.value; ivSave(); renderInvTable(); });
  $('#ivDept').addEventListener('change', (e) => { IV.dept = e.target.value; ivSave(); renderInvTable(); });
  $('#ivSort').addEventListener('change', (e) => { IV.sort = e.target.value; ivSave(); renderInvTable(); });
  renderInvTable();
}
function renderInvTable() {
  const q = IV.q.trim().toLowerCase();
  let L = IV.data.assets.filter((a) => (!IV.state || a.state === IV.state) && (!IV.dept || a.department === IV.dept)
    && (!q || [a.hostname, a.ip, a.mac, a.assetTag, a.department, a.location, a.owner, a.user, a.os && a.os.name, a.cpu && a.cpu.model, a.system && a.system.serial, a.system && a.system.model].some((v) => String(v || '').toLowerCase().includes(q))));
  const s = IV.sort;
  L.sort((a, b) => (s === 'lastSeen' ? (b.lastSeen || 0) - (a.lastSeen || 0) : s === 'ramMB' ? (a.ramMB || 0) - (b.ramMB || 0) : s === 'dept' ? String(a.department || 'ฮ').localeCompare(String(b.department || 'ฮ'), 'th') : a.hostname.localeCompare(b.hostname, 'th')));
  $('#ivCount').textContent = `${L.length} เครื่อง`;
  if (!L.length) { $('#ivTable').innerHTML = `<div class="empty">${IV.data.assets.length ? 'ไม่พบเครื่องตามเงื่อนไข' : 'ยังไม่มีเครื่องในทะเบียน — ติดตั้ง Agent ที่เมนู “ติดตั้ง Agent” หรือกด “ลงทะเบียนเอง”'}</div>`; return; }
  $('#ivTable').innerHTML = `<div class="tblwrap"><table class="tbl iv-tbl"><thead><tr><th>เครื่อง</th><th>IP / MAC</th><th>หน่วยงาน</th><th>ระบบปฏิบัติการ</th><th>CPU</th><th>RAM</th><th>ดิสก์</th><th>การ์ดจอ</th><th>สถานะ</th><th>รายงานล่าสุด</th></tr></thead><tbody>
    ${L.map((a) => `<tr class="click" data-act="ivopen" data-id="${a.id}">
      <td><b>${esc(a.hostname)}</b>${a.assetTag ? `<div class="mono faint" style="font-size:11px">${esc(a.assetTag)}</div>` : ''}${a.user ? `<div class="faint" style="font-size:11px">${icon('user', 11)} ${esc(a.user)}</div>` : ''}</td>
      <td class="mono" style="font-size:12px">${esc(maskIp(a.ip || '—'))}<div class="faint">${esc(a.mac || '')}</div></td>
      <td>${esc(a.department || '—')}${a.location ? `<div class="faint" style="font-size:11px">${esc(a.location)}</div>` : ''}</td>
      <td style="font-size:12.5px">${esc(osShortTxt(a.os))}<div class="faint mono" style="font-size:11px">${esc((a.os && a.os.build) || '')}</div></td>
      <td style="font-size:12.5px">${esc(cpuShort(a.cpu && a.cpu.model))}${a.cpu && a.cpu.cores ? `<div class="faint" style="font-size:11px">${a.cpu.cores}C/${a.cpu.threads || a.cpu.cores}T</div>` : ''}</td>
      <td class="mono">${gbTxt(a.ramMB)}</td>
      <td style="font-size:12px">${esc(diskShort(a))}${a.lowDisk && a.lowDisk.length ? `<div><span class="pill bad" title="พื้นที่ว่างน้อยกว่า ${IV.data.settings.lowDiskPct}%">${esc(a.lowDisk.join(' '))} ใกล้เต็ม</span></div>` : ''}</td>
      <td style="font-size:12px">${esc((a.gpus || []).map((g) => g.name.replace(/\(R\)|\(TM\)/g, '')).join(', ') || '—')}</td>
      <td>${ivStPill(a.state)}</td>
      <td style="font-size:12px">${a.lastSeen ? `${fmtDT(a.lastSeen)}<div class="faint">${ago(a.lastSeen)}</div>` : '<span class="faint">—</span>'}</td></tr>`).join('')}
    </tbody></table></div>`;
}

/* ---------------------------------------------------------------- detail */
async function invDetail(id) {
  let r; try { r = await api('GET', `/api/inventory/assets/${id}`); } catch (e) { toast(e.message, 'bad'); return; }
  const a = r.asset, sys = a.system || {}, os = a.os || {}, cpu = a.cpu || {};
  const dev = a.deviceId ? devById(a.deviceId) : null;
  const sec = (t, ic, body) => `<div class="iv-sec"><div class="sub-h">${icon(ic, 14)} ${t}</div>${body}</div>`;
  const kv = (rows) => `<div class="kv">${rows.filter((x) => x[1] !== undefined).map(([k, v]) => `<div><span>${k}</span><span title="${esc(v)}">${v === '' || v == null ? '—' : esc(v)}</span></div>`).join('')}</div>`;
  const vol = (v) => { const used = v.sizeGB ? 100 - (v.freeGB / v.sizeGB) * 100 : 0; return `<div class="iv-vol"><b>${esc(v.mount)}</b><span class="faint">${esc(v.fs || '')}</span><i><em style="width:${used}%;background:${used > 100 - IV.data?.settings.lowDiskPct || used > 90 ? 'var(--bad)' : used > 75 ? 'var(--warn)' : 'var(--brand)'}"></em></i><span class="mono">${v.freeGB} / ${v.sizeGB} GB ว่าง</span></div>`; };
  const m = modal(`<div class="mh">${icon('monitor', 20)}<h2>${esc(a.hostname)} ${ivStPill(a.state)}</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <div class="mb">
      <div class="iv-grid">
        ${sec('ข้อมูลทะเบียน', 'list', kv([['เลขครุภัณฑ์', a.assetTag], ['หน่วยงาน', a.department], ['สถานที่', a.location], ['ผู้รับผิดชอบ', a.owner], ['วันที่ซื้อ / หมดประกัน', `${a.purchaseDate || '—'} / ${a.warrantyEnd || '—'}`],
          ['อุปกรณ์เครือข่ายที่ผูก', dev ? `${dev.name} (${dev.ip})` : ''], ['ที่มา', a.source === 'agent' ? `Agent ${a.platform || ''} v${a.agentVersion || ''}` : 'ลงทะเบียนเอง'], ['ลงทะเบียนเมื่อ', fmtDT(a.firstSeen)],
          ['รายงานล่าสุด', a.lastSeen ? `${fmtDT(a.lastSeen)} (${a.reports || 0} ครั้ง)` : ''], ['หมายเหตุ', a.note]]))}
        ${sec('เครื่อง', 'server', kv([['ยี่ห้อ / รุ่น', `${sys.manufacturer || ''} ${sys.model || ''}`.trim()], ['Serial number', sys.serial], ['UUID', sys.uuid], ['BIOS', `${sys.bios || ''}${sys.biosDate ? ` (${String(sys.biosDate).slice(0, 10)})` : ''}`.trim()],
          ['ชนิดเครื่อง', sys.chassis], ['Domain', a.domain], ['ผู้ใช้ล่าสุด', a.user], ['Antivirus', (a.antivirus || []).map((v) => `${v.name}${v.enabled === false ? ' (ปิด)' : ''}${v.updated === false ? ' (ไม่อัปเดต)' : ''}`).join(', ')]]))}
        ${sec('ระบบปฏิบัติการ', 'monitor', kv([['ชื่อ', os.name], ['เวอร์ชัน / Release', `${os.version || ''} ${os.release || ''}`.trim()], ['Build', os.build], ['สถาปัตยกรรม', os.arch], ['ติดตั้งเมื่อ', os.installDate ? String(os.installDate).slice(0, 10) : ''], ['เปิดเครื่องล่าสุด', os.lastBoot ? String(os.lastBoot).replace('T', ' ').slice(0, 16) : '']]))}
        ${sec('CPU / RAM', 'cpu', kv([['CPU', cpu.model], ['คอร์ / เธรด', cpu.cores ? `${cpu.cores} / ${cpu.threads || cpu.cores}${cpu.sockets > 1 ? ` (${cpu.sockets} sockets)` : ''}` : ''], ['ความเร็ว', cpu.mhz ? `${(cpu.mhz / 1000).toFixed(2)} GHz` : ''], ['RAM รวม', gbTxt(a.ramMB)],
          ...(a.ramModules || []).map((x, i) => [`สล็อต ${esc(x.slot || i + 1)}`, `${gbTxt(x.sizeMB)} ${x.type || ''} ${x.speed ? `${x.speed} MHz` : ''} ${x.manufacturer || ''}`.replace(/\s+/g, ' ').trim()])]))}
      </div>
      ${sec('ฮาร์ดดิสก์', 'database', (a.disks || []).length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>รุ่น</th><th>ขนาด</th><th>ชนิด</th><th>Bus</th><th>Serial</th><th>สุขภาพ</th></tr></thead><tbody>${a.disks.map((d) => `<tr><td>${esc(d.model)}</td><td class="mono">${d.sizeGB ?? '—'} GB</td><td>${esc(d.type || '—')}</td><td>${esc(d.bus || '')}</td><td class="mono" style="font-size:11.5px">${esc(d.serial || '')}</td><td>${d.health ? `<span class="pill ${/health|ok/i.test(d.health) ? 'ok' : 'warn'}">${esc(d.health)}</span>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<div class="faint">—</div>')}
      ${(a.volumes || []).length ? sec('พื้นที่ไดรฟ์', 'pie', a.volumes.map(vol).join('')) : ''}
      <div class="iv-grid">
        ${sec('การ์ดจอ / จอภาพ', 'monitor', kv([...(a.gpus || []).map((g, i) => [`GPU ${i + 1}`, `${g.name}${g.vramMB ? ` · ${gbTxt(g.vramMB)}` : ''}${g.driver ? ` · driver ${g.driver}` : ''}`]), ...(a.monitors || []).map((x, i) => [`จอ ${i + 1}`, `${x.name}${x.serial ? ` (${x.serial})` : ''}`])]))}
        ${sec('เครือข่าย', 'network', kv((a.net || []).length ? a.net.map((n) => [n.name || 'NIC', `${(n.ipv4 || []).join(', ') || '—'} · ${n.mac || ''}${n.dhcp ? ' · DHCP' : n.dhcp === false ? ' · Static' : ''}`]) : [['IP', (a.ips || []).join(', ')], ['MAC', (a.macs || []).join(', ')]]))}
      </div>
      ${Array.isArray(a.software) ? sec(`ซอฟต์แวร์ที่ติดตั้ง (${a.software.length})`, 'grid', `<input class="inp" id="ivSwQ" placeholder="กรองชื่อโปรแกรม" style="margin-bottom:6px"><div class="iv-sw" id="ivSw"></div>`) : ''}
      ${sec(`ประวัติการเปลี่ยนแปลง (${r.changes.length})`, 'rotate', r.changes.length ? `<div class="iv-tl">${r.changes.map((c) => chRow(c)).join('')}</div>` : '<div class="faint">ยังไม่มีการเปลี่ยนแปลง</div>')}
    </div>
    <div class="mf">${can('admin') ? `<button class="btn danger" data-act="ivdel" data-id="${a.id}" data-name="${esc(a.hostname)}" style="margin-right:auto">${icon('trash', 15)} ลบ</button>` : ''}
      ${can('operator') ? `<button class="btn" data-act="ivedit" data-id="${a.id}">${icon('edit', 15)} แก้ไขทะเบียน</button>` : ''}<button class="btn primary" data-act="mclose">ปิด</button></div>`, 'wide');
  m.querySelector('.modal').style.maxWidth = '1100px';
  IV.cur = a;
  const sw = m.querySelector('#ivSw');
  if (sw) {
    const draw = (q) => { const L = a.software.filter((x) => !q || `${x.name} ${x.publisher}`.toLowerCase().includes(q)).sort((x, y) => x.name.localeCompare(y.name)); sw.innerHTML = L.slice(0, 500).map((x) => `<div><span>${esc(x.name)}</span><span class="mono faint">${esc(x.version)}</span></div>`).join('') + (L.length > 500 ? `<div class="faint">… อีก ${L.length - 500} รายการ</div>` : ''); };
    draw(''); m.querySelector('#ivSwQ').addEventListener('input', (e) => draw(e.target.value.toLowerCase().trim()));
  }
}
function chRow(c, withHost) {
  const k = IV_CAT[c.cat] || [c.cat, '#94a3b8'];
  return `<div class="iv-ch"><i style="background:${k[1]}"></i><div><div><b>${esc(c.label)}</b>${withHost ? ` · <a href="#" data-act="ivopen" data-id="${c.assetId}">${esc(c.host)}</a>` : ''} <span class="faint">${fmtDT(c.at)} · ${esc(c.by || '')}</span></div>
    <div class="iv-chv">${c.old ? `<span class="o">${esc(c.old)}</span>` : ''}${c.old && c.new ? ' → ' : ''}${c.new ? `<span class="n">${esc(c.new)}</span>` : ''}</div></div></div>`;
}
function invEditModal(a) {
  const isNew = !a, v = a || { status: 'active' }, man = isNew || v.source === 'manual';
  const os = v.os || {}, cpu = v.cpu || {}, sys = v.system || {};
  const depts = IV.data ? IV.data.departments : [];
  const D = [...devs()].sort((x, y) => x.name.localeCompare(y.name, 'th'));
  const m = modal(`<div class="mh">${icon(isNew ? 'plus' : 'edit', 20)}<h2>${isNew ? 'ลงทะเบียนเครื่องคอมพิวเตอร์ (กรอกเอง)' : `แก้ไขทะเบียน ${esc(v.hostname)}`}</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="ivForm"><div class="mb"><div id="ivErr" class="err hidden"></div>
      ${man && isNew ? '<div class="ok-msg" style="background:var(--info-soft);border-color:#b8e3f8;color:#0b6b9c">สำหรับเครื่องที่ยังติดตั้ง Agent ไม่ได้ — เมื่อติดตั้ง Agent ภายหลัง ระบบจะจับคู่ด้วยชื่อเครื่อง/MAC/IP และใช้ข้อมูลจาก Agent แทนอัตโนมัติ</div>' : ''}
      <div class="sub-h">ข้อมูลทะเบียน</div>
      <div class="form">
        <div><label>เลขครุภัณฑ์</label><input class="inp mono" name="assetTag" value="${esc(v.assetTag || '')}" placeholder="เช่น 7440-001-0001/66"></div>
        <div><label>สถานะ</label><select class="inp" name="status">${[['active', 'ใช้งาน'], ['spare', 'สำรอง'], ['repair', 'ส่งซ่อม'], ['retired', 'จำหน่าย/เลิกใช้']].map(([k, l]) => `<option value="${k}" ${v.status === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div><label>หน่วยงาน</label><input class="inp" name="department" list="ivDepts" value="${esc(v.department || '')}" placeholder="เช่น OPD อายุรกรรม"><datalist id="ivDepts">${depts.map((d) => `<option>${esc(d)}</option>`).join('')}</datalist></div>
        <div><label>สถานที่</label><input class="inp" name="location" value="${esc(v.location || '')}" placeholder="อาคาร / ชั้น / ห้อง"></div>
        <div><label>ผู้รับผิดชอบ</label><input class="inp" name="owner" value="${esc(v.owner || '')}"></div>
        <div><label>ผูกกับอุปกรณ์เครือข่าย (ถ้ามี)</label><select class="inp" name="deviceId"><option value="">—</option>${D.map((d) => `<option value="${d.id}" ${v.deviceId === d.id ? 'selected' : ''}>${esc(d.name)} (${esc(d.ip)})</option>`).join('')}</select></div>
        <div><label>วันที่ซื้อ</label><input class="inp" type="date" name="purchaseDate" value="${esc(v.purchaseDate || '')}"></div>
        <div><label>หมดประกัน</label><input class="inp" type="date" name="warrantyEnd" value="${esc(v.warrantyEnd || '')}"></div>
        <div class="full"><label>หมายเหตุ</label><input class="inp" name="note" value="${esc(v.note || '')}"></div>
      </div>
      ${man ? `<div class="sub-h" style="margin-top:14px">สเปคเครื่อง</div><div class="form">
        <div><label>ชื่อเครื่อง <span class="req">*</span></label><input class="inp mono" name="hostname" required value="${esc(v.hostname || '')}"></div>
        <div><label>IP Address</label><input class="inp mono" name="ip" value="${esc((v.ips || [])[0] || IV.presetIp || '')}"></div>
        <div><label>MAC Address</label><input class="inp mono" name="mac" value="${esc((v.macs || [])[0] || IV.presetMac || '')}" placeholder="AA:BB:CC:DD:EE:FF"></div>
        <div><label>ระบบปฏิบัติการ</label><input class="inp" name="osName" list="ivOs" value="${esc(os.name || '')}"><datalist id="ivOs"><option>Microsoft Windows 11 Pro</option><option>Microsoft Windows 10 Pro</option><option>Microsoft Windows 7 Professional</option><option>Ubuntu 24.04 LTS</option></datalist></div>
        <div><label>เวอร์ชัน / Release</label><input class="inp" name="osRelease" value="${esc(os.release || '')}" placeholder="เช่น 23H2"></div>
        <div><label>CPU</label><input class="inp" name="cpuModel" value="${esc(cpu.model || '')}" placeholder="เช่น Intel Core i5-10400"></div>
        <div><label>จำนวนคอร์</label><input class="inp" type="number" min="1" name="cpuCores" value="${cpu.cores || ''}"></div>
        <div><label>RAM (GB)</label><input class="inp" type="number" min="0" step="0.5" name="ramGB" value="${v.ramMB ? Math.round((v.ramMB / 1024) * 10) / 10 : ''}"></div>
        <div><label>ฮาร์ดดิสก์ (คั่นด้วย +)</label><input class="inp" name="diskText" value="${esc((v.disks || []).map((d) => d.model).join(' + '))}" placeholder="SSD 512GB + HDD 1TB"></div>
        <div><label>การ์ดจอ</label><input class="inp" name="gpuName" value="${esc(((v.gpus || [])[0] || {}).name || '')}"></div>
        <div><label>ยี่ห้อ</label><input class="inp" name="manufacturer" value="${esc(sys.manufacturer || '')}"></div>
        <div><label>รุ่น</label><input class="inp" name="model" value="${esc(sys.model || '')}"></div>
        <div><label>Serial number</label><input class="inp mono" name="serial" value="${esc(sys.serial || '')}"></div>
      </div>` : '<div class="hint" style="margin-top:10px">สเปคเครื่องมาจาก Agent อัตโนมัติ (แก้ไขที่นี่ไม่ได้)</div>'}
    </div><div class="mf"><button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('check', 16)} บันทึก</button></div></form>`, 'wide');
  IV.presetIp = ''; IV.presetMac = '';
  m.querySelector('#ivForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target));
    try {
      if (isNew) await api('POST', '/api/inventory/assets', body); else await api('PUT', `/api/inventory/assets/${v.id}`, body);
      closeModal(); toast('บันทึกทะเบียนแล้ว', 'ok');
      if (S.tab === 'inventory' && IV.sub === 'list') loadInv(); else if (S.tab === 'ipscan') loadScan();
    } catch (ex) { const er = $('#ivErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}

/* ---------------------------------------------------------------- report */
function vInvReport() {
  const r = IV.rep, y0 = new Date().getFullYear();
  if (!r.date) r.date = r.mode === 'day' ? today() : r.mode === 'year' ? String(y0) : today().slice(0, 7);
  const years = []; for (let y = y0; y >= y0 - 6; y--) years.push(y);
  const depts = IV.data ? IV.data.departments : [];
  $('#ivBody').innerHTML = `<div class="card panel rbar">
      <div class="seg">${[['day', 'รายวัน'], ['month', 'รายเดือน'], ['year', 'รายปี'], ['range', 'กำหนดช่วงวันที่']].map(([k, l]) => `<button data-act="ivrmode" data-m="${k}" class="${r.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="rperiod">
        ${r.mode !== 'range' ? `<button class="ibtn" data-act="ivrshift" data-d="-1">${icon('chevl', 17)}</button>` : ''}
        ${r.mode === 'day' ? `<input type="date" class="inp" id="ivrD" value="${esc(r.date)}" max="${today()}">`
    : r.mode === 'month' ? `<input type="month" class="inp" id="ivrD" value="${esc(r.date)}" max="${today().slice(0, 7)}">`
      : r.mode === 'year' ? `<select class="sel" id="ivrD">${years.map((y) => `<option value="${y}" ${String(y) === r.date ? 'selected' : ''}>พ.ศ. ${y + 543}</option>`).join('')}</select>`
        : `<input type="date" class="inp" id="ivrF" value="${esc(r.from || today().slice(0, 8) + '01')}" max="${today()}"> ถึง <input type="date" class="inp" id="ivrT" value="${esc(r.to || today())}" max="${today()}">`}
        ${r.mode !== 'range' ? `<button class="ibtn" data-act="ivrshift" data-d="1">${icon('chevr', 17)}</button>` : ''}
      </div>
      <select class="sel" id="ivrDept"><option value="">ทุกหน่วยงาน</option>${depts.map((d) => `<option ${r.dept === d ? 'selected' : ''}>${esc(d)}</option>`).join('')}</select>
      <input class="inp" id="ivrQ" placeholder="ค้นหาชื่อเครื่อง / รายการ" value="${esc(r.q)}" style="width:200px">
      <span style="flex:1"></span>
      <button class="btn sm" data-act="ivrcsv">${icon('download', 15)} CSV</button>
    </div>
    <div class="iv-cats">${Object.entries(IV_CAT).map(([k, v]) => `<label class="iv-cat ${!r.cats.length || r.cats.includes(k) ? 'on' : ''}"><input type="checkbox" data-cat="${k}" ${!r.cats.length || r.cats.includes(k) ? 'checked' : ''}><i style="background:${v[1]}"></i>${v[0]}</label>`).join('')}</div>
    <div id="ivRep"><div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}</div></div></div>`;
  const go = () => { ivSave(); loadInvReport(); };
  const d = $('#ivrD'); if (d) d.addEventListener('change', () => { if (d.value) { r.date = d.value; go(); } });
  const f = $('#ivrF'), t = $('#ivrT');
  if (f) { r.from = f.value; r.to = t.value; [f, t].forEach((x) => x.addEventListener('change', () => { r.from = f.value; r.to = t.value; if (r.from && r.to) go(); })); }
  $('#ivrDept').addEventListener('change', (e) => { r.dept = e.target.value; go(); });
  let tq; $('#ivrQ').addEventListener('input', (e) => { clearTimeout(tq); tq = setTimeout(() => { r.q = e.target.value; go(); }, 300); });
  document.querySelectorAll('.iv-cat input').forEach((cb) => cb.addEventListener('change', () => {
    const on = [...document.querySelectorAll('.iv-cat input')].filter((x) => x.checked).map((x) => x.dataset.cat);
    r.cats = on.length === Object.keys(IV_CAT).length ? [] : on;
    document.querySelectorAll('.iv-cat').forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    go();
  }));
  if (!IV.data) api('GET', '/api/inventory').then((x) => { IV.data = x; }).catch(() => {});
  loadInvReport();
}
function repQuery() {
  const r = IV.rep, p = new URLSearchParams({ mode: r.mode });
  if (r.mode === 'range') { p.set('from', r.from); p.set('to', r.to); } else p.set('date', r.date);
  if (r.cats.length) p.set('cat', r.cats.join(',')); if (r.dept) p.set('dept', r.dept); if (r.q) p.set('q', r.q);
  return p.toString();
}
async function loadInvReport() {
  const host = $('#ivRep');
  if (IV.rep.mode === 'range' && (!IV.rep.from || !IV.rep.to)) { host.innerHTML = '<div class="card panel"><div class="empty">เลือกวันที่เริ่มต้นและสิ้นสุด</div></div>'; return; }
  try { IV.report = await api('GET', `/api/inventory/changes?${repQuery()}`); renderInvReport(); }
  catch (e) { host.innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
}
function renderInvReport() {
  const R2 = IV.report;
  const pct = (a, b) => (!b ? (a ? '<span class="faint">ช่วงก่อนไม่มีข้อมูล</span>' : '') : `<span style="color:${a > b ? 'var(--warn)' : 'var(--ok)'}">${a >= b ? '▲' : '▼'} ${Math.abs(Math.round(((a - b) / b) * 100))}%</span> จากช่วงก่อน (${fNum(b)})`);
  const range = `${new Date(R2.start).toLocaleDateString('th-TH', { dateStyle: 'medium' })} – ${new Date(R2.end - 1).toLocaleDateString('th-TH', { dateStyle: 'medium' })}`;
  const cats = Object.keys(IV_CAT).filter((k) => R2.buckets.some((b) => b.counts[k]));
  $('#ivRep').innerHTML = `
    <div class="grid g4 iv-kpis">
      <div class="card kpi"><div class="h">การเปลี่ยนแปลงทั้งหมด ${icon('rotate', 18)}</div><div class="v">${fNum(R2.total)}</div><div class="row" style="display:block;font-size:12px">${pct(R2.total, R2.prevTotal)}</div></div>
      <div class="card kpi"><div class="h">เครื่องที่มีการเปลี่ยนแปลง ${icon('monitor', 18)}</div><div class="v">${fNum(R2.assetsChanged)}<small>เครื่อง</small></div><div class="row"><span>ช่วงเวลา</span><span>${range}</span></div></div>
      <div class="card kpi"><div class="h">ลงทะเบียนใหม่ ${icon('plus', 18)}</div><div class="v" style="color:#0e9b87">${fNum(R2.newAssets)}</div><div class="row"><span>ช่วงก่อน</span><span class="mono">${fNum(R2.prevCat.new || 0)}</span></div></div>
      <div class="card kpi"><div class="h">ฮาร์ดแวร์เปลี่ยน ${icon('cpu', 18)}</div><div class="v" style="color:${R2.hardware ? 'var(--bad)' : ''}">${fNum(R2.hardware)}</div><div class="row"><span>OS อัปเดต / ซอฟต์แวร์</span><span class="mono">${fNum(R2.byCat.os || 0)} / ${fNum(R2.byCat.software || 0)}</span></div></div>
    </div>
    <div class="card panel"><div class="ph"><h3>${icon('chart', 17)}<span class="th">จำนวนการเปลี่ยนแปลง${{ hour: 'รายชั่วโมง', day: 'รายวัน', month: 'รายเดือน' }[R2.unit]}</span><span class="bar"></span>${range}</h3></div>
      ${legend(cats.map((k) => [IV_CAT[k][1], `${IV_CAT[k][0]} (${fNum(R2.byCat[k])})`]))}
      <div id="ivChart" class="rchart-host"></div></div>
    <div class="grid g2">
      <div class="card panel"><div class="ph"><h3>${icon('monitor', 17)}<span class="th">เครื่องที่เปลี่ยนแปลงมากที่สุด</span></h3></div>
        ${R2.topAssets.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>เครื่อง</th><th>หน่วยงาน</th><th>หมวด</th><th style="text-align:right">ครั้ง</th></tr></thead><tbody>${R2.topAssets.map((h) => `<tr class="click" data-act="ivopen" data-id="${h.assetId}"><td><b>${esc(h.host)}</b></td><td>${esc(h.dept || '—')}</td>
          <td>${Object.entries(h.cats).map(([k, n]) => `<span class="iv-dot" style="background:${(IV_CAT[k] || [])[1]}" title="${(IV_CAT[k] || [k])[0]}"></span>${n}`).join(' ')}</td><td class="mono" style="text-align:right">${h.n}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">ไม่มีข้อมูล</div>'}</div>
      <div class="card panel"><div class="ph"><h3>${icon('list', 17)}<span class="th">ประเภทการเปลี่ยนแปลง</span></h3></div>${hbars(R2.topFields.map((x) => ({ k: x.label, n: x.n })), R2.total)}</div>
    </div>
    <div class="card panel"><div class="ph"><h3>${icon('rotate', 17)}<span class="th">รายการเปลี่ยนแปลง</span><span class="bar"></span>${fNum(R2.rows.length)}${R2.truncated ? ` จาก ${fNum(R2.total)} (ดาวน์โหลด CSV เพื่อดูทั้งหมด)` : ''}</h3></div>
      ${R2.rows.length ? `<div class="iv-tl" style="max-height:560px">${R2.rows.map((c) => chRow(c, true)).join('')}</div>` : '<div class="empty">ไม่มีการเปลี่ยนแปลงในช่วงนี้</div>'}</div>`;
  const host = $('#ivChart');
  drawChart(host, { labels: R2.buckets.map((b) => b.label), height: 240, stack: true, yFmt: (v) => Math.round(v),
    bars: cats.map((k) => ({ values: R2.buckets.map((b) => b.counts[k] || 0), color: IV_CAT[k][1] })),
    tooltip: (i) => { const b = R2.buckets[i]; return `<b>${esc(b.label)}</b><div>รวม <b>${b.total}</b> รายการ</div>${cats.filter((k) => b.counts[k]).map((k) => `<div><span class="iv-dot" style="background:${IV_CAT[k][1]}"></span>${IV_CAT[k][0]}: ${b.counts[k]}</div>`).join('')}`; } });
}
function shiftRep(d) {
  const r = IV.rep;
  if (r.mode === 'day') { const t = new Date(`${r.date}T00:00:00`); t.setDate(t.getDate() + d); r.date = `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; }
  else if (r.mode === 'month') { const [y, m] = r.date.split('-').map(Number); const t = new Date(y, m - 1 + d, 1); r.date = `${t.getFullYear()}-${p2(t.getMonth() + 1)}`; }
  else if (r.mode === 'year') r.date = String(Number(r.date) + d);
  ivSave(); vInvReport();
}

/* ---------------------------------------------------------------- software */
function vInvSoftware() {
  $('#ivBody').innerHTML = `<div class="card panel"><div class="ph"><h3>${icon('search', 17)}<span class="th">ค้นหาซอฟต์แวร์ในทุกเครื่อง</span><span class="bar"></span>จากรายงานของ Agent</h3></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><input class="inp" id="swQ" placeholder="เช่น HOSxP, Chrome, Office, AnyDesk, TeamViewer" style="max-width:420px"><button class="btn primary" id="swGo">${icon('search', 15)} ค้นหา</button></div>
    <div class="hint" style="margin:6px 0 12px">ใช้ตรวจว่าเครื่องไหนติดตั้งโปรแกรมใด เวอร์ชันอะไร เช่น หาเครื่องที่ยังใช้ HOSxP เวอร์ชันเก่า หรือมีโปรแกรมควบคุมระยะไกลที่ไม่ได้รับอนุญาต</div>
    <div id="swOut"></div></div>`;
  const go = async () => {
    const q = $('#swQ').value.trim(), out = $('#swOut');
    try {
      const r = await api('GET', `/api/inventory/software?q=${encodeURIComponent(q)}`);
      const vers = {}; r.rows.forEach((x) => { const k = `${x.name} ${x.version}`; vers[k] = (vers[k] || 0) + 1; });
      out.innerHTML = r.rows.length ? `<div class="sub-h">พบ ${fNum(r.total)} รายการ ใน ${new Set(r.rows.map((x) => x.assetId)).size} เครื่อง</div>
        ${hbars(Object.entries(vers).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ k, n })))}
        <div class="tblwrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>เครื่อง</th><th>หน่วยงาน</th><th>โปรแกรม</th><th>เวอร์ชัน</th><th>ผู้ผลิต</th></tr></thead><tbody>
        ${r.rows.map((x) => `<tr class="click" data-act="ivopen" data-id="${x.assetId}"><td><b>${esc(x.hostname)}</b></td><td>${esc(x.department || '—')}</td><td>${esc(x.name)}</td><td class="mono">${esc(x.version)}</td><td class="faint">${esc(x.publisher || '')}</td></tr>`).join('')}</tbody></table></div>`
        : '<div class="empty">ไม่พบโปรแกรมนี้</div>';
    } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $('#swGo').addEventListener('click', go);
  $('#swQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('#swQ').focus();
}

/* ---------------------------------------------------------------- agent */
function agentCmds(token) {
  const o = location.origin, k = token || 'stk_xxxxxxxx';
  return {
    win: `powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr -UseBasicParsing ${o}/agent/windows/install-agent.ps1 -OutFile $env:TEMP\\st-install.ps1; & $env:TEMP\\st-install.ps1 -Server ${o} -Key ${k}"`,
    linux: `curl -fsSL ${o}/agent/linux/install-agent.sh -o /tmp/st-install.sh && sudo sh /tmp/st-install.sh --server ${o} --key ${k}`,
  };
}
function vInvAgent() {
  const c = agentCmds();
  const S2 = IV.data ? IV.data.settings : null;
  $('#ivBody').innerHTML = `<div class="grid g2">
    <div class="card panel"><div class="ph"><h3>${icon('download', 17)}<span class="th">ติดตั้ง Agent บนเครื่องลูกข่าย</span></h3></div>
      <ol class="wz-steps">
        <li><b>สร้าง API Key ประเภท Agent</b> (ใช้ Key เดียวกันได้ทุกเครื่อง — Key นี้ส่งข้อมูลสเปคได้อย่างเดียว อ่านข้อมูลอื่นไม่ได้)<br>
          ${can('admin') ? `<button class="btn sm primary" data-act="ivkey" style="margin-top:6px">${icon('key', 14)} สร้าง Agent Key + คำสั่งติดตั้ง</button>` : '<span class="faint">ต้องเป็นผู้ดูแลระบบ</span>'}</li>
        <li><b>Windows 7 SP1 / 8.1 / 10 / 11 / Server</b> (PowerShell 3.0 ขึ้นไป) — เปิด <b>PowerShell แบบ Run as administrator</b> แล้ววางคำสั่ง
          <div class="code-block" style="user-select:all;color:var(--text)">${esc(c.win)}</div>
          หรือดาวน์โหลดไฟล์ไปติดตั้งเอง / ผ่าน GPO: <a href="/agent/windows/install-agent.cmd" download>install-agent.cmd</a> · <a href="/agent/windows/install-agent.ps1" download>install-agent.ps1</a> · <a href="/agent/windows/smart-topology-agent.ps1" download>smart-topology-agent.ps1</a></li>
        <li><b>Linux</b> (Ubuntu / Debian / AlmaLinux / Rocky — Python 3.6+, systemd)
          <div class="code-block" style="user-select:all;color:var(--text)">${esc(c.linux)}</div>
          ไฟล์: <a href="/agent/linux/install-agent.sh" download>install-agent.sh</a> · <a href="/agent/linux/smart-topology-agent.py" download>smart-topology-agent.py</a></li>
        <li><b>ตรวจผล</b> — เครื่องจะขึ้นในแท็บ “รายการเครื่อง” ภายในไม่กี่วินาที · Log อยู่ที่ <span class="mono">C:\\ProgramData\\SmartTopology\\agent.log</span> หรือ <span class="mono">/var/log/smart-topology-agent.log</span></li>
      </ol>
      <div class="hint" style="margin-top:10px">Agent รันเป็น SYSTEM/root ผ่าน Task Scheduler/systemd timer ทุก N นาที และหลังเปิดเครื่อง 2 นาที · ทดสอบโดยไม่ส่งข้อมูล: <span class="mono">smart-topology-agent.ps1 -Print</span> / <span class="mono">smart-topology-agent.py --print</span> · ถอนการติดตั้ง: <span class="mono">install-agent.ps1 -Uninstall</span> / <span class="mono">install-agent.sh --uninstall</span></div>
    </div>
    <div class="card panel"><div class="ph"><h3>${icon('sliders', 17)}<span class="th">ตั้งค่าทะเบียนคอมพิวเตอร์</span></h3></div>
      ${S2 ? `<form id="ivSet" class="form">
        <div><label>รอบการส่งรายงานของ Agent (นาที)</label><input class="inp" type="number" min="5" max="1440" name="intervalMin" value="${S2.intervalMin}"><div class="hint">ใช้คำนวณสถานะ “ออนไลน์” · รอบจริงกำหนดตอนติดตั้ง (-IntervalMinutes / --interval)</div></div>
        <div><label>ถือว่า “ขาดการรายงาน” เมื่อเกิน (วัน)</label><input class="inp" type="number" min="1" max="365" name="staleDays" value="${S2.staleDays}"></div>
        <div><label>แจ้งพื้นที่ดิสก์ใกล้เต็มเมื่อว่างน้อยกว่า (%)</label><input class="inp" type="number" min="1" max="50" name="lowDiskPct" value="${S2.lowDiskPct}"></div>
        <div></div>
        <label class="check full"><input type="checkbox" name="trackSoftware" ${S2.trackSoftware ? 'checked' : ''}> เก็บรายการซอฟต์แวร์และบันทึกการติดตั้ง/ถอน/อัปเดตโปรแกรม</label>
        <label class="check full"><input type="checkbox" name="trackIp" ${S2.trackIp ? 'checked' : ''}> บันทึกการเปลี่ยน IP Address (ปิดได้ถ้าใช้ DHCP แล้ว IP เปลี่ยนบ่อย)</label>
        <label class="check full"><input type="checkbox" name="alertHardware" ${S2.alertHardware ? 'checked' : ''}> สร้างการแจ้งเตือนเมื่อฮาร์ดแวร์ถูกถอด/เปลี่ยน (RAM ลดลง, ถอดดิสก์, เปลี่ยน CPU / Serial / เมนบอร์ด)</label>
        ${can('admin') ? `<div class="full"><button class="btn primary" type="submit">${icon('check', 15)} บันทึก</button></div>` : ''}
      </form>` : '<div class="empty">กำลังโหลด…</div>'}
    </div></div>`;
  if (!S2) { api('GET', '/api/inventory').then((x) => { IV.data = x; if (IV.sub === 'agent' && S.tab === 'inventory') vInvAgent(); }).catch((e) => toast(e.message, 'bad')); return; }
  const f = $('#ivSet');
  if (f) f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('PUT', '/api/inventory/settings', { intervalMin: f.intervalMin.value, staleDays: f.staleDays.value, lowDiskPct: f.lowDiskPct.value, trackSoftware: f.trackSoftware.checked, trackIp: f.trackIp.checked, alertHardware: f.alertHardware.checked }); IV.data.settings = r.settings; toast('บันทึกการตั้งค่าแล้ว', 'ok'); }
    catch (ex) { toast(ex.message, 'bad'); }
  });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (!a.startsWith('iv')) return;
  e.preventDefault();
  try {
    if (a === 'ivsub') { IV.sub = el.dataset.s; ivSave(); vInventory(); }
    else if (a === 'ivopen') { closeModal(); invDetail(Number(el.dataset.id)); }
    else if (a === 'ivadd') invEditModal(null);
    else if (a === 'ivedit') { const cur = IV.cur; closeModal(); invEditModal(cur); }
    else if (a === 'ivdel') { if (await confirmBox('ลบออกจากทะเบียน', `ลบ <b>${esc(el.dataset.name)}</b> ออกจากทะเบียน?<br><span class="muted">ประวัติการเปลี่ยนแปลงเดิมยังเก็บไว้ ถ้า Agent ยังติดตั้งอยู่ เครื่องจะกลับมาลงทะเบียนใหม่ในรอบถัดไป</span>`, 'ลบ')) { await api('DELETE', `/api/inventory/assets/${el.dataset.id}`); closeModal(); toast('ลบแล้ว', 'ok'); loadInv(); } }
    else if (a === 'ivrmode') { IV.rep.mode = el.dataset.m; IV.rep.date = ''; ivSave(); vInvReport(); }
    else if (a === 'ivrshift') shiftRep(Number(el.dataset.d));
    else if (a === 'ivrcsv') location.href = `/api/inventory/changes.csv?${repQuery()}`;
    else if (a === 'ivkey') {
      apiKeyModal({ name: 'Agent เครื่องลูกข่าย', role: 'agent', expiresDays: 0,
        after: (tok) => { const c = agentCmds(tok); return `<div class="sub-h" style="margin-top:14px">Windows — PowerShell (Run as administrator)</div><div class="code-block" style="user-select:all;color:var(--text)">${esc(c.win)}</div>
          <div class="sub-h">Linux</div><div class="code-block" style="user-select:all;color:var(--text)">${esc(c.linux)}</div>
          <div class="hint">ติดตั้งผ่าน GPO: แก้ค่า SERVER และ KEY ในไฟล์ install-agent.cmd แล้วตั้งเป็น Computer Startup Script พร้อม parameter <span class="mono">/gpo</span></div>`; } });
    }
  } catch (ex) { toast(ex.message, 'bad'); }
});
