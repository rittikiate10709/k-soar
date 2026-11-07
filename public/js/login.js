'use strict';
(function () {
  const brand = `${logoHtml()}<div><h1>SMART TOPOLOGY <span class="noc">NOC</span></h1><p>ระบบจำลองศูนย์ข้อมูลและอุปกรณ์เครือข่าย</p></div>`;
  $('#brandArt').innerHTML = brand;
  $('#brandForm').innerHTML = brand;
  $('#uIcon').outerHTML = icon('user', 16);
  $('#pIcon').outerHTML = icon('lock', 16);
  $('#eyeBtn').innerHTML = icon('eye', 16);
  const setThemeBtn = () => { $('#themeBtn').innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 16); };
  setThemeBtn();
  $('#themeBtn').addEventListener('click', () => { applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); setThemeBtn(); });
  const btnIdle = `${icon('login', 18)} เข้าสู่ระบบ`;
  $('#loginBtn').innerHTML = btnIdle;
  $('#eyeBtn').addEventListener('click', () => {
    const p = $('#password'); p.type = p.type === 'password' ? 'text' : 'password';
    $('#eyeBtn').innerHTML = icon(p.type === 'password' ? 'eye' : 'eyeoff', 16);
  });

  // ถ้าล็อกอินอยู่แล้วให้ไปหน้าหลัก
  fetch('/api/me', { credentials: 'same-origin' }).then((r) => { if (r.ok) location.href = '/'; }).catch(() => {});

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#loginErr'); err.classList.add('hidden');
    const b = $('#loginBtn'); b.disabled = true; b.innerHTML = `${icon('refresh', 18, 'spin')} กำลังตรวจสอบ...`;
    try {
      await api('POST', '/api/login', { username: $('#username').value, password: $('#password').value, remember: $('#remember').checked });
      location.href = '/';
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove('hidden');
      b.disabled = false; b.innerHTML = btnIdle;
    }
  });
})();
