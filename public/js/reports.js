'use strict';
/* ============================================================
   รายงาน / สถิติ (ข้อมูลจาก MySQL) + หน้าตั้งค่า MySQL
   ใช้ตัวแปร/ฟังก์ชันร่วมจาก common.js และ app.js
   ============================================================ */
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const TH_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const TH_WD = ['จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์']; // WEEKDAY(): 0 = จันทร์
const C = { loss: '#f0425f', lossSoft: '#f7a1b0', prev: '#94a3b8', lat: '#0e9b87', avail: '#1aa3e8', event: '#9f1239' };
const p2 = (n) => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

const R = Object.assign({ mode: 'month', day: today(), device: '', type: '', compare: true }, store.get('nms_rep', {}));
R.data = null; R.loading = false;
const saveR = () => store.set('nms_rep', { mode: R.mode, day: R.day, device: R.device, type: R.type, compare: R.compare });

/* ---------------------------------------------------------------- format */
const fNum = (v) => (v == null ? '—' : Number(v).toLocaleString('th-TH'));
const fPct = (v, d = 2) => (v == null ? '—' : `${v.toFixed(d)}%`);
const fMs = (v) => (v == null ? '—' : `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)} ms`);
function fDur(sec) {
  if (sec == null) return '—';
  sec = Math.round(sec);
  if (sec < 60) return `${sec} วินาที`;
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return [d && `${d} วัน`, h && `${h} ชม.`, m && `${m} นาที`].filter(Boolean).join(' ') || '0 นาที';
}
const fDT = (s) => { if (!s) return '—'; const d = new Date(String(s).replace(' ', 'T')); return `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${p2(d.getHours())}:${p2(d.getMinutes())}`; };
function periodValue() {
  const [y, m] = R.day.split('-');
  return R.mode === 'day' ? R.day : R.mode === 'month' ? `${y}-${m}` : y;
}
function shiftPeriod(dir) {
  const [y, m, d] = R.day.split('-').map(Number);
  const dt = R.mode === 'day' ? new Date(y, m - 1, d + dir) : R.mode === 'month' ? new Date(y, m - 1 + dir, 1) : new Date(y + dir, 0, 1);
  R.day = `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())}`;
}
function slotLabel(i, d = R.data) {
  if (!d) return '';
  if (d.mode === 'day') { const s = d.slots[i], e = d.slots[i + 1] || '24:00'; return `${s}–${e}`; }
  if (d.mode === 'year') return TH_MONTHS_FULL[i];
  const [y, m] = d.start.split('-').map(Number);
  const wd = new Date(y, m - 1, i + 1).getDay();
  return `${['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'][wd]} ${i + 1} ${TH_MONTHS[m - 1]}`;
}

/* ---------------------------------------------------------------- tooltip */
function tip(html, e) {
  let t = $('#repTip');
  if (!t) { t = document.createElement('div'); t.id = 'repTip'; t.className = 'rtip'; document.body.appendChild(t); }
  if (!html) { t.style.display = 'none'; return; }
  t.innerHTML = html; t.style.display = 'block';
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = e.clientX + 14, y = e.clientY + 14;
  if (x + w > innerWidth - 8) x = e.clientX - w - 14;
  if (y + h > innerHeight - 8) y = e.clientY - h - 14;
  t.style.left = Math.max(8, x) + 'px'; t.style.top = Math.max(8, y) + 'px';
}

