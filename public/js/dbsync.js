'use strict';
/* ============================================================
   ฐานข้อมูล Master / Slave — Dashboard + ตั้งค่า + Custom Query
   ใช้ฟังก์ชันร่วมจาก common.js, app.js, reports.js
   ============================================================ */
const DS = { data: null, hist: null, range: store.get('nms_ds_range', 24), onlyDiff: true, tq: '', timer: null };
const DS_ST = {
  sync: ['ข้อมูลตรงกัน · SYNC', 'ok'], lag: ['Replication ล่าช้า · LAG', 'warn'], diff: ['ข้อมูลไม่ตรงกัน · DIFF', 'warn'],
  warning: ['มีข้อควรระวัง', 'warn'], broken: ['Replication หยุดทำงาน', 'bad'], offline: ['เชื่อมต่อไม่ได้ · OFFLINE', 'bad'],
  norepl: ['ไม่ได้ตั้งค่า Replication', 'bad'], pending: ['รอตรวจสอบ', 'muted'],
};
const Q_ST = { ok: ['ตรงกัน', 'ok'], diff: ['ไม่ตรงกัน', 'bad'], error: ['ผิดพลาด', 'warn'], info: ['แสดงผล', 'info'] };
const LV = { critical: ['bad', 'alert'], warning: ['warn', 'alert'], info: ['info', 'bulb'] };

const DS_TEMPLATES = [
  { group: 'จากไฟล์ index.php (HOSxP)', name: 'จำนวนแถว 12 ตาราง HOSxP', sql: 'SELECT \'ovst\' AS tbl, COUNT(*) AS total FROM ovst\nUNION ALL SELECT \'vn_stat\', COUNT(*) FROM vn_stat\nUNION ALL SELECT \'an_stat\', COUNT(*) FROM an_stat\nUNION ALL SELECT \'opdscreen\', COUNT(*) FROM opdscreen\nUNION ALL SELECT \'opitemrece\', COUNT(*) FROM opitemrece\nUNION ALL SELECT \'ipt\', COUNT(*) FROM ipt\nUNION ALL SELECT \'ovstdiag\', COUNT(*) FROM ovstdiag\nUNION ALL SELECT \'lab_order\', COUNT(*) FROM lab_order\nUNION ALL SELECT \'lab_head\', COUNT(*) FROM lab_head\nUNION ALL SELECT \'er_regist\', COUNT(*) FROM er_regist\nUNION ALL SELECT \'patient\', COUNT(*) FROM patient\nUNION ALL SELECT \'person\', COUNT(*) FROM person', mode: 'table', tolerance: 5, everyMin: 60, timeoutSec: 120,
    description: 'แปลงจาก index.php — COUNT(*) ทั้งตาราง ±5 เผื่อข้อมูลเข้าระหว่างนับ · ตารางใหญ่ใช้เวลานาน จึงรันทุก 60 นาที (และทุกครั้งที่ส่งรายงาน)' },
  { group: 'จากไฟล์ index.php (HOSxP)', name: 'ข้อมูลวันนี้ แยกตาราง', sql: 'SELECT \'ovst\' AS tbl, COUNT(*) AS today FROM ovst WHERE vstdate = CURDATE()\nUNION ALL SELECT \'vn_stat\', COUNT(*) FROM vn_stat WHERE vstdate = CURDATE()\nUNION ALL SELECT \'opdscreen\', COUNT(*) FROM opdscreen WHERE vstdate = CURDATE()\nUNION ALL SELECT \'opitemrece\', COUNT(*) FROM opitemrece WHERE rxdate = CURDATE()\nUNION ALL SELECT \'ovstdiag\', COUNT(*) FROM ovstdiag WHERE vstdate = CURDATE()\nUNION ALL SELECT \'er_regist\', COUNT(*) FROM er_regist WHERE vstdate = CURDATE()\nUNION ALL SELECT \'ipt\', COUNT(*) FROM ipt WHERE regdate = CURDATE()\nUNION ALL SELECT \'lab_head\', COUNT(*) FROM lab_head WHERE order_date = CURDATE()', mode: 'table', tolerance: 3, everyMin: 0, timeoutSec: 30,
    description: 'นับเฉพาะวันนี้ (ใช้ index วันที่ เบากว่ามาก) ตรวจได้ทุกรอบ' },
  { group: 'จากไฟล์ index.php (HOSxP)', name: 'ข้อมูลถึงเมื่อวาน (ต้องตรงกัน 100%)', sql: 'SELECT \'ovst\' AS tbl, COUNT(*) AS until_yesterday FROM ovst WHERE vstdate < CURDATE()\nUNION ALL SELECT \'vn_stat\', COUNT(*) FROM vn_stat WHERE vstdate < CURDATE()\nUNION ALL SELECT \'opdscreen\', COUNT(*) FROM opdscreen WHERE vstdate < CURDATE()\nUNION ALL SELECT \'opitemrece\', COUNT(*) FROM opitemrece WHERE rxdate < CURDATE()\nUNION ALL SELECT \'ovstdiag\', COUNT(*) FROM ovstdiag WHERE vstdate < CURDATE()\nUNION ALL SELECT \'er_regist\', COUNT(*) FROM er_regist WHERE vstdate < CURDATE()\nUNION ALL SELECT \'ipt\', COUNT(*) FROM ipt WHERE regdate < CURDATE()\nUNION ALL SELECT \'lab_head\', COUNT(*) FROM lab_head WHERE order_date < CURDATE()', mode: 'table', tolerance: 0, everyMin: 60, timeoutSec: 120,
    description: 'ข้อมูลย้อนหลังไม่ควรเปลี่ยน — ถ้าต่างแม้ 1 แถว แปลว่าข้อมูล Slave ไม่ครบ/ถูกแก้' },
  { group: 'HOSxP', name: 'จำนวนผู้มารับบริการวันนี้', sql: 'SELECT COUNT(*) FROM ovst WHERE vstdate = CURDATE()', mode: 'value', tolerance: 0, description: 'นับ visit ของวันนี้ ใช้ตรวจว่า Slave รับข้อมูลทันหรือไม่' },
  { group: 'HOSxP', name: 'VN ล่าสุด', sql: 'SELECT MAX(vn) FROM ovst', mode: 'value', tolerance: 0, description: 'VN ล่าสุดที่บันทึก ถ้าต่างกันแปลว่า Slave ยังตามไม่ทัน' },
  { group: 'HOSxP', name: 'เวลารับบริการล่าสุด', sql: "SELECT MAX(CONCAT(vstdate, ' ', vsttime)) FROM ovst WHERE vstdate >= CURDATE() - INTERVAL 1 DAY", mode: 'value', tolerance: 0, description: 'เวลาของ visit ล่าสุด' },
  { group: 'HOSxP', name: 'ผู้มารับบริการวันนี้ แยกแผนก', sql: 'SELECT o.main_dep, k.department, COUNT(*) AS visits\nFROM ovst o LEFT JOIN kskdepartment k ON k.depcode = o.main_dep\nWHERE o.vstdate = CURDATE()\nGROUP BY o.main_dep, k.department\nORDER BY o.main_dep', mode: 'table', description: 'เปรียบเทียบจำนวน visit รายแผนก' },
  { group: 'HOSxP', name: 'จำนวนผู้ป่วยทั้งหมด (HN)', sql: 'SELECT COUNT(*) FROM patient', mode: 'value', tolerance: 0, everyMin: 30, description: 'ตรวจทุก 30 นาที' },
  { group: 'HOSxP', name: 'รายการยา/ค่าบริการวันนี้', sql: 'SELECT COUNT(*) FROM opitemrece WHERE rxdate = CURDATE()', mode: 'value', tolerance: 0 },
  { group: 'HOSxP', name: 'ผู้ป่วยในที่ยังไม่จำหน่าย (Admit)', sql: 'SELECT COUNT(*) FROM ipt WHERE dchdate IS NULL', mode: 'value', tolerance: 0 },
  { group: 'ทั่วไป', name: 'นาฬิกาของเครื่อง (วินาที)', sql: 'SELECT UNIX_TIMESTAMP()', mode: 'value', tolerance: 5, description: 'เวลาเครื่องควรต่างกันไม่เกิน 5 วินาที (ตรวจ NTP)' },
  { group: 'ทั่วไป', name: 'จำนวนตารางในฐานข้อมูล', sql: "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()", mode: 'value', tolerance: 0, everyMin: 60 },
  { group: 'ทั่วไป', name: 'Checksum ตารางขนาดเล็ก', sql: 'CHECKSUM TABLE kskdepartment', mode: 'table', everyMin: 30, description: 'เปลี่ยนชื่อตารางเป็นตารางข้อมูลหลักขนาดเล็ก (ไม่ควรใช้กับตารางใหญ่)' },
  { group: 'ทั่วไป', name: 'การเชื่อมต่อที่กำลังทำงาน (Slave)', sql: "SELECT COUNT(*) FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Sleep'", mode: 'value', target: 'slave', description: 'แสดงอย่างเดียว ไม่เปรียบเทียบ' },
];

