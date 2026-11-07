'use strict';
/* Device illustrations (SVG) per type — used on device cards and detail view */
const TYPE_INFO = {
  isp: { label: 'ISP / WAN', th: 'วงจรอินเทอร์เน็ต' },
  firewall: { label: 'Firewall', th: 'ไฟร์วอลล์' },
  router: { label: 'Router', th: 'เราเตอร์' },
  core: { label: 'Core Switch', th: 'สวิตช์หลัก' },
  switch: { label: 'Access Switch', th: 'สวิตช์กระจาย' },
  ap: { label: 'Wireless AP', th: 'จุดกระจาย Wi-Fi' },
  server: { label: 'Server', th: 'เครื่องแม่ข่าย' },
  vm: { label: 'Virtual Machine', th: 'เครื่องเสมือน' },
  database: { label: 'Database', th: 'ฐานข้อมูล / HIS' },
  client: { label: 'PC / Workstation', th: 'คอมพิวเตอร์ตั้งโต๊ะ' },
  laptop: { label: 'Laptop', th: 'โน้ตบุ๊ก' },
  camera: { label: 'CCTV', th: 'กล้องวงจรปิด' },
  printer: { label: 'Printer', th: 'เครื่องพิมพ์' },
  medical: { label: 'Medical Device', th: 'อุปกรณ์การแพทย์' },
  kiosk: { label: 'Kiosk', th: 'ตู้คีออส' },
  iot: { label: 'IoT', th: 'อุปกรณ์ IoT' },
  other: { label: 'Other', th: 'อื่น ๆ' },
};
const VENDOR_COLORS = { cisco: '#049fd9', fortinet: '#ee3124', aruba: '#ff8300', 'tp-link': '#4acbd6', hikvision: '#d7262f',
  mikrotik: '#293239', huawei: '#cf0a2c', juniper: '#84b135', hp: '#0096d6', dell: '#007db8', ubiquiti: '#0559c9', isp: '#2563eb' };
function vendorColor(v) { return VENDOR_COLORS[String(v || '').toLowerCase()] || '#0e7c6b'; }