/* ---------------------------------------------------------------- chart */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
/** กราฟแท่ง + เส้น  opts: {labels, bars:[{values,color,name}], lines:[{values,color,dashed,name}], yFmt, yMin, yMax, height, tooltip(i)} */
function drawChart(host, o) {
  const W = Math.max(280, host.clientWidth), H = o.height || 240;
  const pl = 52, pr = 14, pt = 14, pb = 28, iw = W - pl - pr, ih = H - pt - pb;
  const n = o.labels.length;
  const stackTot = o.stack ? o.labels.map((_, i) => (o.bars || []).reduce((a, s) => a + (s.values[i] || 0), 0)) : [];
  const all = [...(o.bars || []), ...(o.lines || [])].flatMap((s) => s.values).concat(stackTot).filter((v) => v != null);
  const yMin = o.yMin != null ? o.yMin : 0;
  const yMax = o.yMax != null ? o.yMax : niceMax(Math.max(...all, 0) * 1.08 || 1);
  const y = (v) => pt + ih - ((v - yMin) / (yMax - yMin || 1)) * ih;
  const step = iw / n, x = (i) => pl + step * i + step / 2;
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = yMin + ((yMax - yMin) * k) / 4, yy = y(v);
    g += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" class="gl"/><text x="${pl - 8}" y="${yy + 4}" class="ytick">${esc(o.yFmt ? o.yFmt(v) : v)}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / Math.max(4, Math.floor(iw / 64))));
  o.labels.forEach((l, i) => { if (i % every === 0) g += `<text x="${x(i)}" y="${H - 8}" class="xtick">${esc(l)}</text>`; });
  const base = o.labels.map(() => 0);
  (o.bars || []).forEach((s) => {
    const bw = Math.max(1, step * 0.72);
    if (o.stack) {   // แท่งซ้อน (stacked)
      s.values.forEach((v, i) => { if (!v) return; const y1 = y(base[i] + v), y0 = y(base[i]); g += `<rect x="${x(i) - bw / 2}" y="${y1}" width="${bw}" height="${Math.max(1, y0 - y1)}" fill="${s.color}"/>`; base[i] += v; });
      return;
    }
    s.values.forEach((v, i) => {
      if (v == null || v <= yMin) return;
      const yy = y(Math.min(v, yMax));
      g += `<rect x="${x(i) - bw / 2}" y="${yy}" width="${bw}" height="${Math.max(1, pt + ih - yy)}" rx="${bw > 6 ? 2 : 0}" fill="${(s.colorAt && s.colorAt(i)) || s.color}"/>`;
    });
  });
  (o.lines || []).forEach((s) => {
    let d = '', pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)} ${y(Math.min(Math.max(v, yMin), yMax)).toFixed(1)}`; pen = true; });
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dashed ? 'stroke-dasharray="5 4"' : ''} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (n <= 40) s.values.forEach((v, i) => { if (v != null && !s.dashed) g += `<circle cx="${x(i)}" cy="${y(Math.min(Math.max(v, yMin), yMax))}" r="2.6" fill="${s.color}"/>`; });
  });
  g += `<line class="hoverline" x1="0" x2="0" y1="${pt}" y2="${pt + ih}" style="display:none"/>`;
  host.innerHTML = `<svg width="${W}" height="${H}" class="rchart" role="img" aria-label="${esc(o.title || '')}">${g}<rect class="hit" x="${pl}" y="${pt}" width="${iw}" height="${ih}" fill="transparent"/></svg>`;
  const svg = host.firstChild, hl = svg.querySelector('.hoverline');
  svg.querySelector('.hit').addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect(), i = Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left - pl) / step)));
    hl.setAttribute('x1', x(i)); hl.setAttribute('x2', x(i)); hl.style.display = '';
    tip(o.tooltip(i), e);
  });
  svg.querySelector('.hit').addEventListener('mouseleave', () => { hl.style.display = 'none'; tip(null); });
}
function legend(items) {
  return `<div class="rlegend">${items.map(([c, l, dashed]) => `<span><i style="background:${dashed ? 'transparent' : c};border-top:${dashed ? `2px dashed ${c}` : '0'};${dashed ? 'height:0;width:16px' : ''}"></i>${esc(l)}</span>`).join('')}</div>`;
}

/* ---------------------------------------------------------------- heatmap */
function heatColor(c) {
  if (!c || !c.checks) return 'var(--hm-empty)';
  const loss = (100 * c.lost) / c.checks;
  if (loss === 0) return 'var(--hm-zero)';
  const t = Math.min(1, Math.log10(1 + loss) / Math.log10(26));          // 0.1% ≈ จางมาก, 1% ≈ เหลือง, 5% ≈ ส้ม, ≥25% ≈ แดงเข้ม
  const stops = [[255, 246, 214], [249, 168, 77], [240, 66, 95], [127, 29, 54]];
  const seg = Math.min(2, Math.floor(t * 3)), f = t * 3 - seg, a = stops[seg], b = stops[seg + 1];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(',')})`;
}
function heatmap(rows, rowTitle, id) {
  if (!rows.length) return `<div class="empty">ไม่มีข้อมูลในช่วงนี้</div>`;
  return `<div class="hm" id="${id}"><div class="hm-row hm-head"><div class="hm-lab">${esc(rowTitle)}</div>${Array.from({ length: 24 }, (_, h) => `<div class="hm-h">${h % 3 === 0 ? p2(h) : ''}</div>`).join('')}</div>
    ${rows.map((r, ri) => `<div class="hm-row"><div class="hm-lab" title="${esc(r.label)}">${esc(r.label)}</div>${r.cells.map((c, h) =>
    `<div class="hm-c${c.checks && c.down / c.checks >= 0.005 ? ' dn' : ''}" style="background:${heatColor(c)}" data-r="${ri}" data-h="${h}"></div>`).join('')}</div>`).join('')}</div>
    <div class="hm-legend"><span>ไม่มีข้อมูล</span><i style="background:var(--hm-empty)"></i><span>ไม่มี loss</span><i style="background:var(--hm-zero)"></i>
      <span>loss น้อย</span><i class="grad"></i><span>loss สูง</span><span class="faint" style="margin-left:10px">▢ ขอบแดง = มีช่วงที่ล่ม (offline) อย่างมีนัยสำคัญ</span></div>`;
}
function bindHeat(id, rows, labelFn) {
  const el = document.getElementById(id); if (!el) return;
  el.addEventListener('mousemove', (e) => {
    const c = e.target.closest('.hm-c'); if (!c) { tip(null); return; }
    const r = rows[+c.dataset.r], h = +c.dataset.h, x = r.cells[h];
    tip(`<b>${esc(labelFn(r))} · ${p2(h)}:00–${p2(h + 1)}:00</b>
      ${x.checks ? `<div>Packet loss: <b style="color:${C.loss}">${fPct((100 * x.lost) / x.checks)}</b> (${fNum(x.lost)}/${fNum(x.checks)})</div>
      <div>สถานะล่ม: ${x.down ? `<b style="color:${C.loss}">${fNum(x.down)} ครั้งตรวจ</b>` : 'ไม่มี'}</div>` : '<div class="faint">ไม่มีข้อมูล</div>'}`, e);
  });
  el.addEventListener('mouseleave', () => tip(null));
}

