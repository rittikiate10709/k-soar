'use strict';
/* แสดง OpenAPI 3 ของ Smart Topology + ทดลองเรียก (ไม่ใช้ไลบรารีภายนอก เพราะ CSP อนุญาตเฉพาะ self) */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let SPEC = null;
const md = (s) => esc(s || '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<span class="mono">$1</span>').replace(/\n/g, '<br>');
function ref(o) { if (o && o.$ref) { const n = o.$ref.split('/').pop(); return SPEC.components.schemas[n]; } return o; }
function example(sc, depth = 0) {
  sc = ref(sc); if (!sc || depth > 4) return null;
  if (sc.example !== undefined) return sc.example;
  if (sc.type === 'object' || sc.properties) { const o = {}; Object.entries(sc.properties || {}).forEach(([k, v]) => { o[k] = example(v, depth + 1); }); return o; }
  if (sc.type === 'array') return [example(sc.items, depth + 1)];
  if (sc.enum) return sc.enum[0];
  return { integer: 0, number: 0, boolean: false, string: '' }[sc.type] ?? null;
}
function opHtml(path, method, op, i) {
  const params = op.parameters || [];
  const body = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'];
  const ex = body ? JSON.stringify(body.example || example(body.schema), null, 2) : '';
  return `<details class="card adop" data-i="${i}"><summary><span class="adm ${method}">${method.toUpperCase()}</span><span class="adp">${esc(path)}</span><span class="ads">${esc(op.summary || '')}</span></summary>
    <div class="adbody">${op.description ? `<p>${md(op.description)}</p>` : ''}
      ${params.length ? `<table><tr><th>พารามิเตอร์</th><th>ที่</th><th>คำอธิบาย</th><th>ค่า</th></tr>${params.map((p) => `<tr><td class="mono">${esc(p.name)}${p.required ? ' *' : ''}</td><td>${esc(p.in)}</td><td>${md(p.description || '')}</td>
        <td><input class="inp mono" data-p="${esc(p.name)}" data-in="${esc(p.in)}" value="${esc(p.example ?? '')}" style="height:30px"></td></tr>`).join('')}</table>` : ''}
      ${body ? `<div class="sub-h">Request body (JSON)</div><textarea class="inp" data-body>${esc(ex)}</textarea>` : ''}
      <div class="sub-h" style="margin-top:8px">การตอบกลับ</div><div>${Object.entries(op.responses || {}).map(([c, r]) => `<span class="pill ${c < 300 ? 'ok' : c < 500 ? 'warn' : 'bad'}" style="margin-right:4px">${c} ${esc(r.description)}</span>`).join('')}</div>
      ${path === '/events' ? '<p class="hint">Server-Sent Events — เปิดด้วย EventSource หรือ curl -N ไม่สามารถทดลองในหน้านี้</p>' : `<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary sm" data-try>ทดลองเรียก</button><button class="btn sm" data-curl>คัดลอกคำสั่ง curl</button></div>`}
      <div class="adst"></div><pre class="code-block adres hidden"></pre></div></details>`;
}
function build(det) {
  const op = OPS[det.dataset.i]; let path = op.path; const qs = new URLSearchParams();
  det.querySelectorAll('[data-p]').forEach((inp) => { const v = inp.value.trim(); if (!v) return; if (inp.dataset.in === 'path') path = path.replace(`{${inp.dataset.p}}`, encodeURIComponent(v)); else if (inp.dataset.in === 'query') qs.set(inp.dataset.p, v); });
  const url = `/api/v1${path}${qs.toString() ? `?${qs}` : ''}`;
  const b = det.querySelector('[data-body]');
  return { method: op.method.toUpperCase(), url, body: b ? b.value : null };
}
let OPS = [];
async function load() {
  SPEC = await (await fetch('/api/v1/openapi.json')).json();
  $('#ver').textContent = `${SPEC.info.title} · v${SPEC.info.version} · OpenAPI ${SPEC.openapi}`;
  $('#base').textContent = `Base URL: ${location.origin}/api/v1`;
  const byTag = {};
  Object.entries(SPEC.paths).forEach(([path, ops]) => Object.entries(ops).forEach(([method, op]) => {
    if (!['get', 'post', 'put', 'delete'].includes(method)) return;
    const t = (op.tags || ['อื่น ๆ'])[0]; (byTag[t] = byTag[t] || []).push({ path, method, op });
  }));
  let html = '';
  (SPEC.tags || []).map((t) => t.name).concat(Object.keys(byTag)).filter((t, i, a) => a.indexOf(t) === i && byTag[t]).forEach((t) => {
    const td = (SPEC.tags || []).find((x) => x.name === t);
    html += `<h3 class="adtag">${esc(t)}${td && td.description ? ` <span class="faint" style="font-weight:400;font-size:13px">— ${esc(td.description)}</span>` : ''}</h3>`;
    byTag[t].forEach((o) => { OPS.push(o); html += opHtml(o.path, o.method, o.op, OPS.length - 1); });
  });
  $('#ops').innerHTML = html;
}
document.addEventListener('click', async (e) => {
  const det = e.target.closest('.adop'); if (!det) return;
  if (e.target.closest('[data-curl]')) {
    const r = build(det), tok = $('#tok').value.trim() || 'stk_xxxxxxxx';
    const c = `curl -X ${r.method} -H "Authorization: Bearer ${tok}"${r.body ? ` -H "Content-Type: application/json" -d '${r.body.replace(/\s*\n\s*/g, ' ').replace(/'/g, "'\\''")}'` : ''} "${location.origin}${r.url}"`;
    const t = document.createElement('textarea'); t.value = c; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
    det.querySelector('.adst').textContent = 'คัดลอกคำสั่ง curl แล้ว';
  }
  if (e.target.closest('[data-try]')) {
    const r = build(det), st = det.querySelector('.adst'), out = det.querySelector('.adres');
    const h = {}; const tok = $('#tok').value.trim(); if (tok) h.Authorization = `Bearer ${tok}`;
    if (r.body != null) h['Content-Type'] = 'application/json';
    st.textContent = 'กำลังเรียก…'; const t0 = performance.now();
    try {
      const res = await fetch(r.url, { method: r.method, headers: h, body: r.body != null ? r.body : undefined, credentials: tok ? 'omit' : 'same-origin' });
      const txt = await res.text(); let pretty = txt; try { pretty = JSON.stringify(JSON.parse(txt), null, 2); } catch { /* not json */ }
      st.innerHTML = `<span style="color:${res.ok ? 'var(--ok)' : 'var(--bad)'}">HTTP ${res.status}</span> · ${Math.round(performance.now() - t0)} ms · ${esc(r.method)} ${esc(r.url)}${res.headers.get('x-ratelimit-remaining') ? ` · เหลือ ${res.headers.get('x-ratelimit-remaining')} ครั้ง/นาที` : ''}`;
      out.textContent = pretty.length > 200000 ? `${pretty.slice(0, 200000)}\n… (ตัดแสดง)` : pretty; out.classList.remove('hidden');
    } catch (ex) { st.textContent = `เรียกไม่สำเร็จ: ${ex.message}`; }
  }
});
load().catch((e) => { $('#ops').innerHTML = `<div class="err">${esc(e.message)}</div>`; });
