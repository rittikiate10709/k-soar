'use strict';
/** OpenAPI 3.0 specification ของ Smart Topology NOC API (แสดงที่ /api-docs และ /api/v1/openapi.json) */
module.exports = function spec(version) {
  const ref = (n) => ({ $ref: `#/components/schemas/${n}` });
  const json = (schema, description = 'สำเร็จ') => ({ description, content: { 'application/json': { schema } } });
  const body = (schema, example) => ({ required: true, content: { 'application/json': { schema, ...(example ? { example } : {}) } } });
  const err = { 400: json(ref('Error'), 'ข้อมูลไม่ถูกต้อง'), 401: json(ref('Error'), 'ไม่ได้ยืนยันตัวตน'), 403: json(ref('Error'), 'สิทธิ์ไม่เพียงพอ'), 429: json(ref('Error'), 'เรียกเกินกำหนด') };
  const op = (tag, summary, role, extra = {}) => ({ tags: [tag], summary, description: `${extra.description || ''}${role ? `\n\n**สิทธิ์ขั้นต่ำ:** \`${role}\`` : ''}`.trim(),
    responses: { 200: extra.ok || json({ type: 'object' }), ...err }, ...(extra.params ? { parameters: extra.params } : {}), ...(extra.body ? { requestBody: extra.body } : {}),
    ...(extra.public ? { security: [] } : {}) });
  const q = (name, description, schema = { type: 'string' }, required = false) => ({ name, in: 'query', description, required, schema });
  const pid = (name = 'id', description = 'รหัส') => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });

  return {
    openapi: '3.0.3',
    info: {
      title: 'Smart Topology NOC API', version,
      description: 'REST API สำหรับเชื่อมต่อระบบเฝ้าระวังเครือข่าย Smart Topology กับระบบอื่น (Front-end, Dashboard, SIEM, สคริปต์อัตโนมัติ)\n\n'
        + '**การยืนยันตัวตน:** ส่ง header `Authorization: Bearer stk_xxxxx` (สร้าง API Key ได้ที่ ตั้งค่า → API) '
        + 'หรือใช้ cookie ของการล็อกอินผ่านหน้าเว็บ\n\n**รูปแบบข้อผิดพลาด:** `{ "error": "ข้อความ" }` พร้อม HTTP status 4xx/5xx\n\n'
        + '**Rate limit:** ดูได้จาก header `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`',
    },
    servers: [{ url: '/api/v1', description: 'เซิร์ฟเวอร์นี้' }],
    security: [{ bearerAuth: [] }, { cookieAuth: [] }],
    tags: [
      { name: 'ระบบ', description: 'สถานะระบบและผู้ใช้' }, { name: 'อุปกรณ์', description: 'จัดการอุปกรณ์ที่ monitor' },
      { name: 'แจ้งเตือน', description: 'รายการแจ้งเตือน' }, { name: 'รายงาน', description: 'สถิติจาก MySQL log' },
      { name: 'ฐานข้อมูล Master/Slave', description: 'ผลการเปรียบเทียบฐานข้อมูล' }, { name: 'Wazuh', description: 'ข้อมูลจาก Wazuh และรับ alert จาก Wazuh' },
      { name: 'สำรองข้อมูล', description: 'สำรองการตั้งค่า (admin)' },
      { name: 'ทะเบียนคอมพิวเตอร์', description: 'สเปคเครื่องจาก Agent และประวัติการเปลี่ยนแปลง' }, { name: 'สแกน IP', description: 'ผลสแกน IP เทียบกับทะเบียน' },
    ],
    paths: {
      '/health': { get: op('ระบบ', 'ตรวจสถานะการทำงาน (ไม่ต้องยืนยันตัวตน)', null, { public: true, ok: json(ref('Health')) }) },
      '/me': { get: op('ระบบ', 'ข้อมูลผู้ใช้ / API Key ที่ใช้อยู่', 'viewer') },
      '/state': { get: op('ระบบ', 'สถานะทั้งหมดแบบ snapshot (อุปกรณ์ + แนวโน้ม + แจ้งเตือน)', 'viewer') },
      '/events': { get: op('ระบบ', 'สตรีมสถานะแบบเรียลไทม์ (Server-Sent Events)', 'viewer', { description: 'ส่ง event ชื่อ `state` ทุกรอบการตรวจ (text/event-stream)' }) },
      '/inventory/report': { post: op('ทะเบียนคอมพิวเตอร์', 'Agent ส่งสเปคเครื่อง', 'agent', { description: 'ใช้โดย smart-topology-agent (Windows/Linux) · จับคู่เครื่องด้วย agentId → UUID+Serial → MAC → hostname แล้วบันทึกการเปลี่ยนแปลง',
        body: body({ type: 'object', required: ['hostname'] }, { agentId: '8b1c6c0e-1111-4c1e-9a7a-000000000001', platform: 'windows', hostname: 'OPD-PC-01', os: { name: 'Microsoft Windows 11 Pro', version: '10.0.22631', build: '22631.4460', release: '23H2', arch: '64-bit' },
          cpu: { model: 'Intel(R) Core(TM) i5-12400', cores: 6, threads: 12 }, ramMB: 16384, disks: [{ model: 'Samsung SSD 870 EVO 500GB', sizeGB: 500, type: 'SSD' }], gpus: [{ name: 'Intel(R) UHD Graphics 730' }],
          net: [{ name: 'Ethernet', mac: '00:1A:2B:3C:4D:5E', ipv4: ['172.16.10.21'] }], system: { manufacturer: 'Dell Inc.', model: 'OptiPlex 3000', serial: '7XK2B53' }, software: [{ name: 'HOSxP', version: '3.67.10.1' }] }) }) },
      '/inventory': { get: op('ทะเบียนคอมพิวเตอร์', 'รายการเครื่องคอมพิวเตอร์ + สถิติ', 'viewer', { params: [q('q', 'ค้นหา ชื่อ/IP/MAC/เลขครุภัณฑ์/CPU'), q('state', 'online | idle | stale | manual | spare | repair | retired'), q('dept', 'หน่วยงาน')] }) },
      '/inventory/assets/{id}': { get: op('ทะเบียนคอมพิวเตอร์', 'รายละเอียดเครื่อง + ประวัติการเปลี่ยนแปลง', 'viewer', { params: [pid('id', 'รหัสเครื่อง')] }) },
      '/inventory/changes': { get: op('ทะเบียนคอมพิวเตอร์', 'รายงานการเปลี่ยนแปลง รายวัน/เดือน/ปี/ช่วงวันที่', 'viewer', { params: [q('mode', 'day | month | year | range'), q('date', 'YYYY-MM-DD (day) · YYYY-MM (month) · YYYY (year)'),
        q('from', 'YYYY-MM-DD (range)'), q('to', 'YYYY-MM-DD (range)'), q('cat', 'new,os,hardware,network,software,firmware,info,removed'), q('dept', 'หน่วยงาน'), q('assetId', 'รหัสเครื่อง'), q('q', 'ค้นหา')] }) },
      '/inventory/software': { get: op('ทะเบียนคอมพิวเตอร์', 'ค้นหาโปรแกรมที่ติดตั้งในทุกเครื่อง', 'viewer', { params: [q('q', 'ชื่อโปรแกรม (อย่างน้อย 2 ตัวอักษร)', { type: 'string' }, true)] }) },
      '/ipscan': { get: op('สแกน IP', 'ช่วง IP + สรุปผลสแกนเทียบทะเบียน', 'viewer') },
      '/ipscan/ranges/{id}': { get: op('สแกน IP', 'ผลสแกนรายช่วง (IP ที่พบ + การจับคู่ + เครื่องในทะเบียนที่ไม่พบ)', 'viewer', { params: [pid('id', 'รหัสช่วง IP')] }) },
      '/ipscan/run': { post: op('สแกน IP', 'สั่งสแกน (ทุกช่วง หรือระบุ rangeIds)', 'operator', { body: body({ type: 'object', properties: { rangeIds: { type: 'array', items: { type: 'string' } } } }, {}) }) },
      '/devices': {
        get: op('อุปกรณ์', 'รายการอุปกรณ์พร้อมสถานะล่าสุด', 'viewer', { params: [q('status', 'online | warning | offline | maintenance | disabled'), q('type', 'ประเภท เช่น switch, server'), q('q', 'ค้นหาชื่อ/IP/ตำแหน่ง')],
          ok: json({ type: 'object', properties: { total: { type: 'integer' }, devices: { type: 'array', items: ref('Device') } } }) }),
        post: op('อุปกรณ์', 'เพิ่มอุปกรณ์', 'operator', { body: body(ref('DeviceInput'), { name: 'SW-OPD-02', ip: '10.0.31.3', type: 'switch', vendor: 'Aruba', location: 'OPD ชั้น 2', vlan: '31' }), ok: json({ type: 'object', properties: { device: ref('Device') } }) }),
      },
      '/devices/{id}': {
        get: op('อุปกรณ์', 'ข้อมูลอุปกรณ์ 1 ตัว (รวมประวัติ latency)', 'viewer', { params: [pid('id', 'รหัสอุปกรณ์ (ตัวเลข)')] }),
        put: op('อุปกรณ์', 'แก้ไขอุปกรณ์ (ส่งข้อมูลครบทุกช่อง)', 'operator', { params: [pid()], body: body(ref('DeviceInput')) }),
        delete: op('อุปกรณ์', 'ลบอุปกรณ์', 'operator', { params: [pid()] }),
      },
      '/devices/{id}/check': { post: op('อุปกรณ์', 'สั่งตรวจอุปกรณ์ทันที', 'viewer', { params: [pid()] }) },
      '/devices/bulk': { post: op('อุปกรณ์', 'นำเข้าหลายรายการ (CSV)', 'operator', { body: body({ type: 'object', properties: { text: { type: 'string', description: 'name,ip,type,vendor,model,location,vlan,uplink,tcp_port' } } }) }) },
      '/export.csv': { get: op('อุปกรณ์', 'ส่งออกรายการอุปกรณ์เป็น CSV', 'viewer') },
      '/alerts': { get: op('แจ้งเตือน', 'รายการแจ้งเตือน', 'viewer', { params: [q('status', 'active | acknowledged | resolved | open (ยังไม่ปิด)'), q('severity', 'critical | warning | info'), q('limit', 'จำนวนสูงสุด (ค่าเริ่มต้น 100)', { type: 'integer' })],
        ok: json({ type: 'object', properties: { total: { type: 'integer' }, alerts: { type: 'array', items: ref('Alert') } } }) }) },
      '/alerts/{id}/ack': { post: op('แจ้งเตือน', 'รับทราบการแจ้งเตือน', 'operator', { params: [pid()] }) },
      '/alerts/{id}/resolve': { post: op('แจ้งเตือน', 'ปิดเรื่องการแจ้งเตือน', 'operator', { params: [pid()] }) },
      '/reports': { get: op('รายงาน', 'รายงานสถิติ รายวัน/เดือน/ปี (ต้องตั้งค่า MySQL log)', 'viewer', { params: [q('mode', 'day | month | year'), q('date', 'YYYY-MM-DD / YYYY-MM / YYYY'), q('device', 'รหัสอุปกรณ์'), q('type', 'ประเภทอุปกรณ์')] }) },
      '/dbsync': { get: op('ฐานข้อมูล Master/Slave', 'สถานะ Replication และผล Custom Query ล่าสุด', 'viewer') },
      '/dbsync/history': { get: op('ฐานข้อมูล Master/Slave', 'ประวัติ Replication Delay', 'viewer', { params: [q('hours', 'ย้อนหลังกี่ชั่วโมง (1–744)', { type: 'integer' })] }) },
      '/dbsync/run': { post: op('ฐานข้อมูล Master/Slave', 'สั่งตรวจทันที', 'operator') },
      '/wazuh': { get: op('Wazuh', 'ข้อมูลล่าสุดจาก Wazuh (Manager, Agents, SCA, CIS-CAT, สถิติ)', 'viewer') },
      '/wazuh/refresh': { post: op('Wazuh', 'ดึงข้อมูลจาก Wazuh ทันที', 'operator') },
      '/integrations/wazuh': { post: op('Wazuh', 'รับ alert จาก Wazuh (ใช้กับสคริปต์ integration ของ Wazuh)', 'integration', {
        description: 'ส่ง alert ของ Wazuh (รูปแบบ JSON ของ alerts.json) 1 รายการ หรือ `{ "alerts": [...] }` ระบบจะสร้างการแจ้งเตือนและส่งต่อหมอพร้อมตามเกณฑ์ level ที่ตั้งไว้',
        body: body({ type: 'object' }, { timestamp: '2026-11-05T09:00:00.000+0700', rule: { level: 10, description: 'Multiple authentication failures', id: '40111', groups: ['authentication_failures'] }, agent: { id: '003', name: 'his-db-01', ip: '172.16.1.10' }, location: '/var/log/secure', full_log: '...' }) }) },
      '/backup/export': { post: op('สำรองข้อมูล', 'สร้างไฟล์สำรองการตั้งค่าทั้งหมด', 'admin', { body: body({ type: 'object', properties: { includeAlerts: { type: 'boolean' }, passphrase: { type: 'string', description: 'ถ้าใส่ ไฟล์จะถูกเข้ารหัส AES-256-GCM' } } }) }) },
      '/openapi.json': { get: op('ระบบ', 'OpenAPI specification นี้', null, { public: true }) },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'stk_…', description: 'API Key จากหน้า ตั้งค่า → API' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'nms_sid', description: 'Session จากการล็อกอินหน้าเว็บ' },
      },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'string', example: 'กรุณาเข้าสู่ระบบ' } } },
        Health: { type: 'object', properties: { status: { type: 'string', example: 'ok' }, version: { type: 'string' }, uptimeSec: { type: 'integer' }, devices: { type: 'integer' }, cycle: { type: 'integer' } } },
        DeviceInput: { type: 'object', required: ['name', 'ip'], properties: {
          name: { type: 'string' }, ip: { type: 'string', description: 'IP หรือ hostname' }, type: { type: 'string', example: 'switch' },
          method: { type: 'string', enum: ['icmp', 'tcp'] }, port: { type: 'integer', description: 'เมื่อ method = tcp' }, vendor: { type: 'string' }, model: { type: 'string' },
          code: { type: 'string' }, location: { type: 'string' }, vlan: { type: 'string' }, parentId: { type: 'integer', nullable: true, description: 'Uplink' },
          linkLabel: { type: 'string' }, mac: { type: 'string' }, description: { type: 'string' }, critical: { type: 'boolean' }, maintenance: { type: 'boolean' },
          enabled: { type: 'boolean' }, notify: { type: 'boolean' } } },
        Device: { allOf: [ref('DeviceInput'), { type: 'object', properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['online', 'warning', 'offline', 'maintenance', 'disabled', 'unknown'] },
          latency: { type: 'number', nullable: true, description: 'ms' }, loss: { type: 'integer', nullable: true, description: '% ใน 20 รอบล่าสุด' }, lastCheck: { type: 'integer', description: 'epoch ms' } } }] },
        Alert: { type: 'object', properties: { id: { type: 'integer' }, deviceId: { type: 'integer' }, deviceName: { type: 'string' }, ip: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'warning', 'info'] }, kind: { type: 'string' }, message: { type: 'string' },
          status: { type: 'string', enum: ['active', 'acknowledged', 'resolved'] }, created: { type: 'integer' }, resolvedAt: { type: 'integer', nullable: true } } },
      },
    },
  };
};