function illus(d, w = 190) {
  const led = d.status === 'online' ? '#12b07a' : d.status === 'warning' ? '#f0a020' : d.status === 'offline' ? '#f0425f' : '#64748b';
  const vc = vendorColor(d.vendor);
  const vend = esc(String(d.vendor || TYPE_INFO[d.type]?.label || '').toUpperCase().slice(0, 10));
  const ports = (n, x, y, gap = 7) => Array.from({ length: n }, (_, i) =>
    `<rect x="${x + i * gap}" y="${y}" width="5" height="4" rx=".5" fill="#2b3850"/><rect x="${x + i * gap + 1.5}" y="${y - 2.4}" width="2" height="1.2" fill="${i % 3 === 2 && d.status !== 'online' ? '#334155' : led}"/>`).join('');
  let body = '';
  switch (d.type) {
    case 'isp': case 'firewall': case 'router': case 'core': case 'switch': {
      const big = d.type === 'core' || d.type === 'switch';
      body = `<rect x="15" y="40" width="170" height="${big ? 46 : 40}" rx="3" fill="#141c2b" stroke="#2d3a52"/>
        <rect x="21" y="45" width="${vend.length * 5.6 + 8}" height="9" rx="1.5" fill="${vc}"/><text x="25" y="52" font-size="6.5" font-family="monospace" font-weight="700" fill="#fff">${vend}</text>
        ${ports(big ? 12 : 8, 22, 62)}${big ? ports(12, 22, 74) : ''}
        <rect x="${big ? 115 : 85}" y="60" width="${big ? 26 : 22}" height="10" rx="1" fill="#0b1a22" stroke="#15524a"/><text x="${big ? 117 : 87}" y="67" font-size="5" font-family="monospace" fill="#2dd4bf">SFP+</text>
        <circle cx="172" cy="49" r="2.4" fill="${led}"/><circle cx="164" cy="49" r="2.4" fill="${d.status === 'offline' ? '#f0425f' : '#334155'}"/>
        ${d.type === 'firewall' ? '<rect x="150" y="62" width="26" height="16" rx="1.5" fill="#0f1726" stroke="#2d3a52"/><text x="153" y="72" font-size="5" font-family="monospace" fill="#94a3b8">CONSOLE</text>' : ''}
        ${d.type === 'isp' ? '<path d="M150 70a12 12 0 0 1 22 0M154 74a7 7 0 0 1 14 0" stroke="#38bdf8" stroke-width="1.4" fill="none"/>' : ''}`;
      break;
    }
    case 'server': case 'vm': case 'database': {
      const units = [0, 1, 2].map((i) => `<rect x="55" y="${22 + i * 26}" width="90" height="22" rx="2" fill="#141c2b" stroke="#2d3a52"/>
        ${[0, 1, 2, 3, 4, 5].map((j) => `<rect x="${62 + j * 9}" y="${28 + i * 26}" width="6" height="10" rx="1" fill="#24314a"/>`).join('')}
        <circle cx="134" cy="${33 + i * 26}" r="2.4" fill="${i === 0 ? led : '#334155'}"/>`).join('');
      body = units + `<text x="100" y="112" font-size="6" font-family="monospace" fill="#94a3b8" text-anchor="middle">${d.type === 'database' ? 'DATABASE · HIS' : d.type === 'vm' ? 'VIRTUAL MACHINE' : 'RACK SERVER'}</text>`;
      break;
    }
    case 'client': case 'laptop': case 'medical': case 'kiosk': {
      if (d.type === 'laptop') {
        body = `<rect x="45" y="22" width="110" height="68" rx="3" fill="#0b1220" stroke="#2d3a52"/><rect x="51" y="28" width="98" height="56" fill="#060b14"/>
          <text x="55" y="38" font-size="5" font-family="monospace" fill="#2dd4bf">${esc(String(d.model || 'LAPTOP').slice(0, 22).toUpperCase())}</text>
          <rect x="55" y="54" width="60" height="2" fill="#334155"/><rect x="55" y="59" width="45" height="2" fill="#334155"/>
          <text x="55" y="80" font-size="4.5" font-family="monospace" fill="${led}">${d.status === 'online' ? 'ONLINE' : 'NO SIGNAL'}</text>
          <path d="M35 92h130l-6 7H41z" fill="#1f2a3d" stroke="#2d3a52"/>`;
      } else if (d.type === 'medical') {
        body = `<rect x="40" y="18" width="120" height="82" rx="4" fill="#f8fafc" stroke="#cbd5e1"/><rect x="40" y="18" width="120" height="5" rx="2" fill="#f0a0b0"/>
          <rect x="47" y="27" width="106" height="58" fill="#060b14"/>
          <text x="51" y="36" font-size="5" font-family="monospace" fill="#22c55e">ECG II</text><text x="128" y="36" font-size="5" font-family="monospace" fill="#38bdf8">SpO2</text>
          <path d="M51 58h18l4-10 5 20 4-10h20l3-6 4 12 3-6h30" stroke="${d.status === 'online' ? '#22c55e' : '#475569'}" stroke-width="1.2" fill="none"/>
          ${['#f0a020', '#38bdf8', '#f0425f', '#12b07a'].map((c, i) => `<circle cx="${86 + i * 9}" cy="93" r="2.6" fill="${c}"/>`).join('')}`;
      } else if (d.type === 'kiosk') {
        body = `<rect x="66" y="10" width="68" height="100" rx="3" fill="#141c2b" stroke="#2d3a52"/><rect x="66" y="10" width="68" height="14" fill="#0f3d3a"/>
          <text x="100" y="19" font-size="5" font-family="monospace" fill="#5eead4" text-anchor="middle" font-weight="700">KIOSK</text>
          <rect x="73" y="28" width="54" height="56" fill="#060b14" stroke="#15524a"/><rect x="92" y="46" width="16" height="12" rx="2" fill="none" stroke="#2dd4bf"/>
          <rect x="76" y="90" width="48" height="3" fill="#b98a2f"/><rect x="56" y="108" width="88" height="5" fill="#1f2a3d"/>`;
      } else {
        body = `<rect x="40" y="28" width="96" height="60" rx="3" fill="#0b1220" stroke="#2d3a52"/><rect x="45" y="33" width="86" height="46" fill="#060b14" stroke="#1e293b"/>
          <text x="49" y="42" font-size="4.6" font-family="monospace" fill="#2dd4bf">${esc(String(d.code || 'WORKSTATION').slice(0, 18))}</text>
          <rect x="49" y="47" width="50" height="2" fill="#334155"/><text x="49" y="72" font-size="4.4" font-family="monospace" fill="${led}">${d.status === 'online' ? 'ONLINE' : 'OFFLINE'}</text>
          <rect x="78" y="88" width="20" height="6" fill="#1f2a3d"/><rect x="146" y="22" width="22" height="72" rx="2" fill="#141c2b" stroke="#2d3a52"/>
          <circle cx="157" cy="30" r="2.6" fill="${led}"/><rect x="150" y="72" width="14" height="1.4" fill="#334155"/><rect x="150" y="76" width="14" height="1.4" fill="#334155"/>`;
      }
      break;
    }
    case 'camera':
      body = `<rect x="64" y="22" width="72" height="14" rx="3" fill="#cbd5e1" stroke="#94a3b8"/><path d="M70 36h60v14a30 30 0 0 1-60 0z" fill="#141c2b"/>
        <circle cx="100" cy="56" r="13" fill="#0b1220" stroke="#334155" stroke-width="2"/><circle cx="100" cy="56" r="7" fill="#1e3a8a"/><circle cx="100" cy="56" r="3" fill="#0b1220"/>
        <circle cx="121" cy="44" r="2" fill="${led}"/><text x="100" y="104" font-size="5.5" font-family="monospace" fill="#64748b" text-anchor="middle">${esc(String(d.vendor || 'CCTV').toUpperCase())} IP CAMERA</text>`;
      break;
    case 'ap':
      body = `<ellipse cx="100" cy="70" rx="44" ry="14" fill="#e2e8f0" stroke="#94a3b8"/><ellipse cx="100" cy="66" rx="44" ry="14" fill="#f8fafc" stroke="#cbd5e1"/>
        <circle cx="100" cy="66" r="3" fill="${led}"/>
        <path d="M84 40a24 24 0 0 1 32 0M90 47a14 14 0 0 1 20 0" stroke="${d.status === 'online' ? '#14b8a6' : '#94a3b8'}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
      break;
    case 'printer':
      body = `<rect x="62" y="22" width="76" height="22" fill="#f8fafc" stroke="#cbd5e1"/><rect x="48" y="42" width="104" height="40" rx="4" fill="#1f2a3d" stroke="#2d3a52"/>
        <rect x="62" y="76" width="76" height="22" fill="#f8fafc" stroke="#cbd5e1"/><circle cx="138" cy="52" r="2.4" fill="${led}"/>`;
      break;
    default:
      body = `<rect x="60" y="30" width="80" height="56" rx="6" fill="#141c2b" stroke="#2d3a52"/><circle cx="100" cy="58" r="12" fill="none" stroke="#2dd4bf" stroke-width="2"/>
        <circle cx="128" cy="40" r="2.4" fill="${led}"/>`;
  }
  return `<svg width="${w}" height="${w * 0.63}" viewBox="0 0 200 120" aria-hidden="true">${body}</svg>`;
}
