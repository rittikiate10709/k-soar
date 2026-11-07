'use strict';
/* ============================================================
   ตั้งค่า → API (API Key, CORS) และ สำรอง / กู้คืนข้อมูล
   ============================================================ */
const KEY_ROLE = {
  viewer: ['อ่านอย่างเดียว', 'info', 'ดึงสถานะ อุปกรณ์ แจ้งเตือน รายงาน'],
  operator: ['อ่าน + แก้ไข', 'warn', 'เพิ่ม/แก้ไข/ลบอุปกรณ์, รับทราบแจ้งเตือน'],
  admin: ['ผู้ดูแลระบบ', 'bad', 'ทุกอย่าง ยกเว้นจัดการผู้ใช้/API Key/กู้คืน'],
  integration: ['Integration (Wazuh)', 'maint', 'ส่ง alert เข้า /integrations/wazuh เท่านั้น'],
  agent: ['Agent เครื่องลูกข่าย', 'ok', 'ส่งสเปคเครื่องเข้า /inventory/report เท่านั้น'],
};
let AK = null, BK = null;
function apiBase() { return `${location.origin}/api/v1`; }

/* ---------------------------------------------------------------- API */
async function loadApiBox() {
  try { AK = await api('GET', '/api/apikeys'); renderApiBox(); } catch (e) { const b = $('#apiBox'); if (b) b.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function renderApiBox() {
  const box = $('#apiBox'); if (!box || !AK) return;
  const s = AK.settings;
  box.innerHTML = `
    <div class="ph"><h3>${icon('key', 17)}<span class="th">การเชื่อมต่อแบบ API</span><span class="bar"></span>REST API · API Keys</h3>
      <span class="right" style="text-transform:none"><a class="btn sm" href="/api-docs" target="_blank" rel="noopener">${icon('list', 14)} เอกสาร API / ทดลองเรียก</a></span></div>
    <div class="nfgrid">
      <form id="apiSet" class="form">
        <div class="full" style="display:flex;align-items:center;gap:10px"><label class="switch"><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}><span></span></label><b>อนุญาตให้ระบบภายนอกเชื่อมต่อด้วย API Key</b></div>
        <div class="full"><label>Base URL</label><div class="code-block" style="user-select:all;color:var(--text)">${esc(apiBase())}</div>
          <div class="hint">ทุก endpoint ใช้ได้ทั้ง <span class="mono">/api/v1/…</span> และ <span class="mono">/api/…</span> · OpenAPI: <a href="/api/v1/openapi.json" target="_blank">/api/v1/openapi.json</a></div></div>
        <div><label>จำนวนครั้ง/นาที ต่อ Key (ค่าเริ่มต้น)</label><input class="inp" type="number" min="10" name="defaultRate" value="${s.defaultRate}"></div>
        <div style="padding-top:26px"><label class="check"><input type="checkbox" name="trustProxy" ${s.trustProxy ? 'checked' : ''}> อยู่หลัง Reverse Proxy (เชื่อ X-Forwarded-For)</label></div>
        <div class="full"><label>CORS — เว็บไซต์ที่อนุญาตให้เรียก API จากเบราว์เซอร์ (บรรทัดละ 1)</label>
          <textarea class="inp" name="cors" rows="2" placeholder="https://dashboard.hospital.go.th">${esc((s.cors || []).join('\n'))}</textarea>
          <div class="hint">เว้นว่าง = ไม่อนุญาต (เรียกจากเซิร์ฟเวอร์/สคริปต์ได้ตามปกติ) · ใส่ * = ทุกเว็บไซต์ (ไม่แนะนำ)</div></div>
        <div class="full"><button class="btn primary" type="submit">${icon('check', 15)} บันทึกการตั้งค่า API</button></div>
      </form>
      <div>
        <div class="sub-h" style="display:flex;align-items:center">API Keys <span class="mono faint" style="margin-left:6px">${AK.keys.length}</span>
          <button class="btn sm primary" style="margin-left:auto" data-act="akadd">${icon('plus', 14)} สร้าง API Key</button></div>
        ${AK.keys.length ? `<div class="tblwrap"><table class="tbl"><thead><tr><th>ชื่อ / Key</th><th>สิทธิ์</th><th>ใช้ล่าสุด</th><th>จำกัด</th><th></th></tr></thead><tbody>
          ${AK.keys.map((k) => { const r = KEY_ROLE[k.role]; const exp = k.expires && k.expires < Date.now(); return `<tr class="${k.enabled && !exp ? '' : 'dim'}">
            <td><b>${esc(k.name)}</b><div class="mono faint" style="font-size:11px">${esc(k.prefix)}…</div></td>
            <td><span class="pill ${r[1]}">${r[0]}</span></td>
            <td class="mono" style="font-size:11.5px">${k.lastUsed ? `${fmtDT(k.lastUsed)}<div class="faint">${esc(k.lastIp || '')} · ${fNum(k.uses)} ครั้ง</div>` : '<span class="faint">ยังไม่เคยใช้</span>'}</td>
            <td style="font-size:11.5px">${k.ips && k.ips.length ? `IP: ${esc(k.ips.join(', '))}<br>` : ''}${k.rate ? `${k.rate}/นาที` : 'ค่าเริ่มต้น'}${k.expires ? `<br>${exp ? '<span style="color:var(--bad)">หมดอายุแล้ว</span>' : `หมดอายุ ${fmtDT(k.expires)}`}` : ''}</td>
            <td><div class="acts"><button class="btn sm" data-act="aktoggle" data-id="${k.id}">${k.enabled ? 'ปิด' : 'เปิด'}</button>
              <button class="btn sm danger" data-act="akdel" data-id="${k.id}" data-name="${esc(k.name)}">${icon('trash', 14)}</button></div></td></tr>`; }).join('')}
          </tbody></table></div>` : '<div class="empty" style="border:1px dashed var(--line);border-radius:8px">ยังไม่มี API Key</div>'}
        <div class="sub-h" style="margin-top:14px">ตัวอย่างการเรียกใช้</div>
        <div class="code-block" style="user-select:all;color:var(--text)">curl -H "Authorization: Bearer stk_xxxx" ${esc(apiBase())}/devices?status=offline</div>
      </div>
    </div>`;
  $('#apiSet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api('PUT', '/api/api-settings', { enabled: f.enabled.checked, cors: f.cors.value, defaultRate: f.defaultRate.value, trustProxy: f.trustProxy.checked }); toast('บันทึกการตั้งค่า API แล้ว', 'ok'); loadApiBox(); }
    catch (ex) { toast(ex.message, 'bad'); }
  });
}
function apiKeyModal(preset) {
  const m = modal(`<div class="mh">${icon('key', 20)}<h2>สร้าง API Key</h2><button class="ibtn x" data-act="mclose">${icon('x', 18)}</button></div>
    <form id="akForm"><div class="mb"><div id="akErr" class="err hidden"></div>
      <div class="form">
        <div class="full"><label>ชื่อ (ระบบที่จะเชื่อมต่อ) <span class="req">*</span></label><input class="inp" name="name" required maxlength="60" value="${esc(preset && preset.name || '')}" placeholder="เช่น Dashboard ผู้บริหาร, สคริปต์ HOSxP, Wazuh Manager"></div>
        <div class="full"><label>สิทธิ์</label><div class="akroles">${Object.entries(KEY_ROLE).map(([k, r]) => `<label class="akrole"><input type="radio" name="role" value="${k}" ${(preset && preset.role || 'viewer') === k ? 'checked' : ''}>
          <span><b>${r[0]}</b><small>${r[2]}</small></span></label>`).join('')}</div></div>
        <div><label>จำกัด IP ต้นทาง <span class="faint" style="font-weight:400">(เว้นว่าง = ทุก IP)</span></label><input class="inp mono" name="ips" placeholder="172.16.1.30, 10.0.0.0/8"></div>
        <div><label>จำนวนครั้ง/นาที <span class="faint" style="font-weight:400">(0 = ค่าเริ่มต้น)</span></label><input class="inp" type="number" min="0" name="rate" value="0"></div>
        <div><label>อายุ (วัน) <span class="faint" style="font-weight:400">0 = ไม่หมดอายุ</span></label><input class="inp" type="number" min="0" name="expiresDays" value="${preset && preset.expiresDays != null ? preset.expiresDays : 365}"></div>
      </div></div>
      <div class="mf"><button type="button" class="btn" data-act="mclose">ยกเลิก</button><button class="btn primary" type="submit">${icon('key', 16)} สร้าง Key</button></div></form>`);
  m.querySelector('.modal').style.maxWidth = '680px';
  m.querySelector('#akForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target, body = Object.fromEntries(new FormData(f));
    try {
      const r = await api('POST', '/api/apikeys', body);
      showToken(r.token, r.key, preset && preset.after);
      loadApiBox();
    } catch (ex) { const er = $('#akErr'); er.textContent = ex.message; er.classList.remove('hidden'); }
  });
}
function showToken(token, key, after) {
  const m = modal(`<div class="mh">${icon('check', 20)}<h2>สร้าง API Key “${esc(key.name)}” แล้ว</h2></div>
    <div class="mb"><div class="err" style="background:var(--warn-soft);border-color:#f7d79a;color:#8a5a00"><b>คัดลอกเก็บไว้ตอนนี้</b> — ระบบจะไม่แสดง Key นี้อีก (เก็บเฉพาะค่า hash)</div>
      <div class="code-block mono" id="tokVal" style="user-select:all;font-size:14px;color:var(--text);word-break:break-all">${esc(token)}</div>
      <div style="margin-top:10px"><button class="btn sm" data-act="copy" data-v="${esc(token)}">${icon('copy', 14)} คัดลอก</button></div>
      ${after ? after(token) : `<div class="sub-h" style="margin-top:14px">ทดลองเรียก</div><div class="code-block" style="user-select:all;color:var(--text)">curl -H "Authorization: Bearer ${esc(token)}" ${esc(apiBase())}/me</div>`}</div>
    <div class="mf"><button class="btn primary" data-act="mclose">เก็บเรียบร้อยแล้ว</button></div>`, after ? 'wide' : '');
  if (!after) m.querySelector('.modal').style.maxWidth = '680px';
}