/* ---------------------------------------------------------------- helpers */
const dsMask = (h) => maskIp(String(h || ''));
const pillDs = (code) => { const s = DS_ST[code] || DS_ST.pending; return `<span class="pill ${s[1]} dspill"><span class="sdot c-${s[1]}"></span>${s[0]}</span>`; };
function fUptime(sec) { if (sec == null) return '—'; const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60); return d ? `${d} วัน ${h} ชม.` : h ? `${h} ชม. ${m} นาที` : `${m} นาที`; }
function fBytesN(b) { if (b == null) return '—'; return b > 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${(b / 1024).toFixed(1)} KB` : `${b} B`; }
function dsVal(v) { return v == null ? '<span class="faint">NULL</span>' : esc(String(v)); }
function tableHtml(columns, rows, mark) {
  if (!rows || !rows.length) return '<div class="empty" style="padding:14px">ไม่มีแถวข้อมูล</div>';
  return `<div class="tblwrap dsres"><table class="tbl"><thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map((r, ri) => `<tr class="${mark ? mark(r, ri) || '' : ''}">${r.map((v) => `<td class="mono">${dsVal(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/* ---------------------------------------------------------------- page */
function vDbSync() {
  $('#view').innerHTML = `<div id="dsBody"><div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}<div>กำลังโหลด...</div></div></div></div>`;
  loadDs();
  clearInterval(DS.timer);
  DS.timer = setInterval(() => { if (S.tab === 'dbsync' && !$('#modalRoot .modal') && !document.hidden) loadDs(true); }, 15000);
}
async function loadDs(silent) {
  try {
    DS.data = await api('GET', '/api/dbsync');
    const y = window.scrollY;
    renderDs();
    if (silent) window.scrollTo(0, y);
    loadDsHist();
  } catch (e) { if (!silent) $('#dsBody').innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
}
async function loadDsHist() {
  try { DS.hist = await api('GET', `/api/dbsync/history?hours=${DS.range}`); drawDsCharts(); } catch { /* ignore */ }
}
function serverCard(side, info, extra) {
  const role = side === 'master' ? 'MASTER' : 'SLAVE';
  const c = DS.data.config ? DS.data.config[side] : null;
  if (!info) return `<div class="card dssrv ${side}"><div class="dsrole">${role}</div><div class="empty">ยังไม่มีข้อมูล</div></div>`;
  const ro = side === 'slave' && !info.readOnly ? 'warn' : 'muted';
  return `<div class="card dssrv ${side} ${info.ok ? '' : 'down'}">
    <div class="dshead"><span class="dsrole">${role}</span><span class="sdot c-${info.ok ? 'ok' : 'bad'}"></span>
      <b class="mono">${esc(dsMask(info.host))}:${info.port}</b>${c && c.database ? `<span class="pill muted mono">${esc(c.database)}</span>` : ''}
      <span class="right mono faint">${info.ok ? `${info.latencyMs} ms` : 'OFFLINE'}</span></div>
    ${info.ok ? `<div class="dsname">${esc(info.hostname || '')} <span class="faint">· ${esc(info.mariadb ? 'MariaDB' : 'MySQL')} ${esc(String(info.version || '').split('-')[0])}</span></div>
    <div class="kv">
      <div><span>Server ID</span><span class="mono">${info.serverId}</span></div>
      <div><span>read_only</span><span class="pill ${info.readOnly ? 'info' : ro}" style="max-width:none">${info.readOnly ? 'ON' : 'OFF'}</span></div>
      <div><span>Uptime</span><span>${fUptime(info.uptime)}</span></div>
      <div><span>Connections (กำลังทำงาน)</span><span class="mono">${fNum(info.threads)} (${fNum(info.running)})</span></div>
      <div><span>Queries / วินาที</span><span class="mono">${info.qps == null ? '—' : fNum(info.qps)}</span></div>
      ${extra || ''}
    </div>` : `<div class="err" style="margin:10px 0 0">${esc(info.error || 'เชื่อมต่อไม่ได้')}</div>`}
  </div>`;
}
function renderDs() {
  const d = DS.data, body = $('#dsBody'); if (!body || !d) return;
  const admin = can('admin'), op = can('operator');
  if (!d.driver) { body.innerHTML = `<div class="card panel"><div class="err">ยังไม่ได้ติดตั้งไลบรารี mysql2 — สั่ง <b>npm install</b> ในโฟลเดอร์โปรแกรมแล้วเปิดโปรแกรมใหม่</div></div>`; return; }
  if (!d.configured) {
    body.innerHTML = `<div class="card panel"><div class="empty" style="padding:50px 20px">${icon('database', 40)}
      <h2 style="color:var(--text);margin:10px 0 6px">ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล Master / Slave</h2>
      <p>กำหนด IP เครื่องฐานข้อมูลหลัก (Master) และเครื่องสำรอง (Slave) เพื่อเปรียบเทียบข้อมูลและตรวจสถานะ Replication</p>
      ${admin ? `<button class="btn primary" data-act="dscfg" style="margin-top:12px">${icon('sliders', 16)} ตั้งค่าการเชื่อมต่อ</button>` : '<p>กรุณาติดต่อผู้ดูแลระบบ</p>'}</div></div>`;
    return;
  }
  const L = d.last, code = L ? L.code : 'pending';
  const p = (L && L.replica) || {}, b = (L && L.binlog) || {};
  const cfg = d.config || {};
  const lagC = p.lag == null ? 'muted' : p.lag >= (cfg.lagCrit || 300) ? 'bad' : p.lag >= (cfg.lagWarn || 30) ? 'warn' : 'ok';
  const flow = !L ? 'idle' : ['broken', 'offline', 'norepl'].includes(code) ? 'down' : code === 'lag' ? 'slow' : 'up';
  const yesNo = (v) => `<span class="pill ${v === 'Yes' ? 'ok' : 'bad'}">${esc(v || '—')}</span>`;
  const masterExtra = L && L.master.ok ? `<div><span>Binary log</span><span class="mono">${b.error ? '<span class="pill warn">ไม่มีสิทธิ์</span>' : b.enabled === false ? 'OFF' : `${esc(b.file || '—')} @ ${fNum(b.pos)}`}</span></div>
      ${b.gtid ? `<div><span>GTID</span><span class="mono" title="${esc(b.gtid)}">${esc(String(b.gtid).slice(0, 34))}</span></div>` : ''}` : '';
  const slaveExtra = L && L.slave.ok && !p.error && !p.notReplica ? `<div><span>Exec position</span><span class="mono">${esc(p.execFile || '—')} @ ${fNum(p.execPos)}</span></div>
      <div><span>รับข้อมูลจาก</span><span class="mono">${esc(dsMask(p.sourceHost))}:${p.sourcePort || ''}</span></div>
      ${p.executedGtid ? `<div><span>GTID</span><span class="mono" title="${esc(p.executedGtid)}">${esc(String(p.executedGtid).slice(0, 34))}</span></div>` : ''}` : '';
  const q = d.queries || [], qres = new Map(((L && L.queries) || []).map((x) => [x.id, x]));
  const T = d.tables;
  body.innerHTML = `
  <div class="card panel rbar">
    <h2 class="dstitle">${icon('database', 20)} ฐานข้อมูล Master / Slave</h2>
    ${pillDs(code)}
    <span class="muted" style="font-size:12.5px">${L ? `ตรวจล่าสุด ${fmtTime(L.at)} · ทุก ${d.intervalSec} วินาที` : 'รอการตรวจรอบแรก'}${d.enabled ? '' : ' · <b style="color:var(--warn)">ปิดการตรวจอัตโนมัติ</b>'}${cfg.reportEnabled ? ` · รายงานเวลา ${esc(cfg.reportTimes)}` : ''}</span>
    <span style="flex:1"></span>
    ${op ? `<button class="btn sm" data-act="dsrun">${icon('refresh', 15)} ตรวจสอบทันที</button><button class="btn sm" data-act="dstables">${icon('grid', 15)} เปรียบเทียบตาราง</button>` : ''}
    ${admin ? `<button class="btn sm" data-act="dsreport">${icon('bell', 15)} ส่งรายงาน</button>` : ''}
    ${admin ? `<button class="btn sm primary" data-act="dscfg">${icon('sliders', 15)} ตั้งค่าการเชื่อมต่อ</button>` : ''}
  </div>

  <div class="dscluster">
    ${serverCard('master', L && L.master, masterExtra)}
    <div class="card dsmid">
      <div class="k">Replication Delay</div>
      <div class="lagv c-txt-${lagC}">${p.lag == null ? '—' : fNum(p.lag)}<small>${p.lag == null ? '' : ' วินาที'}</small></div>
      <svg class="dsflow ${flow}" viewBox="0 0 240 40" preserveAspectRatio="none"><path d="M6 20 H228"/><path class="ah" d="M220 12 L232 20 L220 28"/></svg>
      <div class="dsmeta">
        ${p.error ? `<div class="err" style="font-size:12px">${esc(p.error)}</div>` : p.notReplica ? '<div class="err">Slave ไม่ได้ตั้งค่า Replication</div>' : L && L.slave.ok ? `
        <div class="dsrow"><span>IO Thread</span>${yesNo(p.io)}</div>
        <div class="dsrow"><span>SQL Thread</span>${yesNo(p.sql)}</div>
        <div class="dsrow"><span>ข้อมูลที่ยังไม่ได้ apply</span><b class="mono">${L.gapBytes == null ? (p.execFile && b.file && p.execFile !== b.file ? 'ต่างไฟล์ binlog' : '—') : L.gapBytes === 0 ? 'ตามทันแล้ว ✓' : fBytesN(L.gapBytes)}</b></div>
        <div class="dsrow"><span>GTID</span><span class="mono">${esc(p.gtidMode || '—')}</span></div>
        ${p.sqlState ? `<div class="faint" style="font-size:11.5px;margin-top:6px">${esc(p.sqlState)}</div>` : ''}` : '<div class="faint">ไม่มีข้อมูลจากเครื่อง Slave</div>'}
        ${p.sqlError || p.ioError ? `<div class="err" style="margin-top:8px;font-size:12px">${p.lastErrno ? `[${p.lastErrno}] ` : ''}${esc(p.sqlError || p.ioError)}</div>` : ''}
      </div>
    </div>
    ${serverCard('slave', L && L.slave, slaveExtra)}
  </div>

  ${L && L.issues.length ? `<div class="card panel dsissues"><div class="ph"><h3>${icon('alert', 17)}<span class="th">ปัญหาที่พบ</span></h3><span class="right">${L.issues.length} รายการ</span></div>
    ${L.issues.map((i) => `<div class="dsiss ${LV[i.level][0]}">${icon(LV[i.level][1], 16)}<span>${esc(i.text)}</span></div>`).join('')}</div>` : ''}

  <div class="grid g2">
    <div class="card panel"><div class="ph"><h3>${icon('activity', 17)}<span class="th">Replication Delay</span><span class="bar"></span>วินาที</h3>
      <div class="seg dsrange" style="margin-left:auto">${[[1, '1 ชม.'], [6, '6 ชม.'], [24, '24 ชม.'], [168, '7 วัน'], [720, '30 วัน']].map(([h, l]) => `<button data-act="dsrange" data-h="${h}" class="${+DS.range === h ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="rchart-host" id="dsLag"></div><div class="faint" style="font-size:11.5px" id="dsSrc"></div></div>
    <div class="card panel"><div class="ph"><h3>${icon('gauge', 17)}<span class="th">เวลาตอบสนองของฐานข้อมูล</span><span class="bar"></span>ms</h3>
      ${legend([['#1aa3e8', 'Master'], ['#8b5cf6', 'Slave']])}</div><div class="rchart-host" id="dsMs"></div></div>
  </div>

  <div class="card panel"><div class="ph"><h3>${icon('list', 17)}<span class="th">การเปรียบเทียบข้อมูล</span><span class="bar"></span>Custom Query</h3>
    <span class="right" style="text-transform:none">${admin ? `<button class="btn sm" data-act="dstpl">${icon('wand', 14)} เพิ่มจากตัวอย่าง</button><button class="btn sm primary" data-act="dsqadd">${icon('plus', 14)} เพิ่ม Query</button>` : ''}</span></div>
    ${q.length ? `<div class="qgrid">${q.map((x) => queryCard(x, qres.get(x.id), admin)).join('')}</div>`
    : `<div class="empty">${icon('list', 26)}<div>ยังไม่มี Query สำหรับเปรียบเทียบ${admin ? ' — กด “เพิ่มจากตัวอย่าง” เพื่อเริ่มต้นด้วย Query สำหรับ HOSxP' : ''}</div></div>`}
  </div>

  <div class="card panel"><div class="ph"><h3>${icon('grid', 17)}<span class="th">เปรียบเทียบตาราง</span><span class="bar"></span>${T && T.database ? `${esc(T.database.master)} ↔ ${esc(T.database.slave)}` : 'Tables'}</h3>
    <span class="right">${T && T.at ? `ตรวจเมื่อ ${fmtDT(T.at)}` : ''}</span></div>
    ${!T ? '<div class="empty">ยังไม่ได้เปรียบเทียบ — กด “เปรียบเทียบตาราง”</div>' : T.error ? `<div class="err">${esc(T.error)}</div>` : tablesSection(T)}
  </div>`;
  drawDsCharts();
}
/** ผลแบบตาราง 2 คอลัมน์ (ชื่อ, ค่า) → แสดงรายแถว Master / Slave / ส่วนต่าง */
function kvList(r, q) {
  const tol = Number(q.tolerance) || 0;
  const sm = new Map(r.slave.rows.map((x) => [String(x[0]), x[1]]));
  const keys = [...r.master.rows.map((x) => String(x[0])), ...r.slave.rows.map((x) => String(x[0])).filter((k) => !r.master.rows.some((y) => String(y[0]) === k))];
  const mm = new Map(r.master.rows.map((x) => [String(x[0]), x[1]]));
  const rows = keys.map((k) => {
    const a = mm.get(k), b = sm.get(k);
    const num = a != null && b != null && /^-?\d+(\.\d+)?$/.test(String(a)) && /^-?\d+(\.\d+)?$/.test(String(b));
    const d = num ? Number(a) - Number(b) : null;
    const ok = a !== undefined && b !== undefined && (String(a) === String(b) || (num && Math.abs(d) <= tol));
    return `<div class="kvr ${ok ? '' : 'bad'}"><span class="mono">${esc(k)}</span><span class="mono">${a === undefined ? '—' : dsVal(a)}</span><span class="mono">${b === undefined ? '—' : dsVal(b)}</span>
      <span class="mono">${ok ? (d ? `<span class="faint">${d > 0 ? '+' : ''}${fNum(d)}</span>` : '✓') : num ? `${d > 0 ? '+' : ''}${fNum(d)}` : '✗'}</span></div>`;
  }).join('');
  const bad = r.compare.counts.changed + r.compare.counts.onlyMaster + r.compare.counts.onlySlave;
  return `<div class="kvlist"><div class="kvr head"><span>${esc(r.master.columns[0])}</span><span>Master</span><span>Slave</span><span>ต่าง</span></div>${rows}</div>
    <div class="qdiff ${r.compare.ok ? 'ok' : 'bad'}">${r.compare.ok ? `✓ ตรงกันทั้ง ${keys.length} รายการ${tol ? ` (เกณฑ์ ±${tol})` : ''}` : `ไม่ตรงกัน ${bad} จาก ${keys.length} รายการ${tol ? ` (เกณฑ์ ±${tol})` : ''}`}</div>`;
}
function queryCard(q, r, admin) {
  const st = r ? Q_ST[r.status] : ['รอผล', 'muted'];
  let mid = '<div class="faint" style="padding:8px 0">รอผลการตรวจรอบถัดไป</div>';
  if (r) {
    if (r.status === 'error') mid = `<div class="err" style="font-size:12px">${esc((r.master && r.master.error) || (r.slave && r.slave.error))}</div>`;
    else if (q.target !== 'both') {
      const x = r[q.target];
      mid = `<div class="qv one"><div><span>${q.target === 'master' ? 'Master' : 'Slave'}</span><b>${q.mode === 'table' ? `${fNum(x.total)} แถว` : dsVal(x.rows[0] ? x.rows[0][0] : null)}</b></div></div>`;
    } else if (q.mode === 'table' && r.master.columns.length === 2 && r.master.rows.length <= 25) {
      mid = kvList(r, q);
    } else if (q.mode === 'table') {
      const c = r.compare.counts;
      mid = `<div class="qv"><div><span>Master</span><b>${fNum(c.master)} แถว</b></div><div><span>Slave</span><b>${fNum(c.slave)} แถว</b></div></div>
        <div class="qdiff ${r.compare.ok ? 'ok' : 'bad'}">${r.compare.ok ? `✓ ตรงกันทุกแถว (${fNum(r.compare.same)})` : `ตรงกัน ${fNum(r.compare.same)} · ต่างกัน <b>${c.changed}</b> · เฉพาะ Master <b>${c.onlyMaster}</b> · เฉพาะ Slave <b>${c.onlySlave}</b>${r.compare.sameCols ? '' : ' · คอลัมน์ต่างกัน'}`}</div>`;
    } else {
      const a = r.master.rows[0] ? r.master.rows[0][0] : null, b = r.slave.rows[0] ? r.slave.rows[0][0] : null;
      const hist = (DS.data.queryHistory || {})[q.id] || [];
      const lc = (v) => (String(v ?? '').length > 10 ? ' class="long"' : '');
      mid = `<div class="qv"><div><span>Master</span><b${lc(a)} title="${esc(a ?? '')}">${dsVal(a)}</b></div><div><span>Slave</span><b${lc(b)} title="${esc(b ?? '')}">${dsVal(b)}</b></div></div>
        <div class="qdiff ${r.compare.ok ? 'ok' : 'bad'}">${r.compare.ok ? (r.compare.numeric && r.compare.diff ? `✓ ต่างกัน ${r.compare.diff} (อยู่ในเกณฑ์ ±${q.tolerance || 0})` : '✓ ตรงกัน') : `ส่วนต่าง <b>${r.compare.numeric ? (r.compare.diff > 0 ? '+' : '') + fNum(r.compare.diff) : 'ค่าไม่เท่ากัน'}</b>${q.tolerance ? ` (เกณฑ์ ±${q.tolerance})` : ''}`}
        ${hist.length > 2 ? `<span class="qspark">${spark(hist, { w: 90, h: 22, fill: false, color: hist.some((v) => Math.abs(v) > (q.tolerance || 0)) ? '#f0425f' : '#0e9b87' })}</span>` : ''}</div>`;
    }
  }
  const ms = r ? [r.master && r.master.ms != null ? `M ${r.master.ms} ms` : '', r.slave && r.slave.ms != null ? `S ${r.slave.ms} ms` : ''].filter(Boolean).join(' · ') : '';
  const wide = r && q.mode === 'table' && q.target === 'both' && r.master && r.master.columns && r.master.columns.length === 2 && r.master.rows.length > 6;
  return `<div class="card qcard ${r ? r.status : ''} ${q.enabled === false ? 'off' : ''} ${wide ? 'wide' : ''}">
    <div class="qtop"><b>${esc(q.name)}</b><span class="pill ${st[1]}">${q.enabled === false ? 'ปิดอยู่' : st[0]}</span></div>
    <div class="qsub"><span class="pill muted">${q.mode === 'table' ? 'ตาราง' : 'ค่าเดียว'}</span>${q.target !== 'both' ? `<span class="pill info">เฉพาะ ${q.target === 'master' ? 'Master' : 'Slave'}</span>` : ''}${q.description ? `<span class="faint">${esc(q.description)}</span>` : ''}</div>
    ${mid}
    <div class="qfoot"><span class="mono faint">${ms}${r ? ` · ${fmtTime(r.at)}` : ''}</span><span style="flex:1"></span>
      ${r && r.status !== 'error' ? `<button class="btn sm" data-act="dsqview" data-id="${q.id}">ดูผลลัพธ์</button>` : ''}
      ${admin ? `<button class="btn sm" data-act="dsqedit" data-id="${q.id}" title="แก้ไข">${icon('edit', 14)}</button><button class="btn sm danger" data-act="dsqdel" data-id="${q.id}" title="ลบ">${icon('trash', 14)}</button>` : ''}</div>
  </div>`;
}
function tablesSection(T) {
  const s = T.summary;
  const ST = { ok: ['มีทั้งสองฝั่ง', 'muted'], missing_slave: ['ไม่มีใน Slave', 'bad'], missing_master: ['ไม่มีใน Master', 'warn'], exact_ok: ['จำนวนแถวตรงกัน', 'ok'], exact_diff: ['จำนวนแถวต่างกัน', 'bad'] };
  const rows = T.rows.filter((r) => (!DS.onlyDiff || r.status !== 'ok') && (!DS.tq || r.name.toLowerCase().includes(DS.tq.toLowerCase())));
  const ex = (v) => (v == null ? '—' : typeof v === 'object' ? `<span class="pill warn" title="${esc(v.error)}">error</span>` : fNum(v));
  return `<div class="dsstats">
      <div class="stat"><div class="k">ตาราง Master / Slave</div><div class="v">${fNum(s.master)} / ${fNum(s.slave)}</div></div>
      <div class="stat"><div class="k">ไม่มีใน Slave</div><div class="v" style="color:${s.onlyMaster ? 'var(--bad)' : 'inherit'}">${fNum(s.onlyMaster)}</div></div>
      <div class="stat"><div class="k">ไม่มีใน Master</div><div class="v" style="color:${s.onlySlave ? 'var(--warn)' : 'inherit'}">${fNum(s.onlySlave)}</div></div>
      <div class="stat"><div class="k">นับแถวจริง: ตรง / ต่าง</div><div class="v"><span style="color:var(--ok)">${s.exactOk}</span> / <span style="color:${s.exactDiff ? 'var(--bad)' : 'inherit'}">${s.exactDiff}</span></div></div>
      <div class="stat"><div class="k">ขนาด Master / Slave</div><div class="v" style="font-size:15px">${fBytesN(s.bytesMaster)} / ${fBytesN(s.bytesSlave)}</div></div>
    </div>
    <div class="toolbar" style="margin:12px 0 8px">
      <div class="chips"><button class="chip ${DS.onlyDiff ? 'on' : ''}" data-act="dstf" data-v="1">เฉพาะที่ต้องตรวจสอบ</button><button class="chip ${DS.onlyDiff ? '' : 'on'}" data-act="dstf" data-v="0">ทั้งหมด ${fNum(T.rows.length)}</button></div>
      <div class="field" style="flex:1;max-width:320px">${icon('search', 16)}<input class="inp" id="dsTq" placeholder="ค้นหาชื่อตาราง..." value="${esc(DS.tq)}"></div>
    </div>
    ${rows.length ? `<div class="tblwrap" style="max-height:440px;overflow:auto"><table class="tbl"><thead><tr><th>ตาราง</th><th style="text-align:right">แถว Master (ประมาณ)</th><th style="text-align:right">แถว Slave (ประมาณ)</th>
      <th style="text-align:right">นับจริง Master</th><th style="text-align:right">นับจริง Slave</th><th style="text-align:right">ขนาด</th><th>สถานะ</th></tr></thead><tbody>
      ${rows.slice(0, 500).map((r) => `<tr><td class="mono">${esc(r.name)}</td><td class="mono" style="text-align:right">${r.master ? fNum(r.master.rows) : '—'}</td><td class="mono" style="text-align:right">${r.slave ? fNum(r.slave.rows) : '—'}</td>
        <td class="mono" style="text-align:right">${ex(r.exact && r.exact.master)}</td><td class="mono" style="text-align:right">${ex(r.exact && r.exact.slave)}</td>
        <td class="mono" style="text-align:right">${fBytesN((r.master || r.slave).bytes)}</td><td><span class="pill ${ST[r.status][1]}">${ST[r.status][0]}</span></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${icon('check', 24)}<div>${DS.onlyDiff ? 'ไม่พบตารางที่ขาดหายหรือจำนวนแถวไม่ตรงกัน' : 'ไม่พบตาราง'}</div></div>`}
    <p class="faint" style="font-size:12px;margin:10px 0 0">* จำนวนแถว “ประมาณ” มาจาก information_schema ซึ่ง InnoDB ประมาณค่าไว้ จึงต่างกันได้เล็กน้อยแม้ข้อมูลตรงกัน · ตารางที่ต้องการนับจริงให้ระบุในหน้าตั้งค่า (ช่อง “ตารางที่นับแถวจริง”)</p>`;
}
function drawDsCharts() {
  const h = DS.hist, d = DS.data;
  if (!h || !$('#dsLag') || !d) return;
  const rows = h.rows, cfg = d.config || {};
  const warn = cfg.lagWarn || 30, crit = cfg.lagCrit || 300;
  const lab = (t) => { const x = new Date(t); return DS.range > 48 ? `${x.getDate()}/${x.getMonth() + 1} ${p2(x.getHours())}:00` : `${p2(x.getHours())}:${p2(x.getMinutes())}`; };
  $('#dsSrc').textContent = h.source === 'mysql' ? `ข้อมูลจากฐานข้อมูล log (nms_dbsync_log) · ${rows.length} จุด` : `ข้อมูลในหน่วยความจำตั้งแต่เปิดโปรแกรม · ตั้งค่าฐานข้อมูล MySQL สำหรับเก็บ Log เพื่อดูย้อนหลังได้นานขึ้น`;
  if (!rows.length) { $('#dsLag').innerHTML = $('#dsMs').innerHTML = '<div class="empty">ยังไม่มีข้อมูลในช่วงนี้</div>'; return; }
  const labels = rows.map((r) => lab(r.t));
  const maxLag = Math.max(0, ...rows.map((r) => r.lag || 0));
  drawChart($('#dsLag'), {
    title: 'Replication lag', labels, yFmt: (v) => `${Math.round(v)}`, height: 230, yMax: niceMax(Math.max(maxLag, warn) * 1.1),
    bars: [
      { values: rows.map((r) => (r.lag == null && r.bad ? niceMax(Math.max(maxLag, warn) * 1.1) : null)), color: 'rgba(240,66,95,.18)' },
      { values: rows.map((r) => (r.lag == null ? null : Math.max(r.lag, 0.0001))), color: '#0e9b87', colorAt: (i) => (rows[i].lag >= crit ? '#f0425f' : rows[i].lag >= warn ? '#f0a020' : '#0e9b87') },
    ],
    lines: [{ values: rows.map(() => warn), color: '#f0a020', dashed: true, width: 1.2 }],
    tooltip: (i) => { const r = rows[i]; return `<b>${esc(new Date(r.t).toLocaleString('th-TH', { hour12: false }))}</b>
      <div>Delay สูงสุด: <b>${r.lag == null ? 'ไม่มีข้อมูล' : `${fNum(r.lag)} วินาที`}</b></div>
      ${r.gap != null ? `<div>ยังไม่ apply: ${fBytesN(r.gap)}</div>` : ''}<div>รอบที่มีปัญหา: ${r.bad}/${r.n}</div>${r.diffs ? `<div>Query ไม่ตรงกัน: ${r.diffs}</div>` : ''}`; },
  });
  drawChart($('#dsMs'), {
    title: 'Response', labels, yFmt: (v) => `${+v.toFixed(1)}`, height: 230,
    lines: [{ values: rows.map((r) => r.mMs), color: '#1aa3e8' }, { values: rows.map((r) => r.sMs), color: '#8b5cf6' }],
    tooltip: (i) => `<b>${esc(new Date(rows[i].t).toLocaleString('th-TH', { hour12: false }))}</b><div>Master: <b>${fMs(rows[i].mMs)}</b></div><div>Slave: <b>${fMs(rows[i].sMs)}</b></div>`,
  });
}
window.addEventListener('resize', () => { if (S.tab === 'dbsync') drawDsCharts(); });

/* ---------------------------------------------------------------- modals */
function grantHelp(user) {
  const u = esc(user || 'nms_ro');
  return `<details class="dshelp"><summary>${icon('key', 14)} คำสั่งสร้างผู้ใช้แบบอ่านอย่างเดียว (รันบนเครื่อง Master ด้วย root — จะ replicate ไป Slave ให้อัตโนมัติ)</summary>
    <div class="code-block" style="user-select:all;margin-top:8px">-- MySQL 5.7 / 8.x
CREATE USER '${u}'@'IP เครื่อง Smart Topology' IDENTIFIED BY 'ตั้งรหัสผ่าน';
GRANT SELECT, PROCESS, REPLICATION CLIENT ON *.* TO '${u}'@'IP เครื่อง Smart Topology';

-- MariaDB 10.5 ขึ้นไป (สิทธิ์ดูสถานะ Replication แยกเป็น SLAVE MONITOR)
GRANT SELECT, PROCESS, BINLOG MONITOR, SLAVE MONITOR ON *.* TO '${u}'@'IP เครื่อง Smart Topology';
FLUSH PRIVILEGES;</div></details>`;
}
function sideForm(side, c) {
  const f = (k, l, v, o = {}) => `<div class="${o.full ? 'full' : ''}"><label>${l}${o.req ? ' <span class="req">*</span>' : ''}</label>
    <input class="inp ${o.mono ? 'mono' : ''}" name="${side}.${k}" value="${esc(v)}" type="${o.type || 'text'}" placeholder="${esc(o.ph || '')}" autocomplete="${o.ac || 'off'}" ${o.list ? `list="${o.list}"` : ''} spellcheck="false"></div>`;
  return `<div class="dsside ${side}"><div class="dshead"><span class="dsrole">${side === 'master' ? 'MASTER · เครื่องหลัก' : 'SLAVE · เครื่องสำรอง'}</span></div>
    <div class="form">
      ${f('host', 'IP / Host', c.host, { req: true, mono: true, ph: side === 'master' ? 'เช่น 172.16.1.10' : 'เช่น 172.16.1.11' })}
      ${f('port', 'Port', c.port, { mono: true, type: 'number' })}
      ${f('user', 'ชื่อผู้ใช้ MySQL', c.user, { req: true, mono: true, ph: 'nms_ro' })}
      ${f('password', 'รหัสผ่าน', c.password, { type: 'password', ac: 'new-password' })}
      ${f('database', 'ฐานข้อมูลที่เปรียบเทียบ', c.database, { mono: true, ph: 'เช่น hos', list: `dl-${side}`, full: true })}<datalist id="dl-${side}"></datalist>
      <label class="check full"><input type="checkbox" name="${side}.ssl" ${c.ssl ? 'checked' : ''}> เชื่อมต่อแบบ SSL/TLS</label>
      <div class="full"><button type="button" class="btn sm" data-act="dstest" data-side="${side}">${icon('zap', 14)} ทดสอบการเชื่อมต่อ ${side === 'master' ? 'Master' : 'Slave'}</button></div>
      <div class="full" id="dsTest-${side}"></div>
    </div></div>`;
}
function cfgModal() {
  const c = DS.data.config;
  const m = modal(`<div class="mh">${icon('sliders', 20)}<h2>ตั้งค่าการเชื่อมต่อฐานข้อมูล Master / Slave</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="dsCfg"><div class="mb"><div id="dsCfgErr" class="err hidden"></div>
      <div class="dssides">${sideForm('master', c.master)}<div class="dsarrow">${icon('arrow', 26)}<span>Replication</span></div>${sideForm('slave', c.slave)}</div>
      ${grantHelp(c.master.user)}
      <div class="sub-h" style="margin-top:18px">การตรวจสอบและการแจ้งเตือน</div>
      <div class="form">
        <div><label>ตรวจทุก (วินาที)</label><input class="inp" type="number" min="10" name="intervalSec" value="${c.intervalSec}"></div>
        <div><label>เปรียบเทียบตารางทุก (นาที)</label><input class="inp" type="number" min="1" name="tableIntervalMin" value="${c.tableIntervalMin}"></div>
        <div><label>เกณฑ์เตือน Replication Delay (วินาที)</label><input class="inp" type="number" min="1" name="lagWarn" value="${c.lagWarn}"></div>
        <div><label>เกณฑ์วิกฤต (วินาที)</label><input class="inp" type="number" min="2" name="lagCrit" value="${c.lagCrit}"></div>
        <div class="full"><label>ตารางที่นับแถวจริง (COUNT(*)) คั่นด้วย , </label><input class="inp mono" name="exactTables" value="${esc(c.exactTables)}" placeholder="เช่น patient, ovst, ipt">
          <div class="hint">ใช้กับตารางสำคัญเท่านั้น — การนับแถวตารางใหญ่ใช้เวลาและเพิ่มภาระเครื่อง (ทำตามรอบ “เปรียบเทียบตาราง”)</div></div>
        <div class="full sub-h" style="margin:8px 0 0">รายงานสรุปตามเวลา (แทนไฟล์ index.php)</div>
        <div><label>เวลาส่งรายงาน (คั่นด้วย ,)</label><input class="inp mono" name="reportTimes" value="${esc(c.reportTimes || '')}" placeholder="09:05, 12:10, 16:10">
          <div class="hint">ส่งผลทุก Query (Master/Slave) ผ่านหมอพร้อม/Webhook ตามเวลา</div></div>
        <div class="checks" style="flex-direction:column;gap:8px;padding-top:24px">
          <label class="check"><input type="checkbox" name="reportEnabled" ${c.reportEnabled ? 'checked' : ''}> เปิดส่งรายงานตามเวลา</label>
          <label class="check"><input type="checkbox" name="reportOnlyDiff" ${c.reportOnlyDiff ? 'checked' : ''}> ส่งเฉพาะเมื่อพบข้อมูลไม่ตรงกัน</label></div>
        <div class="full checks">
          <label class="check"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> เปิดการตรวจอัตโนมัติ</label>
          <label class="check"><input type="checkbox" name="notify" ${c.notify ? 'checked' : ''}> ส่งแจ้งเตือนภายนอก (หมอพร้อม / Webhook) เมื่อพบปัญหา</label>
        </div>
      </div></div>
      <div class="mf"><button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('check', 16)} บันทึกและเริ่มตรวจ</button></div></form>`, 'wide');
  m.querySelector('#dsCfg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, er = $('#dsCfgErr');
    try {
      DS.data = await api('PUT', '/api/dbsync/config', cfgBody(f));
      closeModal(); toast('บันทึกการตั้งค่าแล้ว', 'ok'); renderDs(); loadDsHist();
    } catch (ex) { er.textContent = ex.message; er.classList.remove('hidden'); er.scrollIntoView({ block: 'nearest' }); }
  });
}
function cfgBody(f) {
  const side = (s) => ({ host: f[`${s}.host`].value, port: f[`${s}.port`].value, user: f[`${s}.user`].value, password: f[`${s}.password`].value, database: f[`${s}.database`].value, ssl: f[`${s}.ssl`].checked });
  return { master: side('master'), slave: side('slave'), intervalSec: f.intervalSec.value, tableIntervalMin: f.tableIntervalMin.value, lagWarn: f.lagWarn.value,
    lagCrit: f.lagCrit.value, exactTables: f.exactTables.value, enabled: f.enabled.checked, notify: f.notify.checked,
    reportTimes: f.reportTimes.value, reportEnabled: f.reportEnabled.checked, reportOnlyDiff: f.reportOnlyDiff.checked };
}
async function testSideUi(side, btn) {
  const f = $('#dsCfg'), out = $(`#dsTest-${side}`), b = cfgBody(f)[side];
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `${icon('refresh', 14, 'spin')} กำลังทดสอบ...`;
  try {
    const r = await api('POST', '/api/dbsync/test', { side, config: b });
    if (!r.ok) { out.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
    $(`#dl-${side}`).innerHTML = r.databases.map((d) => `<option value="${esc(d)}">`).join('');
    const warn = [];
    if (r.canWrite) warn.push('ผู้ใช้นี้มีสิทธิ์เขียน/แก้ไขข้อมูล — แนะนำใช้ผู้ใช้แบบอ่านอย่างเดียว (SELECT)');
    if (!r.replClient) warn.push(side === 'slave' ? 'ไม่มีสิทธิ์ดูสถานะ Replication (ดูคำสั่ง GRANT ด้านล่าง)' : 'ไม่มีสิทธิ์ดูสถานะ binlog (ดูคำสั่ง GRANT ด้านล่าง)');
    if (side === 'slave' && !r.readOnly) warn.push('Slave ไม่ได้เปิด read_only');
    if (b.database && !r.databases.includes(b.database)) warn.push(`ไม่พบฐานข้อมูล ${b.database} (ผู้ใช้อาจไม่มีสิทธิ์)`);
    out.innerHTML = `<div class="ok-msg">✓ เชื่อมต่อสำเร็จ — ${esc(r.version)}<br>ผู้ใช้ ${esc(r.user)} · server_id ${r.serverId} · read_only ${r.readOnly ? 'ON' : 'OFF'}<br>${esc(r.role)}</div>
      ${warn.map((w) => `<div class="err" style="background:var(--warn-soft);color:#8a5a00;border-color:#f7d79a">${esc(w)}</div>`).join('')}`;
  } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; } finally { btn.disabled = false; btn.innerHTML = old; }
}
function queryModal(q) {
  const v = q || { target: 'both', mode: 'value', tolerance: 0, everyMin: 0, timeoutSec: 15, enabled: true };
  const m = modal(`<div class="mh">${icon(q && q.id ? 'edit' : 'plus', 20)}<h2>${q && q.id ? 'แก้ไข Query' : 'เพิ่ม Query สำหรับเปรียบเทียบ'}</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="dsQ"><div class="mb"><div id="dsQErr" class="err hidden"></div>
      <div class="form">
        <div><label>ชื่อที่แสดงบน Dashboard <span class="req">*</span></label><input class="inp" name="name" maxlength="80" required value="${esc(v.name)}" placeholder="เช่น จำนวนผู้มารับบริการวันนี้"></div>
        <div><label>คำอธิบาย</label><input class="inp" name="description" maxlength="300" value="${esc(v.description)}"></div>
        <div class="full"><label>คำสั่ง SQL <span class="req">*</span> <span class="faint" style="font-weight:400">— อ่านอย่างเดียว: SELECT / WITH / SHOW / EXPLAIN / CHECKSUM TABLE</span></label>
          <textarea class="inp" name="sql" rows="6" spellcheck="false" required placeholder="SELECT COUNT(*) FROM ovst WHERE vstdate = CURDATE()">${esc(v.sql)}</textarea></div>
        <div><label>รูปแบบผลลัพธ์</label><select class="sel" name="mode"><option value="value" ${v.mode !== 'table' ? 'selected' : ''}>ค่าเดียว (แถวแรก คอลัมน์แรก)</option><option value="table" ${v.mode === 'table' ? 'selected' : ''}>ตาราง (เทียบทุกแถว — คอลัมน์แรกเป็นคีย์)</option></select></div>
        <div><label>รันที่เครื่อง</label><select class="sel" name="target"><option value="both" ${v.target === 'both' ? 'selected' : ''}>ทั้งสองเครื่องแล้วเปรียบเทียบ</option><option value="master" ${v.target === 'master' ? 'selected' : ''}>เฉพาะ Master (แสดงผล)</option><option value="slave" ${v.target === 'slave' ? 'selected' : ''}>เฉพาะ Slave (แสดงผล)</option></select></div>
        <div><label>ยอมให้ต่างกันได้ (±) <span class="faint" style="font-weight:400">ใช้กับค่าตัวเลขทุกช่อง (ทั้งแบบค่าเดียวและแบบตาราง)</span></label><input class="inp" type="number" min="0" step="any" name="tolerance" value="${v.tolerance || 0}"></div>
        <div><label>ฐานข้อมูล <span class="faint" style="font-weight:400">(เว้นว่าง = ตามที่ตั้งค่า)</span></label><input class="inp mono" name="database" value="${esc(v.database)}" placeholder="hos"></div>
        <div><label>รันทุก (นาที) <span class="faint" style="font-weight:400">0 = ทุกรอบการตรวจ</span></label><input class="inp" type="number" min="0" name="everyMin" value="${v.everyMin || 0}"></div>
        <div><label>เวลาสูงสุดต่อครั้ง (วินาที)</label><input class="inp" type="number" min="1" max="120" name="timeoutSec" value="${v.timeoutSec || 15}"></div>
        <label class="check full"><input type="checkbox" name="enabled" ${v.enabled !== false ? 'checked' : ''}> เปิดใช้งาน Query นี้</label>
      </div>
      <div id="dsQRes" style="margin-top:14px"></div></div>
      <div class="mf"><button type="button" class="btn" data-act="dsqtest" style="margin-right:auto">${icon('zap', 15)} ทดสอบ Query</button>
        <button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('check', 16)} บันทึก</button></div></form>`, 'wide');
  const f = m.querySelector('#dsQ');
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      if (q && q.id) await api('PUT', `/api/dbsync/queries/${q.id}`, qBody(f)); else await api('POST', '/api/dbsync/queries', qBody(f));
      closeModal(); toast('บันทึก Query แล้ว — กำลังรันเพื่อเปรียบเทียบ', 'ok'); setTimeout(() => loadDs(true), 1500);
    } catch (ex) { const er = $('#dsQErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}
function qBody(f) {
  const o = Object.fromEntries(new FormData(f)); o.enabled = f.enabled.checked; return o;
}
function resultHtml(r, q) {
  if (!r) return '';
  const side = (name, x) => `<div><div class="sub-h">${name} ${x && x.ms != null ? `<span class="faint mono" style="font-weight:400">· ${x.ms} ms · ${fNum(x.total)} แถว${x.truncated ? ' (แสดง 500 แถวแรก)' : ''}</span>` : ''}</div>
    ${!x ? '<div class="faint">ไม่ได้รัน</div>' : x.error ? `<div class="err">${esc(x.error)}</div>` : tableHtml(x.columns, x.rows)}</div>`;
  let head = '';
  if (r.status === 'ok') head = `<div class="ok-msg">✓ ${r.compare ? 'ผลลัพธ์ของ Master และ Slave ตรงกัน' : 'รันสำเร็จ'}</div>`;
  else if (r.status === 'diff') {
    if (r.compare.counts) {
      const c = r.compare;
      head = `<div class="err">ผลลัพธ์ไม่ตรงกัน — ต่างกัน ${c.counts.changed} แถว · เฉพาะ Master ${c.counts.onlyMaster} · เฉพาะ Slave ${c.counts.onlySlave}${c.sameCols ? '' : ' · ชื่อคอลัมน์ไม่เหมือนกัน'}</div>
        ${c.changed.length ? `<div class="sub-h">แถวที่ค่าไม่ตรงกัน (คีย์ = คอลัมน์แรก)</div>${tableHtml(['ฝั่ง', ...r.master.columns], c.changed.flatMap((x) => [['Master', ...x.master], ['Slave', ...x.slave]]), (row, i) => (i % 2 ? 'rowS' : 'rowM'))}` : ''}
        ${c.onlyMaster.length ? `<div class="sub-h">มีเฉพาะใน Master</div>${tableHtml(r.master.columns, c.onlyMaster)}` : ''}
        ${c.onlySlave.length ? `<div class="sub-h">มีเฉพาะใน Slave</div>${tableHtml(r.slave.columns, c.onlySlave)}` : ''}`;
    } else head = `<div class="err">ค่าไม่ตรงกัน${r.compare.numeric ? ` — ส่วนต่าง ${r.compare.diff}` : ''}</div>`;
  } else if (r.status === 'error') head = '<div class="err">Query ทำงานผิดพลาด (ดูรายละเอียดด้านล่าง)</div>';
  return `${head}<div class="dsresgrid">${side('Master', r.master)}${side('Slave', r.slave)}</div>`;
}
function viewResult(id) {
  const q = DS.data.queries.find((x) => x.id === id), r = ((DS.data.last && DS.data.last.queries) || []).find((x) => x.id === id);
  modal(`<div class="mh">${icon('list', 20)}<h2>${esc(q.name)}</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <div class="mb">${q.sql ? `<div class="code-block" style="margin-bottom:12px">${esc(q.sql)}</div>` : ''}${resultHtml(r, q)}<div class="faint" style="margin-top:10px;font-size:12px">ผลจากการตรวจเมื่อ ${fmtDT(r && r.at)}</div></div>
    <div class="mf"><button class="btn primary" data-act="mclose">ปิด</button></div>`, 'wide');
}
function templateModal() {
  const exist = new Set(DS.data.queries.map((q) => q.name));
  const groups = [...new Set(DS_TEMPLATES.map((t) => t.group))];
  const m = modal(`<div class="mh">${icon('wand', 20)}<h2>เพิ่ม Query จากตัวอย่าง</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <div class="mb"><div class="ok-msg" style="background:var(--warn-soft);border-color:#f7d79a;color:#8a5a00">ชื่อตาราง/ฟิลด์อ้างอิงโครงสร้างมาตรฐานของ HOSxP — กรุณากด “ทดสอบ” ในหน้าแก้ไขหลังเพิ่ม เพื่อตรวจกับระบบจริงของโรงพยาบาล</div>
      ${groups.map((g) => `<div class="sub-h" style="margin-top:12px">${esc(g)}</div>${DS_TEMPLATES.map((t, i) => t.group !== g ? '' : `<label class="tplrow ${exist.has(t.name) ? 'has' : ''}"><input type="checkbox" value="${i}" ${exist.has(t.name) ? 'disabled' : ''}>
        <div><b>${esc(t.name)}</b>${exist.has(t.name) ? ' <span class="pill muted">มีแล้ว</span>' : ''}<div class="mono faint" style="font-size:11.5px;white-space:pre-wrap">${esc(t.sql)}</div>${t.description ? `<div class="faint" style="font-size:12px">${esc(t.description)}</div>` : ''}</div></label>`).join('')}`).join('')}</div>
    <div class="mf"><button class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" id="tplAdd">${icon('plus', 16)} เพิ่มรายการที่เลือก</button></div>`, 'wide');
  m.querySelector('#tplAdd').addEventListener('click', async () => {
    const sel = $$('.tplrow input:checked', m).map((x) => DS_TEMPLATES[+x.value]);
    if (!sel.length) { toast('กรุณาเลือกอย่างน้อย 1 รายการ', 'warn'); return; }
    let ok = 0;
    for (const t of sel) { try { await api('POST', '/api/dbsync/queries', { target: 'both', everyMin: 0, tolerance: 0, ...t }); ok++; } catch (e) { toast(`${t.name}: ${e.message}`, 'bad'); } }
    closeModal(); toast(`เพิ่ม ${ok} Query แล้ว — กำลังรันเพื่อเปรียบเทียบ`, 'ok'); setTimeout(() => loadDs(true), 2000);
  });
}

async function reportModal(btn) {
  const old = btn.innerHTML; btn.disabled = true; btn.innerHTML = `${icon('refresh', 15, 'spin')} กำลังรัน Query...`;
  try {
    const r = await api('POST', '/api/dbsync/report', { dry: true });
    const m = modal(`<div class="mh">${icon('bell', 20)}<h2>ตัวอย่างรายงานที่จะส่ง</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
      <div class="mb"><div class="${r.allOk ? 'ok-msg' : 'err'}">${r.allOk ? 'ข้อมูล Master และ Slave ตรงกันทุกรายการ' : 'พบรายการที่ไม่ตรงกันหรือ Replication มีปัญหา'}</div>
        <pre class="code-block" style="max-height:52vh;overflow:auto;color:var(--text)">${esc(r.preview)}</pre>
        <div class="faint" style="font-size:12px">ช่องทางหมอพร้อมแบบ Flex จะแสดงเป็นการ์ดตาราง · ช่องทางอื่นจะได้ข้อความตามตัวอย่างนี้</div><div id="rpRes"></div></div>
      <div class="mf"><button class="btn" data-act="mclose">ปิด</button><button class="btn primary" id="rpSend">${icon('bell', 16)} ส่งไปยังช่องทางแจ้งเตือน</button></div>`, 'wide');
    m.querySelector('#rpSend').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try {
        const x = await api('POST', '/api/dbsync/report', { dry: false });
        $('#rpRes').innerHTML = x.results.map((y) => `<div class="${y.ok ? 'ok-msg' : 'err'}">${esc(y.channel)}: ${y.ok ? `ส่งสำเร็จ (HTTP ${y.status})` : `ไม่สำเร็จ ${y.status || ''} ${esc(y.info)}`}</div>`).join('');
      } catch (ex) { $('#rpRes').innerHTML = `<div class="err">${esc(ex.message)}</div>`; } finally { b.disabled = false; }
    });
  } finally { if (document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = old; } }
}

/* ---------------------------------------------------------------- events */
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el || !el.dataset.act.startsWith('ds')) return;
  const a = el.dataset.act;
  try {
    if (a === 'dscfg') cfgModal();
    else if (a === 'dstest') testSideUi(el.dataset.side, el);
    else if (a === 'dsrun' || a === 'dstables') {
      el.disabled = true; const old = el.innerHTML; el.innerHTML = `${icon('refresh', 15, 'spin')} กำลังตรวจ...`;
      try { DS.data = await api('POST', a === 'dsrun' ? '/api/dbsync/run' : '/api/dbsync/tables'); renderDs(); loadDsHist(); toast('ตรวจสอบเรียบร้อย', 'ok'); }
      finally { if (document.body.contains(el)) { el.disabled = false; el.innerHTML = old; } }
    } else if (a === 'dsrange') { DS.range = +el.dataset.h; store.set('nms_ds_range', DS.range); $$('.dsrange button').forEach((b) => b.classList.toggle('on', b === el)); loadDsHist(); }
    else if (a === 'dsqadd') queryModal(null);
    else if (a === 'dsqedit') queryModal(DS.data.queries.find((x) => x.id === el.dataset.id));
    else if (a === 'dsqview') viewResult(el.dataset.id);
    else if (a === 'dstpl') templateModal();
    else if (a === 'dsreport') reportModal(el);
    else if (a === 'dsqdel') {
      const q = DS.data.queries.find((x) => x.id === el.dataset.id);
      if (await confirmBox('ลบ Query', `ต้องการลบ <b>${esc(q.name)}</b> หรือไม่?`, 'ลบ')) { await api('DELETE', `/api/dbsync/queries/${q.id}`); toast('ลบแล้ว', 'ok'); loadDs(true); }
    } else if (a === 'dsqtest') {
      const f = $('#dsQ'), out = $('#dsQRes');
      el.disabled = true; out.innerHTML = `<div class="empty">${icon('refresh', 20, 'spin')} กำลังรันบน Master และ Slave...</div>`;
      try { const { result } = await api('POST', '/api/dbsync/query-test', qBody(f)); out.innerHTML = resultHtml(result); }
      catch (ex) { out.innerHTML = `<div class="err">${esc(ex.message)}</div>`; } finally { el.disabled = false; }
    } else if (a === 'dstf') { DS.onlyDiff = el.dataset.v === '1'; renderDs(); }
  } catch (ex) { toast(ex.message, 'bad'); }
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'dsTq') { DS.tq = e.target.value; clearTimeout(DS.tqT); DS.tqT = setTimeout(() => { const pos = e.target.selectionStart; renderDs(); const i = $('#dsTq'); if (i) { i.focus(); i.setSelectionRange(pos, pos); } }, 250); }
});