/* ---------------------------------------------------------------- page */
function vReports() {
  const years = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 6; y--) years.push(y);
  const [cy, cm] = R.day.split('-').map(Number);
  const D = [...devs()].sort((a, b) => a.name.localeCompare(b.name, 'th'));
  $('#view').innerHTML = `
  <div class="card panel rbar">
    <div class="seg rmode">${[['day', 'รายวัน'], ['month', 'รายเดือน'], ['year', 'รายปี']].map(([k, l]) => `<button data-act="rmode" data-m="${k}" class="${R.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="rperiod">
      <button class="ibtn" data-act="rshift" data-d="-1" title="ช่วงก่อนหน้า">${icon('chevl', 17)}</button>
      ${R.mode === 'day' ? `<input type="date" class="inp" id="rDate" value="${R.day}" max="${today()}">`
    : R.mode === 'month' ? `<select class="sel" id="rMonth">${TH_MONTHS_FULL.map((m, i) => `<option value="${i + 1}" ${i + 1 === cm ? 'selected' : ''}>${m}</option>`).join('')}</select>
           <select class="sel" id="rYear">${years.map((y) => `<option value="${y}" ${y === cy ? 'selected' : ''}>${y + 543}</option>`).join('')}</select>`
      : `<select class="sel" id="rYear">${years.map((y) => `<option value="${y}" ${y === cy ? 'selected' : ''}>พ.ศ. ${y + 543}</option>`).join('')}</select>`}
      <button class="ibtn" data-act="rshift" data-d="1" title="ช่วงถัดไป">${icon('chevr', 17)}</button>
      <button class="btn sm" data-act="rtoday">ปัจจุบัน</button>
    </div>
    <select class="sel" id="rDev"><option value="">อุปกรณ์ทั้งหมด</option>${D.map((d) => `<option value="${d.id}" ${String(R.device) === String(d.id) ? 'selected' : ''}>${esc(d.name)} (${esc(d.ip)})</option>`).join('')}</select>
    <select class="sel" id="rType" ${R.device ? 'disabled' : ''}><option value="">ทุกประเภท</option>${Object.entries(TYPE_INFO).map(([k, v]) => `<option value="${k}" ${R.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" id="rCmp" ${R.compare ? 'checked' : ''}> เปรียบเทียบช่วงก่อนหน้า</label>
    <span style="flex:1"></span>
    <button class="btn sm" data-act="rload" title="โหลดใหม่">${icon('refresh', 15)}</button>
    <button class="btn sm" data-act="rcsv">${icon('download', 15)} CSV</button>
  </div>
  <div id="repBody"><div class="card panel"><div class="empty">${icon('refresh', 24, 'spin')}<div>กำลังโหลดรายงาน...</div></div></div></div>`;
  const re = () => { saveR(); loadReport(); };
  const dt = $('#rDate'); if (dt) dt.addEventListener('change', () => { if (dt.value) { R.day = dt.value; re(); } });
  const mm = $('#rMonth'), yy = $('#rYear');
  if (mm) mm.addEventListener('change', () => { R.day = `${yy.value}-${p2(mm.value)}-01`; re(); });
  if (yy) yy.addEventListener('change', () => { R.day = `${yy.value}-${mm ? p2(mm.value) : '01'}-01`; re(); });
  $('#rDev').addEventListener('change', (e) => { R.device = e.target.value; $('#rType').disabled = !!R.device; re(); });
  $('#rType').addEventListener('change', (e) => { R.type = e.target.value; re(); });
  $('#rCmp').addEventListener('change', (e) => { R.compare = e.target.checked; saveR(); renderReport(); });
  loadReport();
}
let repSeq = 0;
async function loadReport() {
  const body = $('#repBody'); if (!body) return;
  const seq = ++repSeq;
  body.classList.add('loading');
  try {
    const q = new URLSearchParams({ mode: R.mode, date: periodValue() });
    if (R.device) q.set('device', R.device); else if (R.type) q.set('type', R.type);
    const d = await api('GET', '/api/reports?' + q);
    if (seq !== repSeq) return;
    R.data = d; renderReport();
  } catch (e) { body.innerHTML = `<div class="card panel"><div class="err">${esc(e.message)}</div></div>`; }
  finally { body.classList.remove('loading'); }
}
function delta(cur, prev, { goodDown = true, pts = false, fmt } = {}) {
  if (!R.compare || cur == null || prev == null) return '';
  const diff = cur - prev;
  if (Math.abs(diff) < 1e-9) return `<span class="dl same">เท่าเดิม</span>`;
  const good = goodDown ? diff < 0 : diff > 0;
  const txt = pts ? `${diff > 0 ? '+' : ''}${diff.toFixed(2)} จุด` : prev ? `${diff > 0 ? '+' : ''}${((diff / prev) * 100).toFixed(0)}%` : (fmt ? `${diff > 0 ? '+' : ''}${fmt(diff)}` : '');
  return `<span class="dl ${good ? 'good' : 'bad'}">${diff > 0 ? '▲' : '▼'} ${txt}</span>`;
}
function insights(d) {
  const out = [], k = d.kpi.current, kp = d.kpi.previous;
  if (!k.checks) return out;
  // ชั่วโมงที่มีปัญหามากที่สุด
  const hours = Array.from({ length: 24 }, () => ({ checks: 0, lost: 0, down: 0 }));
  d.week.forEach((w) => w.forEach((c, h) => { hours[h].checks += c.checks; hours[h].lost += c.lost; hours[h].down += c.down; }));
  const hBest = hours.map((c, h) => ({ h, r: c.checks ? c.lost / c.checks : 0, ...c })).sort((a, b) => b.r - a.r)[0];
  if (hBest && hBest.lost) out.push(['clock', `ช่วงเวลาที่มีปัญหามากที่สุด <b>${p2(hBest.h)}:00–${p2(hBest.h + 1)}:00 น.</b> (packet loss ${fPct(hBest.r * 100)})`]);
  if (d.mode !== 'day') {
    const unit = d.mode === 'month' ? 'วัน' : 'เดือน', rows = d.heat.filter((r) => r.checks);
    // 1) การล่มที่เกิดซ้ำในชั่วโมงเดียวกัน (นับจำนวนวัน/เดือนที่เกิด)
    let downH = null;
    if (rows.length >= 3) {
      const cnt = Array.from({ length: 24 }, (_, h) => rows.filter((r) => r.cells[h].checks && r.cells[h].down / r.cells[h].checks >= 0.005).length);
      const h = cnt.indexOf(Math.max(...cnt));
      if (cnt[h] >= 3 && cnt[h] >= rows.length * 0.25) {
        downH = h;
        out.push(['alert', `<b>ล่มซ้ำเป็นประจำ</b> ช่วง <b>${p2(h)}:00–${p2(h + 1)}:00 น.</b> เกิด ${cnt[h]} ${unit} จาก ${rows.length} ${unit} — น่าจะมีงานตั้งเวลา (reboot / backup / ไฟดับตามรอบ)`]);
      }
    }
    // 2) loss สูงเกิดซ้ำ วันเดียวกันของสัปดาห์ + ชั่วโมงเดียวกัน (เฉพาะรายเดือน: นับจำนวนสัปดาห์)
    let wkFound = false;
    if (d.mode === 'month') {
      const [y, m] = d.start.split('-').map(Number), base = Math.max(1, 3 * (d.kpi.current.lossPct || 0));
      const hits = new Map();
      rows.forEach((r) => {
        const wd = (new Date(y, m - 1, Number(r.key)).getDay() + 6) % 7;
        r.cells.forEach((c, h) => {
          if (h === downH || !c.checks || (100 * c.lost) / c.checks < base) return;
          const k = `${wd}|${h}`; hits.set(k, (hits.get(k) || 0) + 1);
        });
      });
      const best = [...hits.entries()].sort((a, b) => b[1] - a[1])[0];
      if (best && best[1] >= 2) {
        const [wd, h] = best[0].split('|').map(Number);
        wkFound = true;
        out.push(['calendar', `<b>ปัญหาเกิดซ้ำทุกวัน${TH_WD[wd]}</b> ช่วง <b>${p2(h)}:00–${p2(h + 1)}:00 น.</b> (loss สูงกว่าปกติ ${best[1]} สัปดาห์) — ควรตรวจงานที่ทำตามรอบเวลา เช่น backup / update`]);
      }
    }
    if (!wkFound) {
      const cells = []; d.week.forEach((w, wi) => w.forEach((c, h) => { if (c.checks && h !== downH) cells.push({ wi, h, r: c.lost / c.checks, ...c }); }));
      const top = cells.sort((a, b) => b.r - a.r)[0];
      if (top && top.lost) out.push(['calendar', `วันและช่วงเวลาที่มี loss สูงสุด: <b>วัน${TH_WD[top.wi]} ${p2(top.h)}:00–${p2(top.h + 1)}:00 น.</b> (loss เฉลี่ย ${fPct(top.r * 100)})`]);
    }
  }
  const worst = d.current.map((s, i) => ({ i, ...s })).filter((s) => s.checks).sort((a, b) => (b.lossPct - a.lossPct) || (b.events - a.events))[0];
  if (worst && worst.lost) out.push(['chart', `${d.mode === 'day' ? 'ช่วง 5 นาที' : d.mode === 'month' ? 'วัน' : 'เดือน'}ที่แย่ที่สุด: <b>${esc(slotLabel(worst.i, d))}</b> — loss ${fPct(worst.lossPct)}${worst.events ? `, ล่ม ${worst.events} ครั้ง` : ''}`]);
  const td = d.topDevices[0];
  if (td && (td.lost || td.events)) out.push(['server', `อุปกรณ์ที่มีปัญหามากที่สุด: <b>${esc(td.name)}</b> — ล่ม ${td.events} ครั้ง, downtime ${fDur(td.downSec)}, loss ${fPct(td.lossPct)}`]);
  const longest = [...d.incidents].sort((a, b) => b.durationSec - a.durationSec)[0];
  if (longest) out.push(['alert', `เหตุการณ์ล่มนานที่สุด: <b>${esc(longest.name)}</b> ${fDur(longest.durationSec)} (เริ่ม ${fDT(longest.start)})${longest.ongoing ? ' — <b style="color:var(--bad)">ยังไม่กลับมา</b>' : ''}`]);
  if (kp.checks && k.lossPct != null && kp.lossPct != null) {
    const df = k.lossPct - kp.lossPct;
    out.push([df > 0 ? 'activity' : 'check', `เทียบกับ${esc(d.prevLabel)}: packet loss <b class="${df > 0 ? 'tbad' : 'tgood'}">${df > 0 ? 'เพิ่มขึ้น' : 'ลดลง'} ${Math.abs(df).toFixed(2)} จุด</b>, จำนวนครั้งที่ล่ม ${kp.events} → <b>${k.events}</b> ครั้ง`]);
  }
  if (!out.length) out.push(['check', 'ไม่พบปัญหาการเชื่อมต่อในช่วงนี้ 🎉']);
  return out;
}
function renderReport() {
  const body = $('#repBody'), d = R.data; if (!body || !d) return;
  if (!d.configured) {
    body.innerHTML = `<div class="card panel"><div class="empty" style="padding:50px 20px">${icon('database', 40)}
      <h2 style="color:var(--text);margin:10px 0 6px">ยังไม่ได้ตั้งค่าการเก็บ log ลง MySQL</h2>
      <p>รายงานย้อนหลังใช้ข้อมูลจากฐานข้อมูล MySQL ${can('admin') ? 'กรุณาตั้งค่าที่เมนู ตั้งค่า → ฐานข้อมูล MySQL' : 'กรุณาติดต่อผู้ดูแลระบบ'}</p>
      ${can('admin') ? `<button class="btn primary" data-act="tab" data-tab="settings" style="margin-top:12px">${icon('sliders', 16)} ไปที่หน้าตั้งค่า</button>` : ''}</div></div>`;
    return;
  }
  if (!d.connected) { body.innerHTML = `<div class="card panel"><div class="err">เชื่อมต่อ MySQL ไม่ได้: ${esc(d.error || '')}</div></div>`; return; }
  const k = d.kpi.current, kp = d.kpi.previous, cmp = R.compare;
  const devName = R.device ? (devById(+R.device) || {}).name : R.type ? TYPE_INFO[R.type]?.label : 'อุปกรณ์ทั้งหมด';
  const kpi = (lab, val, dl, sub) => `<div class="card kpi rk"><div class="h">${lab}</div><div class="v">${val}</div><div class="row">${dl || '<span></span>'}<span class="faint">${sub || ''}</span></div></div>`;
  const hmTitle = d.mode === 'day' ? 'อุปกรณ์ × ชั่วโมง (15 อันดับที่มีปัญหา)' : d.mode === 'month' ? 'วันที่ × ชั่วโมง' : 'เดือน × ชั่วโมง';
  body.innerHTML = `
    <div class="rhead"><h2>${icon('chart', 20)} รายงานการเชื่อมต่อ ${esc(d.label)}</h2>
      <span class="muted">${esc(devName || '')}${cmp ? ` · เทียบกับ <b>${esc(d.prevLabel)}</b>` : ''} · ${fNum(k.devices)} อุปกรณ์ที่มีข้อมูล</span></div>
    ${!k.checks ? `<div class="card panel"><div class="empty">${icon('database', 30)}<div>ไม่มีข้อมูลในช่วง ${esc(d.label)}</div><div class="faint">ระบบเริ่มเก็บข้อมูลหลังจากเปิดใช้งาน MySQL</div></div></div>` : `
    <section class="rkpis">
      ${kpi('Availability', fPct(k.availPct, 3), delta(k.availPct, kp.availPct, { goodDown: false, pts: true }), cmp ? `ก่อนหน้า ${fPct(kp.availPct, 3)}` : '')}
      ${kpi('Packet Loss', `<span style="color:${k.lossPct ? C.loss : 'inherit'}">${fPct(k.lossPct)}</span>`, delta(k.lossPct, kp.lossPct, { pts: true }), `${fNum(k.lost)} / ${fNum(k.checks)} ครั้ง`)}
      ${kpi('จำนวนครั้งที่ล่ม', fNum(k.events), delta(k.events, kp.events), cmp ? `ก่อนหน้า ${fNum(kp.events)}` : '')}
      ${kpi('Downtime รวม', `<span style="font-size:20px">${fDur(k.downSec)}</span>`, delta(k.downSec, kp.downSec), cmp ? `ก่อนหน้า ${fDur(kp.downSec)}` : '')}
      ${kpi('Latency เฉลี่ย', fMs(k.avgLatency), delta(k.avgLatency, kp.avgLatency), `สูงสุด ${fMs(k.maxLatency)}`)}
      ${kpi('จำนวนการตรวจ', fNum(k.checks), '', cmp ? `ก่อนหน้า ${fNum(kp.checks)}` : '')}
    </section>
    <div class="card panel rins"><div class="ph"><h3>${icon('bulb', 17)}<span class="th">สรุปจุดที่ควรสนใจ</span></h3></div>
      <ul>${insights(d).map(([ic, t]) => `<li>${icon(ic === 'clock' ? 'activity' : ic, 16)}<span>${t}</span></li>`).join('')}</ul></div>
    <div class="card panel"><div class="ph"><h3>${icon('alert', 17)}<span class="th">Packet Loss และการล่ม</span><span class="bar"></span>${d.mode === 'day' ? 'ทุก 5 นาที' : d.mode === 'month' ? 'รายวัน' : 'รายเดือน'}</h3>
      ${legend([[C.loss, `Loss % ${d.label}`], ...(cmp ? [[C.prev, `Loss % ${d.prevLabel}`, true]] : []), [C.event, 'มีการล่ม (สีเข้ม)']])}</div>
      <div class="rchart-host" id="chLoss"></div></div>
    <div class="grid g2">
      <div class="card panel"><div class="ph"><h3>${icon('activity', 17)}<span class="th">Latency เฉลี่ย</span><span class="bar"></span>ms</h3>
        ${legend([[C.lat, d.label], ...(cmp ? [[C.prev, d.prevLabel, true]] : [])])}</div><div class="rchart-host" id="chLat"></div></div>
      <div class="card panel"><div class="ph"><h3>${icon('shield', 17)}<span class="th">Availability</span><span class="bar"></span>%</h3>
        ${legend([[C.avail, d.label], ...(cmp ? [[C.prev, d.prevLabel, true]] : [])])}</div><div class="rchart-host" id="chAv"></div></div>
    </div>
    <div class="grid ${d.mode === 'day' ? '' : 'g21'}">
      <div class="card panel"><div class="ph"><h3>${icon('grid', 17)}<span class="th">แผนที่ความร้อน: ช่วงเวลาที่มีปัญหา</span><span class="bar"></span>${hmTitle}</h3></div>
        ${heatmap(d.heat, d.mode === 'day' ? 'อุปกรณ์' : d.mode === 'month' ? 'วันที่' : 'เดือน', 'hmMain')}</div>
      ${d.mode === 'day' ? '' : `<div class="card panel"><div class="ph"><h3>${icon('calendar', 17)}<span class="th">รูปแบบตามวันในสัปดาห์</span><span class="bar"></span>วัน × ชั่วโมง</h3></div>
        ${heatmap(d.week.map((cells, i) => ({ label: TH_WD[i], cells })), 'วัน', 'hmWeek')}
        <p class="faint" style="font-size:12px;margin:10px 0 0">รวมทุกสัปดาห์ในช่วง ${esc(d.label)} — ช่วยหาปัญหาที่เกิดซ้ำตามวันและเวลา</p></div>`}
    </div>
    <div class="card panel"><div class="ph"><h3>${icon('server', 17)}<span class="th">อุปกรณ์ที่มีปัญหามากที่สุด</span><span class="bar"></span>Top Problem Devices</h3></div>
      <div class="tblwrap"><table class="tbl"><thead><tr><th>#</th><th>อุปกรณ์</th><th>Loss</th><th>ครั้งที่ล่ม</th><th>Downtime</th><th>Availability</th><th>Latency เฉลี่ย / สูงสุด</th><th></th></tr></thead><tbody>
      ${d.topDevices.map((t, i) => `<tr><td class="mono faint">${i + 1}</td>
        <td><b>${esc(t.name)}</b>${t.deleted ? ' <span class="pill muted">ลบแล้ว</span>' : ''}<div class="mono faint" style="font-size:11px">${esc(maskIp(t.ip || ''))}${t.location ? ' · ' + esc(t.location) : ''}</div></td>
        <td style="min-width:150px"><div class="lbar"><i style="width:${Math.min(100, (t.lossPct || 0) * 4)}%"></i></div><span class="mono" style="color:${t.lossPct ? C.loss : 'inherit'}">${fPct(t.lossPct)}</span></td>
        <td class="mono">${t.events}</td><td>${fDur(t.downSec)}</td><td class="mono">${fPct(t.availPct, 3)}</td>
        <td class="mono">${fMs(t.avgLatency)} / ${fMs(t.maxLatency)}</td>
        <td>${t.deleted ? '' : `<button class="btn sm" data-act="rdev" data-id="${t.id}">ดูรายอุปกรณ์</button>`}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="card panel"><div class="ph"><h3>${icon('bell', 17)}<span class="th">ประวัติการล่ม</span><span class="bar"></span>Incidents</h3><span class="right">${d.incidents.length} รายการ${d.incidents.length >= 200 ? ' (ล่าสุด)' : ''}</span></div>
      ${d.incidents.length ? `<div class="tblwrap" style="max-height:420px;overflow:auto"><table class="tbl"><thead><tr><th>อุปกรณ์</th><th>เริ่มล่ม</th><th>กลับมา</th><th>ระยะเวลา</th></tr></thead><tbody>
      ${d.incidents.map((x) => `<tr><td><b>${esc(x.name)}</b> <span class="mono faint" style="font-size:11px">${esc(maskIp(x.ip || ''))}</span></td><td class="mono">${fDT(x.start)}</td>
        <td>${x.ongoing ? '<span class="pill bad">ยังล่มอยู่</span>' : `<span class="mono">${fDT(x.end)}</span>`}</td><td><b>${fDur(x.durationSec)}</b></td></tr>`).join('')}</tbody></table></div>`
    : `<div class="empty">${icon('check', 26)}<div>ไม่มีการล่มในช่วงนี้</div></div>`}</div>`}`;
  if (k.checks) drawReportCharts();
}
function drawReportCharts() {
  const d = R.data, cmp = R.compare; if (!d || !$('#chLoss')) return;
  const cur = d.current, prev = d.previous;
  const labels = d.slots;
  const tt = (i, rows) => `<b>${esc(slotLabel(i, d))}</b>${rows.join('')}`;
  const row = (c, l, v) => `<div><i class="dot" style="background:${c}"></i>${l}: <b>${v}</b></div>`;
  const pv = (i) => (cmp && prev[i] ? prev[i] : null);
  drawChart($('#chLoss'), {
    title: 'Packet loss', labels, yFmt: (v) => `${+v.toFixed(2)}%`, height: 260,
    bars: [{ values: cur.map((s) => (s.checks ? s.lossPct : null)), color: C.lossSoft, colorAt: (i) => (cur[i].events || cur[i].down ? C.loss : C.lossSoft) }],
    lines: cmp ? [{ values: prev.map((s) => (s.checks ? s.lossPct : null)), color: C.prev, dashed: true }] : [],
    tooltip: (i) => tt(i, [row(C.loss, 'Packet loss', fPct(cur[i].lossPct)), row(C.event, 'ล่ม', `${cur[i].events} ครั้ง · ${fDur(cur[i].downSec)}`),
      row(C.loss, 'ไม่ตอบสนอง', `${fNum(cur[i].lost)} / ${fNum(cur[i].checks)}`),
      ...(pv(i) ? [`<hr>`, row(C.prev, `${d.mode === 'day' ? 'เมื่อวาน' : 'ช่วงก่อนหน้า'}`, `${fPct(pv(i).lossPct)} · ล่ม ${pv(i).events} ครั้ง`)] : [])]),
  });
  drawChart($('#chLat'), {
    title: 'Latency', labels, yFmt: (v) => `${+v.toFixed(1)}`,
    lines: [...(cmp ? [{ values: prev.map((s) => s.avgLatency), color: C.prev, dashed: true }] : []), { values: cur.map((s) => s.avgLatency), color: C.lat }],
    tooltip: (i) => tt(i, [row(C.lat, 'เฉลี่ย', fMs(cur[i].avgLatency)), row(C.lat, 'สูงสุด', fMs(cur[i].maxLatency)), ...(pv(i) ? [row(C.prev, 'ช่วงก่อนหน้า', fMs(pv(i).avgLatency))] : [])]),
  });
  const avs = [...cur, ...(cmp ? prev : [])].map((s) => s.availPct).filter((v) => v != null);
  const lo = avs.length ? Math.min(...avs) : 99;
  drawChart($('#chAv'), {
    title: 'Availability', labels, yFmt: (v) => `${+v.toFixed(2)}%`, yMin: lo >= 99.5 ? 99 : lo >= 95 ? 95 : Math.max(0, Math.floor(lo / 10) * 10), yMax: 100,
    lines: [...(cmp ? [{ values: prev.map((s) => s.availPct), color: C.prev, dashed: true }] : []), { values: cur.map((s) => s.availPct), color: C.avail }],
    tooltip: (i) => tt(i, [row(C.avail, 'Availability', fPct(cur[i].availPct, 3)), ...(pv(i) ? [row(C.prev, 'ช่วงก่อนหน้า', fPct(pv(i).availPct, 3))] : [])]),
  });
  bindHeat('hmMain', d.heat, (r) => (d.mode === 'day' ? r.label : d.mode === 'month' ? slotLabel(+r.key - 1, d) : TH_MONTHS_FULL[+r.key - 1]));
  bindHeat('hmWeek', d.week.map((cells, i) => ({ label: TH_WD[i], cells })), (r) => `วัน${r.label}`);
}
let rsz;
window.addEventListener('resize', () => { clearTimeout(rsz); rsz = setTimeout(() => { if (S.tab === 'reports') drawReportCharts(); }, 200); });

function reportCsv() {
  const d = R.data; if (!d || !d.connected) return;
  const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const L = [];
  L.push(`รายงาน,${q(d.label)}`, `ช่วงเวลา,${d.start},${d.end}`, '');
  L.push('ช่วง,จำนวนตรวจ,ไม่ตอบสนอง,loss %,ครั้งที่ล่ม,downtime (วินาที),availability %,latency เฉลี่ย (ms)');
  d.current.forEach((s, i) => L.push([slotLabel(i, d), s.checks, s.lost, s.lossPct?.toFixed(3), s.events, s.downSec, s.availPct?.toFixed(3), s.avgLatency?.toFixed(2)].map(q).join(',')));
  L.push('', 'อุปกรณ์,IP,ตำแหน่ง,จำนวนตรวจ,ไม่ตอบสนอง,loss %,ครั้งที่ล่ม,downtime (วินาที),availability %,latency เฉลี่ย,latency สูงสุด');
  d.topDevices.forEach((t) => L.push([t.name, t.ip, t.location, t.checks, t.lost, t.lossPct?.toFixed(3), t.events, t.downSec, t.availPct?.toFixed(3), t.avgLatency?.toFixed(2), t.maxLatency].map(q).join(',')));
  L.push('', 'อุปกรณ์,IP,เริ่มล่ม,กลับมา,ระยะเวลา (วินาที)');
  d.incidents.forEach((x) => L.push([x.name, x.ip, x.start, x.end || 'ยังล่มอยู่', x.durationSec].map(q).join(',')));
  const blob = new Blob(['﻿' + L.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `smart-topology-report-${periodValue()}.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------------------------------------------------------------- MySQL settings */
let MY = null;
async function loadMysql() {
  try { MY = await api('GET', '/api/mysql'); renderMysql(); } catch (e) { const b = $('#mysqlBox'); if (b) b.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function fBytes(b) { return b > 1073741824 ? `${(b / 1073741824).toFixed(2)} GB` : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`; }
function renderMysql(msg) {
  const box = $('#mysqlBox'); if (!box || !MY) return;
  const c = MY.config, s = MY.status;
  const iv = S.state?.settings?.intervalSec || 10, nd = devs().length || 1;
  const rawPerDay = Math.round((nd * 86400) / iv);
  const badge = !s.driver ? '<span class="pill bad">ยังไม่ได้ติดตั้ง mysql2</span>'
    : !c.enabled ? '<span class="pill muted">ปิดอยู่</span>'
      : s.connected ? `<span class="pill ok"><span class="sdot c-ok"></span>เชื่อมต่อแล้ว</span>` : '<span class="pill bad"><span class="sdot c-bad"></span>เชื่อมต่อไม่ได้</span>';
  const f = (name, label, val, o = {}) => `<div class="${o.full ? 'full' : ''}"><label>${label}${o.req ? ' <span class="req">*</span>' : ''}</label>
    <input class="inp ${o.mono ? 'mono' : ''}" name="${name}" value="${esc(val)}" type="${o.type || 'text'}" ${o.min != null ? `min="${o.min}"` : ''} placeholder="${esc(o.ph || '')}" autocomplete="${o.ac || 'off'}" spellcheck="false">
    ${o.hint ? `<div class="hint">${o.hint}</div>` : ''}</div>`;
  box.innerHTML = `
    <div class="ph"><h3>${icon('database', 17)}<span class="th">ฐานข้อมูล MySQL สำหรับเก็บ Log</span><span class="bar"></span>Log Storage</h3>
      <span class="right" style="text-transform:none">${badge}</span></div>
    ${msg ? `<div class="${msg.ok ? 'ok-msg' : 'err'}">${msg.html}</div>` : ''}
    ${s.lastError && c.enabled ? `<div class="err">ข้อผิดพลาดล่าสุด: ${esc(s.lastError)}</div>` : ''}
    <div class="nfgrid">
      <form id="myForm" class="form" autocomplete="off">
        <div class="full" style="display:flex;align-items:center;gap:10px"><label class="switch"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}><span></span></label>
          <b>เปิดการบันทึก log ลง MySQL</b></div>
        ${f('host', 'Host / IP เครื่องฐานข้อมูล', c.host, { req: true, mono: true, ph: 'เช่น 10.0.0.20' })}
        ${f('port', 'Port', c.port, { mono: true, type: 'number', min: 1 })}
        ${f('database', 'ชื่อฐานข้อมูล', c.database, { req: true, mono: true, hint: 'a-z, 0-9, _ เท่านั้น' })}
        ${f('user', 'ชื่อผู้ใช้ MySQL', c.user, { req: true, mono: true, ph: 'เช่น nms' })}
        ${f('password', 'รหัสผ่าน', c.password, { type: 'password', ac: 'new-password', hint: c.password ? 'ปล่อยไว้ตามเดิมหากไม่ต้องการเปลี่ยน' : '' })}
        <div style="display:flex;align-items:flex-end;padding-bottom:10px"><label class="check"><input type="checkbox" name="ssl" ${c.ssl ? 'checked' : ''}> เชื่อมต่อแบบ SSL/TLS</label></div>
        <div class="full sub-h" style="margin:6px 0 0">ระยะเวลาเก็บข้อมูล (0 = เก็บตลอด)</div>
        <div><label class="check" style="margin-bottom:6px"><input type="checkbox" name="rawLog" ${c.rawLog ? 'checked' : ''}> เก็บ log ดิบทุกครั้งที่ตรวจ</label>
          <input class="inp" type="number" min="0" name="rawDays" value="${c.rawDays}"><div class="hint">วัน · ประมาณ ${fNum(rawPerDay)} แถว/วัน (~${fBytes(rawPerDay * 110)})</div></div>
        <div><label>สถิติราย 5 นาที (วัน)</label><input class="inp" type="number" min="0" name="statDays" value="${c.statDays}"><div class="hint">ใช้กราฟรายวัน · ~${fNum(nd * 288)} แถว/วัน</div></div>
        <div><label>สถิติรายชั่วโมง + เหตุการณ์ (วัน)</label><input class="inp" type="number" min="0" name="hourDays" value="${c.hourDays}"><div class="hint">ใช้กราฟรายเดือน/ปี · ~${fNum(nd * 24 * 365)} แถว/ปี</div></div>
        <div class="full" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
          <button type="button" class="btn" data-act="mytest">${icon('zap', 15)} ทดสอบการเชื่อมต่อ</button>
          <button type="button" class="btn" data-act="myinit">${icon('database', 15)} สร้างฐานข้อมูลและตาราง</button>
          <button type="submit" class="btn primary">${icon('check', 15)} บันทึก</button></div>
      </form>
      <div>
        <div class="sub-h">สถานะการบันทึก</div>
        <div class="kv">
          <div><span>MySQL Server</span><span class="mono">${esc(s.version || '—')}</span></div>
          <div><span>บันทึกล่าสุด</span><span>${s.lastFlushAt ? fmtDT(s.lastFlushAt) : '—'}</span></div>
          <div><span>เขียนแล้ว (ตั้งแต่เปิดโปรแกรม)</span><span class="mono">raw ${fNum(s.written.raw)} · stats ${fNum(s.written.stats)} · events ${fNum(s.written.events)}</span></div>
          <div><span>ค้างในคิว (รอเขียน)</span><span class="mono" style="color:${s.queue.raw > 5000 ? 'var(--bad)' : 'inherit'}">raw ${fNum(s.queue.raw)} · stats ${fNum(s.queue.stats)} · events ${fNum(s.queue.events)}</span></div>
          <div><span>ลบข้อมูลเก่าล่าสุด</span><span>${s.purgedAt ? fmtDT(s.purgedAt) : 'ทุกวันหลังตี 2'}</span></div>
        </div>
        ${s.sizes.length ? `<div class="tblwrap" style="margin-top:10px"><table class="tbl"><thead><tr><th>ตาราง</th><th style="text-align:right">แถว (ประมาณ)</th><th style="text-align:right">ขนาด</th></tr></thead><tbody>
          ${s.sizes.map((t) => `<tr><td class="mono">${esc(t.name)}</td><td class="mono" style="text-align:right">${fNum(t.rows)}</td><td class="mono" style="text-align:right">${fBytes(t.bytes)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        <div class="sub-h" style="margin-top:14px">สร้างผู้ใช้ MySQL สำหรับระบบ (รันบนเครื่อง MySQL ด้วยสิทธิ์ root)</div>
        <div class="code-block" style="user-select:all">CREATE USER '${esc(c.user || 'nms')}'@'%' IDENTIFIED BY 'ตั้งรหัสผ่าน';
GRANT ALL PRIVILEGES ON ${esc(c.database || 'smart_topology')}.* TO '${esc(c.user || 'nms')}'@'%';
FLUSH PRIVILEGES;</div>
        <div class="hint">แนะนำเปลี่ยน '%' เป็น IP ของเครื่อง Smart Topology เพื่อความปลอดภัย</div>
      </div>
    </div>`;
  $('#myForm').addEventListener('submit', async (e) => { e.preventDefault(); await mysqlAction('save'); });
}
function mysqlForm() {
  const f = $('#myForm'), o = Object.fromEntries(new FormData(f));
  ['enabled', 'ssl', 'rawLog'].forEach((k) => { o[k] = f[k].checked; });
  return o;
}
async function mysqlAction(kind, btn) {
  const body = mysqlForm();
  const old = btn && btn.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = `${icon('refresh', 15, 'spin')} กำลังดำเนินการ...`; }
  try {
    if (kind === 'save') {
      MY = await api('PUT', '/api/mysql', body);
      renderMysql({ ok: !MY.config.enabled || MY.status.connected, html: !MY.config.enabled ? 'บันทึกแล้ว (ปิดการเก็บ log)' : MY.status.connected ? 'บันทึกแล้ว — ระบบเริ่มเก็บ log ลง MySQL' : `บันทึกแล้ว แต่ยังเชื่อมต่อไม่ได้: ${esc(MY.status.lastError)}` });
      toast('บันทึกการตั้งค่า MySQL แล้ว', 'ok');
      return;
    }
    const r = await api('POST', `/api/mysql/${kind}`, body);
    if (!r.ok) { renderMysql({ ok: false, html: esc(r.error) }); return; }
    if (kind === 'test') {
      renderMysql({ ok: true, html: `เชื่อมต่อสำเร็จ — ${esc(r.version)} (ผู้ใช้ ${esc(r.user)})<br>${r.dbExists ? `พบฐานข้อมูล ${esc(body.database)}` : `ยังไม่มีฐานข้อมูล ${esc(body.database)}`}${r.missing.length ? ` · <b>ยังไม่มีตาราง: ${r.missing.map(esc).join(', ')}</b> — กด “สร้างฐานข้อมูลและตาราง”` : ' · ตารางครบถ้วน ✓'}` });
    } else {
      renderMysql({ ok: true, html: `สร้างเรียบร้อย:<br>${r.steps.map(esc).join('<br>')}<br><b>กด “บันทึก” เพื่อเริ่มเก็บ log</b>` });
    }
    // คงค่าที่กรอกไว้ (ยังไม่ได้บันทึก)
    const f = $('#myForm'); Object.entries(body).forEach(([k, v]) => { if (!f[k]) return; if (f[k].type === 'checkbox') f[k].checked = !!v; else f[k].value = v; });
  } catch (e) { toast(e.message, 'bad'); } finally { if (btn && document.body.contains(btn)) { btn.disabled = false; btn.innerHTML = old; } }
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  if (a === 'rmode') { R.mode = el.dataset.m; saveR(); vReports(); }
  else if (a === 'rshift') { shiftPeriod(+el.dataset.d); saveR(); vReports(); }
  else if (a === 'rtoday') { R.day = today(); saveR(); vReports(); }
  else if (a === 'rload') loadReport();
  else if (a === 'rcsv') reportCsv();
  else if (a === 'rdev') { R.device = el.dataset.id; R.type = ''; saveR(); vReports(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  else if (a === 'mytest') mysqlAction('test', el);
  else if (a === 'myinit') mysqlAction('init', el);
});