/* ---------------------------------------------------------------- Backup */
async function loadBackupBox() {
  try { BK = await api('GET', '/api/backup/files'); renderBackupBox(); } catch (e) { const b = $('#backupBox'); if (b) b.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
const KIND_TH = { auto: ['อัตโนมัติ', 'info'], manual: ['สร้างเอง', 'ok'], pre: ['ก่อนกู้คืน', 'warn'] };
function renderBackupBox() {
  const box = $('#backupBox'); if (!box || !BK) return;
  const s = BK.settings;
  box.innerHTML = `
    <div class="ph"><h3>${icon('download', 17)}<span class="th">สำรองและกู้คืนข้อมูล</span><span class="bar"></span>Backup &amp; Restore</h3></div>
    <div class="ok-msg" style="background:var(--info-soft);border-color:#b8e3f8;color:#0b6b9c">ไฟล์สำรองเก็บ<b>ทุกค่าที่ตั้งจากหน้าเว็บ</b>: อุปกรณ์ (รวมตำแหน่งบนแผนผัง), ทะเบียนคอมพิวเตอร์ + ประวัติ, ช่วงสแกน IP, ผู้ใช้, การตั้งค่าตรวจสอบ, การแจ้งเตือน/หมอพร้อม, MySQL, ฐานข้อมูล Master/Slave + Query, API Key, Wazuh และค่าการสำรองข้อมูล — กู้คืนแล้วใช้งานได้ทันทีไม่ต้องตั้งค่าเพิ่ม</div>
    <div class="nfgrid">
      <div>
        <div class="sub-h">1. ดาวน์โหลดไฟล์สำรอง</div>
        <form id="bkExp" class="form">
          <div class="full"><label>รหัสผ่านเข้ารหัสไฟล์ <span class="faint" style="font-weight:400">(แนะนำ — ไฟล์มีรหัสผ่านฐานข้อมูลและคีย์หมอพร้อม)</span></label>
            <input class="inp" type="password" name="passphrase" autocomplete="new-password" placeholder="อย่างน้อย 8 ตัวอักษร (เว้นว่าง = ไม่เข้ารหัส)"></div>
          <div><input class="inp" type="password" name="passphrase2" autocomplete="new-password" placeholder="ยืนยันรหัสผ่าน"></div>
          <label class="check" style="padding-top:8px"><input type="checkbox" name="includeAlerts"> รวมประวัติการแจ้งเตือน</label>
          <div class="full"><button class="btn primary" type="submit">${icon('download', 15)} ดาวน์โหลดไฟล์สำรอง</button></div>
        </form>
        <div class="sub-h" style="margin-top:18px">2. กู้คืนจากไฟล์</div>
        <label class="btn">${icon('upload', 15)} เลือกไฟล์สำรอง (.json)<input type="file" id="bkFile" accept=".json,application/json" hidden></label>
        <div id="bkInspect" style="margin-top:10px"></div>
      </div>
      <div>
        <div class="sub-h">3. สำรองอัตโนมัติบนเซิร์ฟเวอร์</div>
        <form id="bkSet" class="form">
          <label class="check full"><input type="checkbox" name="autoEnabled" ${s.autoEnabled ? 'checked' : ''}> เปิดสำรองอัตโนมัติทุกวัน</label>
          <div><label>เวลา</label><input class="inp mono" name="time" value="${esc(s.time)}" placeholder="02:30"></div>
          <div><label>เก็บไว้ (ไฟล์ล่าสุด)</label><input class="inp" type="number" min="1" max="365" name="keep" value="${s.keep}"></div>
          <label class="check full"><input type="checkbox" name="includeAlerts" ${s.includeAlerts ? 'checked' : ''}> รวมประวัติการแจ้งเตือน</label>
          <div class="full" style="display:flex;gap:8px"><button class="btn" type="submit">${icon('check', 15)} บันทึก</button><button class="btn" type="button" data-act="bknow">${icon('plus', 15)} สำรองตอนนี้</button></div>
        </form>
        <div class="hint" style="margin:8px 0">เก็บที่ <span class="mono">${esc(BK.dir)}</span></div>
        ${BK.files.length ? `<div class="tblwrap" style="max-height:300px;overflow:auto"><table class="tbl"><thead><tr><th>ไฟล์</th><th>ประเภท</th><th style="text-align:right">ขนาด</th><th></th></tr></thead><tbody>
          ${BK.files.map((f) => { const k = KIND_TH[f.kind] || [f.kind, 'muted']; return `<tr><td class="mono" style="font-size:11.5px">${esc(f.name)}<div class="faint">${fmtDT(f.mtime)}</div></td>
            <td><span class="pill ${k[1]}">${k[0]}</span></td><td class="mono" style="text-align:right">${fBytes(f.size)}</td>
            <td><div class="acts"><a class="btn sm" href="/api/backup/files/${encodeURIComponent(f.name)}" title="ดาวน์โหลด">${icon('download', 14)}</a>
              <button class="btn sm" data-act="bkrestore" data-name="${esc(f.name)}">กู้คืน</button>
              <button class="btn sm danger" data-act="bkdel" data-name="${esc(f.name)}" title="ลบ">${icon('trash', 14)}</button></div></td></tr>`; }).join('')}</tbody></table></div>`
    : '<div class="empty">ยังไม่มีไฟล์สำรองบนเซิร์ฟเวอร์</div>'}
      </div>
    </div>`;
  $('#bkExp').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.passphrase.value !== f.passphrase2.value) { toast('รหัสผ่านทั้งสองช่องไม่ตรงกัน', 'bad'); return; }
    try {
      const r = await api('POST', '/api/backup/export', { passphrase: f.passphrase.value || undefined, includeAlerts: f.includeAlerts.checked });
      const blob = new Blob([JSON.stringify(r.backup, null, 1)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = r.filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast(`ดาวน์โหลด ${r.filename} แล้ว (${r.summary.devices} อุปกรณ์, ${r.summary.users} ผู้ใช้)`, 'ok');
      f.passphrase.value = f.passphrase2.value = '';
    } catch (ex) { toast(ex.message, 'bad'); }
  });
  $('#bkSet').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try { await api('PUT', '/api/backup/settings', { autoEnabled: f.autoEnabled.checked, time: f.time.value, keep: f.keep.value, includeAlerts: f.includeAlerts.checked }); toast('บันทึกการตั้งค่าสำรองอัตโนมัติแล้ว', 'ok'); loadBackupBox(); }
    catch (ex) { toast(ex.message, 'bad'); }
  });
  $('#bkFile').addEventListener('change', (e) => {
    const file = e.target.files[0]; if (!file) return;
    const rd = new FileReader();
    rd.onload = () => inspectBackup(String(rd.result), file.name, '');
    rd.readAsText(file, 'utf-8');
    e.target.value = '';
  });
}
function summaryHtml(meta, s) {
  return `<div class="kv" style="margin:8px 0">
    <div><span>สร้างเมื่อ</span><span>${meta.createdAt ? new Date(meta.createdAt).toLocaleString('th-TH', { hour12: false }) : '—'}${meta.createdBy ? ` โดย ${esc(meta.createdBy)}` : ''}</span></div>
    <div><span>เวอร์ชันโปรแกรม</span><span class="mono">${esc(meta.app || '—')}${meta.encrypted ? ' · 🔒 เข้ารหัส' : ''}</span></div>
    <div><span>ชื่อหน่วยงาน</span><span>${esc(s.siteName || '—')}</span></div>
    <div><span>อุปกรณ์ / ผู้ใช้ (admin)</span><span class="mono">${s.devices} / ${s.users} (${s.admins})</span></div>
    <div><span>ช่องทางแจ้งเตือน</span><span>${s.notifyChannels} ช่องทาง${s.notifyEnabled ? ' (เปิด)' : ''}</span></div>
    <div><span>MySQL Log</span><span class="mono">${s.mysqlHost ? esc(s.mysqlHost) : '—'}${s.mysql ? ' (เปิด)' : ''}</span></div>
    <div><span>Master/Slave · Query</span><span>${s.dbsync ? 'ตั้งค่าแล้ว' : '—'} · ${s.dbQueries} Query</span></div>
    <div><span>API Key · Wazuh</span><span>${s.apiKeys} Key · ${s.wazuh ? 'ตั้งค่าแล้ว' : '—'}</span></div>
    <div><span>ทะเบียนคอมพิวเตอร์ · ช่วงสแกน IP</span><span>${s.assets == null ? 'ไม่มีในไฟล์ (คงค่าปัจจุบัน)' : `${fNum(s.assets)} เครื่อง (${fNum(s.assetChanges)} ประวัติ)`} · ${s.ipRanges == null ? '—' : `${s.ipRanges} ช่วง`}</span></div>
    <div><span>ประวัติแจ้งเตือน</span><span>${s.alerts == null ? 'ไม่รวม (คงประวัติปัจจุบัน)' : `${fNum(s.alerts)} รายการ`}</span></div></div>`;
}
async function inspectBackup(text, name, pass) {
  const out = $('#bkInspect');
  let obj; try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch { out.innerHTML = '<div class="err">ไฟล์ไม่ใช่ JSON</div>'; return; }
  if (obj && obj.backup && obj.backup.format && !obj.format) obj = obj.backup;   // ผลลัพธ์จาก API /backup/export โดยตรง
  const r = await api('POST', '/api/backup/inspect', { backup: obj, passphrase: pass || undefined });
  if (r.error && r.needPass) {
    out.innerHTML = `<div class="${pass ? 'err' : 'ok-msg'}" style="${pass ? '' : 'background:var(--warn-soft);border-color:#f7d79a;color:#8a5a00'}">${esc(r.error)}</div>
      <div style="display:flex;gap:8px"><input class="inp" type="password" id="bkPass" placeholder="รหัสผ่านไฟล์สำรอง" autocomplete="off"><button class="btn" id="bkPassBtn">ตรวจสอบ</button></div>`;
    $('#bkPassBtn').addEventListener('click', () => inspectBackup(text, name, $('#bkPass').value));
    $('#bkPass').focus();
    return;
  }
  if (r.error) { out.innerHTML = `<div class="err">${esc(r.error)}</div>`; return; }
  out.innerHTML = `<div class="ok-msg">✓ ไฟล์ถูกต้อง: <b>${esc(name)}</b></div>${summaryHtml(r.meta, r.summary)}
    <button class="btn danger" id="bkGo">${icon('upload', 15)} กู้คืนจากไฟล์นี้</button>`;
  $('#bkGo').addEventListener('click', async () => {
    if (!await confirmBox('ยืนยันการกู้คืนข้อมูล', `ค่าปัจจุบันทั้งหมดจะถูกแทนที่ด้วยค่าจากไฟล์ <b>${esc(name)}</b><br><span class="muted">ระบบจะสำรองค่าปัจจุบันไว้ให้อัตโนมัติก่อน (ไฟล์ “ก่อนกู้คืน”) และทุกคนต้องเข้าสู่ระบบใหม่</span>`, 'กู้คืนข้อมูล')) return;
    try { window.ST_RESTORED = true; const x = await api('POST', '/api/backup/restore', { backup: obj, passphrase: pass || undefined, confirm: true }); restoredDone(x); }
    catch (ex) { window.ST_RESTORED = false; toast(ex.message, 'bad'); }
  });
}
function restoredDone(x) {
  window.ST_RESTORED = true;
  modal(`<div class="mh">${icon('check', 20)}<h2>กู้คืนข้อมูลเรียบร้อย</h2></div>
    <div class="mb"><div class="ok-msg">ระบบใช้ค่าจากไฟล์สำรองแล้ว — อุปกรณ์ ${x.summary.devices} รายการ, ผู้ใช้ ${x.summary.users} คน</div>
      ${x.issues.length ? `<div class="err" style="background:var(--warn-soft);border-color:#f7d79a;color:#8a5a00">${x.issues.map(esc).join('<br>')}</div>` : ''}
      <p class="muted">สำรองค่าก่อนกู้คืนไว้ที่ <span class="mono">${esc(x.snapshot)}</span> · กรุณาเข้าสู่ระบบใหม่ด้วยบัญชีจากไฟล์สำรอง</p></div>
    <div class="mf"><a class="btn primary" href="/login" data-nav="1">เข้าสู่ระบบใหม่</a></div>`);
}
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act;
  try {
    if (a === 'akadd') apiKeyModal();
    else if (a === 'aktoggle') { const k = AK.keys.find((x) => x.id === el.dataset.id); await api('PUT', `/api/apikeys/${k.id}`, { enabled: !k.enabled }); loadApiBox(); }
    else if (a === 'akdel') { if (await confirmBox('ลบ API Key', `ลบ <b>${esc(el.dataset.name)}</b>? ระบบที่ใช้ Key นี้จะเชื่อมต่อไม่ได้ทันที`, 'ลบ')) { await api('DELETE', `/api/apikeys/${el.dataset.id}`); toast('ลบ API Key แล้ว', 'ok'); loadApiBox(); } }
    else if (a === 'bknow') { el.disabled = true; await api('POST', '/api/backup/files', { includeAlerts: $('#bkSet').includeAlerts.checked }); toast('สร้างไฟล์สำรองบนเซิร์ฟเวอร์แล้ว', 'ok'); loadBackupBox(); }
    else if (a === 'bkdel') { if (await confirmBox('ลบไฟล์สำรอง', `ลบ <b>${esc(el.dataset.name)}</b>?`, 'ลบ')) { await api('DELETE', `/api/backup/files/${encodeURIComponent(el.dataset.name)}`); loadBackupBox(); } }
    else if (a === 'bkrestore') {
      if (!await confirmBox('ยืนยันการกู้คืนข้อมูล', `กู้คืนจาก <b>${esc(el.dataset.name)}</b>?<br><span class="muted">ค่าปัจจุบันจะถูกสำรองไว้ก่อนอัตโนมัติ และทุกคนต้องเข้าสู่ระบบใหม่</span>`, 'กู้คืนข้อมูล')) return;
      window.ST_RESTORED = true;
      const x = await api('POST', `/api/backup/files/${encodeURIComponent(el.dataset.name)}/restore`, { confirm: true }).catch((ex) => { window.ST_RESTORED = false; throw ex; }); restoredDone(x);
    }
  } catch (ex) { toast(ex.message, 'bad'); }
});
