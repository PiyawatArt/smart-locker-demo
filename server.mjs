// server.mjs — DROPMATE + LINE + Rich Menu + Real-time (SSE) + Dual status (QR & Door)
import 'dotenv/config';
import express from 'express';
import { nanoid } from 'nanoid';

const PORT  = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OWNER_USER_ID = process.env.OWNER_USER_ID;

if (!BASE_URL || !LINE_TOKEN || !OWNER_USER_ID) {
  console.error("❌ Missing env: BASE_URL / LINE_CHANNEL_ACCESS_TOKEN / OWNER_USER_ID");
  process.exit(1);
}

const app = express();
app.use(express.json());

// ====== In-memory stores ======
/** lockers: locker_id -> { disabled:boolean, doorOpen:boolean } */
const lockers = new Map();
/** requests: request_id -> { locker_id, status:'pending'|'approved'|'denied'|'closed', createdAt:number } */
const requests = new Map();

// ====== SSE subscribers ======
const reqSubs = new Map();    // request_id -> Set<res>
const lockerSubs = new Map(); // locker_id  -> Set<res>

function getLocker(locker_id = "LOCKER001") {
  if (!lockers.has(locker_id)) lockers.set(locker_id, { disabled: false, doorOpen: false });
  return lockers.get(locker_id);
}

function htmlPage(title, body, scripts = "") {
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<link rel="icon" href="data:,">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    background: linear-gradient(135deg, #E3F2FD 0%, #BBDEFB 100%);
    min-height: 100vh;
    padding: 20px;
    line-height: 1.6;
  }
  
  .container {
    max-width: 480px;
    margin: 0 auto;
  }
  
  .header {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 20px;
    padding: 24px;
    margin-bottom: 20px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    text-align: center;
  }
  
  .header h1 {
    font-size: 28px;
    color: #1976D2;
    margin-bottom: 8px;
    font-weight: 700;
  }
  
  .header p {
    color: #64748b;
    font-size: 14px;
  }
  
  .card {
    background: rgba(255, 255, 255, 0.95);
    backdrop-filter: blur(10px);
    border-radius: 20px;
    padding: 28px;
    margin-bottom: 16px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
  }
  
  .card h2 {
    font-size: 22px;
    margin-bottom: 16px;
    color: #1e293b;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  
  .card h2::before {
    content: '';
    display: inline-block;
    width: 4px;
    height: 24px;
    background: linear-gradient(135deg, #90CAF9 0%, #64B5F6 100%);
    border-radius: 2px;
  }
  
  .card p {
    color: #475569;
    margin-bottom: 12px;
    font-size: 15px;
  }
  
  .card.ok {
    background: linear-gradient(135deg, #E8F5E9 0%, #C8E6C9 100%);
    border: none;
    color: #2E7D32;
  }
  
  .card.ok h2, .card.ok p {
    color: #2E7D32;
  }
  
  .card.warn {
    background: linear-gradient(135deg, #FFF8E1 0%, #FFE082 100%);
    border: none;
    color: #F57F17;
  }
  
  .card.warn h2, .card.warn p {
    color: #F57F17;
  }
  
  .card.err {
    background: linear-gradient(135deg, #FFEBEE 0%, #FFCDD2 100%);
    border: none;
    color: #C62828;
  }
  
  .card.err h2, .card.err p, .card.err .mono {
    color: #C62828;
  }
  
  .btn {
    display: inline-block;
    padding: 14px 28px;
    border-radius: 12px;
    text-decoration: none;
    font-weight: 600;
    font-size: 15px;
    transition: all 0.3s ease;
    border: none;
    cursor: pointer;
    text-align: center;
    background: linear-gradient(135deg, #90CAF9 0%, #64B5F6 100%);
    color: white;
    box-shadow: 0 4px 15px rgba(100, 181, 246, 0.3);
  }
  
  .btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(100, 181, 246, 0.5);
  }
  
  .btn:active {
    transform: translateY(0);
  }
  
  .btn-group {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 16px;
  }
  
  .mono {
    font-family: 'Courier New', Courier, monospace;
    background: rgba(100, 181, 246, 0.15);
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
    color: #1976D2;
    font-weight: 600;
  }
  
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 600;
    border: 2px solid;
    margin: 4px;
  }
  
  .pill.ok {
    background: #E8F5E9;
    border-color: #66BB6A;
    color: #2E7D32;
  }
  
  .pill.err {
    background: #FFEBEE;
    border-color: #EF5350;
    color: #C62828;
  }
  
  .pill.pending {
    background: #fef3c7;
    border-color: #f59e0b;
    color: #92400e;
  }
  
  .status-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
    margin-top: 16px;
  }
  
  .status-box {
    background: rgba(100, 181, 246, 0.08);
    padding: 16px;
    border-radius: 12px;
    text-align: center;
    border: 2px solid rgba(100, 181, 246, 0.2);
  }
  
  .status-box .label {
    font-size: 12px;
    color: #64748b;
    margin-bottom: 8px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }
  
  .status-box .value {
    font-size: 18px;
    font-weight: 700;
    color: #1e293b;
  }
  
  .icon {
    font-size: 48px;
    margin: 20px 0;
    text-align: center;
  }
  
  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 3px solid rgba(100, 181, 246, 0.3);
    border-radius: 50%;
    border-top-color: #64B5F6;
    animation: spin 0.8s linear infinite;
  }
  
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  
  .muted {
    color: #94a3b8;
    font-size: 13px;
  }
  
  #done {
    margin-top: 20px;
    padding-top: 20px;
    border-top: 2px dashed rgba(100, 181, 246, 0.3);
  }
  
  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 0;
    border-bottom: 1px solid rgba(0, 0, 0, 0.05);
  }
  
  .info-row:last-child {
    border-bottom: none;
  }
  
  .info-label {
    font-weight: 600;
    color: #64748b;
  }
  
  .info-value {
    font-weight: 700;
    color: #1e293b;
  }
</style>
</head>
<body>
<div class="container">
${body}
</div>
<script>${scripts}</script>
</body>
</html>`;
}

// ====== LINE helpers ======
async function linePush(toUserId, messages) {
  const payload = { to: toUserId, messages: Array.isArray(messages) ? messages : [messages] };
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error("LINE push error:", res.status, await res.text());
}

async function lineReply(replyToken, messages) {
  const payload = { replyToken, messages: Array.isArray(messages) ? messages : [messages] };
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify(payload)
  });
  if (!res.ok) console.error("LINE reply error:", res.status, await res.text());
}

// ====== Notify owner for new request ======
async function notifyOwnerNewRequest(request_id, locker_id) {
  const approveUrl = `${BASE_URL}/decision?request_id=${encodeURIComponent(request_id)}&action=approve`;
  const denyUrl    = `${BASE_URL}/decision?request_id=${encodeURIComponent(request_id)}&action=deny`;
  const closeUrl   = `${BASE_URL}/decision?locker_id=${encodeURIComponent(locker_id)}&action=disable`;

  const msg = {
    type: "text",
    text: `📣 มีคำขอจากตู้ ${locker_id}\nrequest_id: ${request_id}\n\nต้องการอนุมัติไหม?`,
    quickReply: {
      items: [
        { type: "action", action: { type: "uri", label: "✅ อนุมัติ", uri: approveUrl } },
        { type: "action", action: { type: "uri", label: "❌ ปฏิเสธ", uri: denyUrl } },
        { type: "action", action: { type: "uri", label: "⛔ ปิด QR", uri: closeUrl } }
      ]
    }
  };
  await linePush(OWNER_USER_ID, msg);
}

// ====== SSE helpers ======
function sseHeaders(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 1500\n\n");
}

function publishRequestUpdate(request_id) {
  const subs = reqSubs.get(request_id);
  if (!subs) return;
  const data = JSON.stringify({ type: "request_update", payload: requests.get(request_id) });
  for (const res of subs) res.write(`event: update\ndata: ${data}\n\n`);
}

function publishLockerUpdate(locker_id) {
  const subs = lockerSubs.get(locker_id);
  if (!subs) return;
  const l = getLocker(locker_id);
  const data = JSON.stringify({ type: "locker_update", payload: { locker_id, disabled: l.disabled, doorOpen: l.doorOpen } });
  for (const res of subs) res.write(`event: update\ndata: ${data}\n\n`);
}

// ====== Pages ======
app.get("/", (req, res) => {
  res.send(htmlPage("DROPMATE", `
    <div class="header">
      <h1>📦 DROPMATE</h1>
      <p>ระบบจัดการตู้ล็อกเกอร์อัจฉริยะ</p>
    </div>
    
    <div class="card">
      <h2>💡 คุณสมบัติ</h2>
      <p>✨ เปิด/ปิด QR รับคำขอผ่าน LINE</p>
      <p>📊 ติดตามสถานะแบบ Real-time</p>
      <p>🔓 ปลดล็อกตู้จากระยะไกล</p>
      <p>⚡ อัปเดตสถานะทันที</p>
      
      <div class="btn-group">
        <a class="btn" href="/scan?locker_id=LOCKER001">📱 ส่งคำขอเปิดตู้</a>
        <a class="btn" href="/locker?locker_id=LOCKER001">📈 ดูสถานะตู้</a>
      </div>
    </div>
    
    <div class="card">
      <h2>📋 วิธีใช้งาน</h2>
      <p><strong>1.</strong> สแกน QR Code เพื่อขอเข้าใช้งานตู้</p>
      <p><strong>2.</strong> รอเจ้าของอนุมัติคำขอ</p>
      <p><strong>3.</strong> เมื่ออนุมัติแล้ว ตู้จะเปิดให้ใช้งาน</p>
      <p class="muted" style="text-align: center; margin-top: 16px;">
        💡 สถานะจะอัปเดตแบบเรียลไทม์
      </p>
    </div>
  `));
});

// ผู้มาเยือนสแกน -> สร้าง request
app.get("/scan", async (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const locker = getLocker(locker_id);

  if (locker.disabled) {
    res.send(htmlPage("ตู้ปิดใช้งาน", `
      <div class="card err">
        <div class="icon">⛔</div>
        <h2>ปิดรับคำขอชั่วคราว</h2>
        <p style="text-align: center;">ตู้ <span class="mono">${locker_id}</span> ถูกปิดโดยเจ้าของ</p>
        <p style="text-align: center;" class="muted">กรุณาติดต่อเจ้าของตู้</p>
      </div>
    `));
    return;
  }

  const request_id = nanoid(10);
  requests.set(request_id, { locker_id, status: "pending", createdAt: Date.now() });
  await notifyOwnerNewRequest(request_id, locker_id);

  const statusUrl = `${BASE_URL}/status?request_id=${encodeURIComponent(request_id)}`;
  const scripts = `
    const out = document.getElementById('status');
    const icon = document.getElementById('statusIcon');
    const doneBox = document.getElementById('done');
    const rid = ${JSON.stringify(request_id)};
    const es = new EventSource('/status-stream?request_id=' + encodeURIComponent(rid));
    
    es.addEventListener('update', (ev) => {
      const data = JSON.parse(ev.data);
      if (data?.payload?.status) {
        const status = data.payload.status;
        out.textContent = status;
        
        if (status === 'approved') {
          out.className = 'pill ok';
          out.textContent = '✅ อนุมัติแล้ว';
          icon.textContent = '🎉';
          doneBox.style.display = 'block';
        } else if (status === 'denied') {
          out.className = 'pill err';
          out.textContent = '❌ ถูกปฏิเสธ';
          icon.textContent = '😔';
          doneBox.style.display = 'block';
        } else if (status === 'closed') {
          out.className = 'pill err';
          out.textContent = '⛔ ปิดคำขอ';
          icon.textContent = '🚫';
          doneBox.style.display = 'block';
        }
      }
    });
  `;
  
  res.send(htmlPage("รออนุมัติ", `
    <div class="card">
      <div class="icon" id="statusIcon">⏳</div>
      <h2>ส่งคำขอแล้ว</h2>
      
      <div class="info-row">
        <span class="info-label">Request ID:</span>
        <span class="mono">${request_id}</span>
      </div>
      
      <div class="info-row">
        <span class="info-label">ตู้:</span>
        <span class="info-value">${locker_id}</span>
      </div>
      
      <div style="text-align: center; margin-top: 20px;">
        <p class="muted" style="margin-bottom: 12px;">สถานะปัจจุบัน</p>
        <span id="status" class="pill pending">
          <span class="spinner"></span>
          รอเจ้าของตอบกลับ
        </span>
      </div>
      
      <div id="done" style="display:none;">
        <a class="btn" href="${statusUrl}">📋 ดูรายละเอียดผล</a>
      </div>
    </div>
  `, scripts));
});

// หน้าสรุปสถานะคำขอ
app.get("/status", (req, res) => {
  const rid = (req.query.request_id || "").toString();
  if (!rid || !requests.has(rid)) {
    res.status(404).send(htmlPage("ไม่พบคำขอ", `
      <div class="card err">
        <div class="icon">❓</div>
        <h2>ไม่พบคำขอนี้</h2>
        <p style="text-align: center;">ไม่พบ Request ID ในระบบ</p>
      </div>
    `));
    return;
  }
  
  const reqObj = requests.get(rid);
  const statusMap = {
    pending: { text: 'กำลังรอเจ้าของตัดสินใจ...', icon: '⏳', class: 'pending' },
    approved: { text: 'อนุมัติแล้ว (ตู้เปิดสำเร็จ)', icon: '✅', class: 'ok' },
    denied: { text: 'ถูกปฏิเสธโดยเจ้าของ', icon: '❌', class: 'err' },
    closed: { text: 'ปิดคำขอ', icon: '⛔', class: 'err' }
  };
  
  const statusInfo = statusMap[reqObj.status] || statusMap.pending;
  const cardClass = reqObj.status === 'approved' ? 'ok' : reqObj.status === 'pending' ? '' : 'err';
  
  res.send(htmlPage("สถานะคำขอ", `
    <div class="card ${cardClass}">
      <div class="icon">${statusInfo.icon}</div>
      <h2>สถานะคำขอ</h2>
      
      <div class="info-row">
        <span class="info-label">Request ID:</span>
        <span class="mono">${rid}</span>
      </div>
      
      <div class="info-row">
        <span class="info-label">ตู้:</span>
        <span class="info-value">${reqObj.locker_id}</span>
      </div>
      
      <div style="text-align: center; margin-top: 20px;">
        <span class="pill ${statusInfo.class}">${statusInfo.text}</span>
      </div>
    </div>
  `));
});

// หน้า "สถานะตู้" (QR + Door) แบบ real-time
app.get("/locker", (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const l = getLocker(locker_id);
  
  const scripts = `
    const lid = ${JSON.stringify(locker_id)};
    const qrBox = document.getElementById('qrBox');
    const doorBox = document.getElementById('doorBox');
    
    const es = new EventSource('/locker-stream?locker_id=' + encodeURIComponent(lid));
    es.addEventListener('update', (ev) => {
      const data = JSON.parse(ev.data)?.payload;
      if (!data) return;
      
      // QR Status
      if (data.disabled) {
        qrBox.innerHTML = '<div class="label">QR CODE</div><div class="value" style="color: #C62828;">🔴 ปิด</div>';
        qrBox.style.borderColor = '#FFCDD2';
        qrBox.style.background = '#FFEBEE';
      } else {
        qrBox.innerHTML = '<div class="label">QR CODE</div><div class="value" style="color: #2E7D32;">🟢 เปิด</div>';
        qrBox.style.borderColor = '#C8E6C9';
        qrBox.style.background = '#E8F5E9';
      }
      
      // Door Status
      if (data.doorOpen) {
        doorBox.innerHTML = '<div class="label">ประตู</div><div class="value" style="color: #2E7D32;">🔓 เปิด</div>';
        doorBox.style.borderColor = '#C8E6C9';
        doorBox.style.background = '#E8F5E9';
      } else {
        doorBox.innerHTML = '<div class="label">ประตู</div><div class="value" style="color: #64748b;">🔒 ปิด</div>';
        doorBox.style.borderColor = 'rgba(100, 181, 246, 0.2)';
        doorBox.style.background = 'rgba(100, 181, 246, 0.08)';
      }
    });
  `;
  
  const qrColor = l.disabled ? 'color: #C62828;' : 'color: #2E7D32;';
  const qrBg = l.disabled ? 'background: #FFEBEE; border-color: #FFCDD2;' : 'background: #E8F5E9; border-color: #C8E6C9;';
  const doorColor = l.doorOpen ? 'color: #2E7D32;' : 'color: #64748b;';
  const doorBg = l.doorOpen ? 'background: #E8F5E9; border-color: #C8E6C9;' : '';
  
  res.send(htmlPage("สถานะตู้", `
    <div class="header">
      <h1>📊 สถานะตู้</h1>
      <p class="mono">${locker_id}</p>
    </div>
    
    <div class="card">
      <h2>Real-time Status</h2>
      
      <div class="status-grid">
        <div class="status-box" id="qrBox" style="${qrBg}">
          <div class="label">QR CODE</div>
          <div class="value" style="${qrColor}">${l.disabled ? '🔴 ปิด' : '🟢 เปิด'}</div>
        </div>
        
        <div class="status-box" id="doorBox" style="${doorBg}">
          <div class="label">ประตู</div>
          <div class="value" style="${doorColor}">${l.doorOpen ? '🔓 เปิด' : '🔒 ปิด'}</div>
        </div>
      </div>
      
      <p class="muted" style="text-align: center; margin-top: 20px;">
        🔄 อัปเดตแบบเรียลไทม์
      </p>
    </div>
  `, scripts));
});

// ====== SSE endpoints ======
app.get("/status-stream", (req, res) => {
  const rid = (req.query.request_id || "").toString();
  if (!rid || !requests.has(rid)) return res.sendStatus(404);
  sseHeaders(res);
  if (!reqSubs.has(rid)) reqSubs.set(rid, new Set());
  reqSubs.get(rid).add(res);
  res.write(`event: update\ndata: ${JSON.stringify({ type:'request_update', payload: requests.get(rid) })}\n\n`);
  req.on("close", () => { reqSubs.get(rid)?.delete(res); });
});

app.get("/locker-stream", (req, res) => {
  const lid = (req.query.locker_id || "LOCKER001").toString();
  sseHeaders(res);
  if (!lockerSubs.has(lid)) lockerSubs.set(lid, new Set());
  lockerSubs.get(lid).add(res);
  const l = getLocker(lid);
  res.write(`event: update\ndata: ${JSON.stringify({ type:'locker_update', payload: { locker_id: lid, disabled: l.disabled, doorOpen: l.doorOpen } })}\n\n`);
  req.on("close", () => { lockerSubs.get(lid)?.delete(res); });
});

// ====== ลิงก์ตัดสินใจ (URI) ======
app.get("/decision", async (req, res) => {
  const { request_id, action, locker_id } = req.query || {};
  const act = (action || "").toString();

  if (act === "disable") {
    const id = (locker_id || "").toString() || "LOCKER001";
    const locker = getLocker(id);
    locker.disabled = true;
    publishLockerUpdate(id);
    await linePush(OWNER_USER_ID, { type: "text", text: `⛔ ปิด QR ของตู้ ${id} แล้ว` });
    res.send(htmlPage("ปิด QR", `
      <div class="card warn">
        <div class="icon">⛔</div>
        <h2>ปิดรับคำขอแล้ว</h2>
        <p style="text-align: center;">ตู้ <span class="mono">${id}</span> ปิดรับคำขอชั่วคราว</p>
      </div>
    `));
    return;
  }

  const rid = (request_id || "").toString();
  if (!rid || !requests.has(rid)) {
    res.status(404).send(htmlPage("Not found", `
      <div class="card err">
        <div class="icon">❓</div>
        <h2>ไม่พบคำขอ</h2>
      </div>
    `));
    return;
  }

  const reqObj = requests.get(rid);
  if (reqObj.status !== "pending") {
    res.send(htmlPage("ตัดสินใจแล้ว", `
      <div class="card warn">
        <div class="icon">⚠️</div>
        <h2>คำขอถูกตัดสินใจแล้ว</h2>
        <p style="text-align: center;">สถานะ: <span class="pill">${reqObj.status}</span></p>
      </div>
    `));
    return;
  }

  if (act === "approve") {
    reqObj.status = "approved";
    publishRequestUpdate(rid);
    await linePush(OWNER_USER_ID, { type: "text", text: `✅ อนุมัติคำขอ ${rid} ของตู้ ${reqObj.locker_id}` });
    res.send(htmlPage("อนุมัติแล้ว", `
      <div class="card ok">
        <div class="icon">✅</div>
        <h2>อนุมัติสำเร็จ</h2>
        <p style="text-align: center;">คำขอ <span class="mono">${rid}</span></p>
        <p style="text-align: center;">ได้รับการอนุมัติแล้ว</p>
      </div>
    `));
    return;
  }

  if (act === "deny") {
    reqObj.status = "denied";
    publishRequestUpdate(rid);
    await linePush(OWNER_USER_ID, { type: "text", text: `❌ ปฏิเสธคำขอ ${rid} ของตู้ ${reqObj.locker_id}` });
    res.send(htmlPage("ปฏิเสธแล้ว", `
      <div class="card err">
        <div class="icon">❌</div>
        <h2>ปฏิเสธแล้ว</h2>
        <p style="text-align: center;">คำขอ <span class="mono">${rid}</span></p>
        <p style="text-align: center;">ถูกปฏิเสธแล้ว</p>
      </div>
    `));
    return;
  }

  res.status(400).send(htmlPage("Bad request", `
    <div class="card err">
      <div class="icon">⚠️</div>
      <h2>คำสั่งไม่ถูกต้อง</h2>
    </div>
  `));
});

// เปิด QR ใหม่ (URI)
app.get("/enable", async (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const locker = getLocker(locker_id);
  locker.disabled = false;
  publishLockerUpdate(locker_id);
  await linePush(OWNER_USER_ID, { type: "text", text: `✅ เปิด QR ของตู้ ${locker_id} แล้ว` });
  res.send(htmlPage("เปิดรับคำขอ", `
    <div class="card ok">
      <div class="icon">✅</div>
      <h2>เปิดรับคำขอแล้ว</h2>
      <p style="text-align: center;">ตู้ <span class="mono">${locker_id}</span></p>
      <div class="btn-group">
        <a class="btn" href="/locker?locker_id=${locker_id}">📊 ดูสถานะตู้</a>
      </div>
    </div>
  `));
});

// ====== Door demo endpoint (open/close) ======
app.get("/door", async (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const action = (req.query.action || "").toString();
  const l = getLocker(locker_id);
  if (action === "open") {
    l.doorOpen = true;
    publishLockerUpdate(locker_id);
    return res.send(htmlPage("เปิดประตู", `
      <div class="card ok">
        <div class="icon">🔓</div>
        <h2>เปิดประตูแล้ว</h2>
        <p style="text-align: center;">ตู้ <span class="mono">${locker_id}</span></p>
      </div>
    `));
  }
  if (action === "close") {
    l.doorOpen = false;
    publishLockerUpdate(locker_id);
    return res.send(htmlPage("ปิดประตู", `
      <div class="card warn">
        <div class="icon">🔒</div>
        <h2>ปิดประตูแล้ว</h2>
        <p style="text-align: center;">ตู้ <span class="mono">${locker_id}</span></p>
      </div>
    `));
  }
  return res.status(400).send(htmlPage("Bad request", `
    <div class="card err">
      <div class="icon">⚠️</div>
      <h2>คำสั่งไม่ถูกต้อง</h2>
      <p style="text-align: center;">action ต้องเป็น open หรือ close</p>
    </div>
  `));
});

// ====== LINE Webhook (ข้อความ + postback) ======
function parseLockerId(text) {
  const parts = (text || "").trim().split(/\s+/);
  if (parts.length >= 2) return parts[1];
  return "LOCKER001";
}

async function handleOwnerCommand(text, replyToken) {
  const t = (text || "").trim().toLowerCase();

  if (/^สถานะ(\s+.+)?$|^status(\s+.+)?$/.test(t)) {
    const id = parseLockerId(text);
    const l = getLocker(id);
    const qrTxt = l.disabled ? "ปิด QR" : "เปิดรับคำขอ";
    const doorTxt = l.doorOpen ? "ประตูเปิด" : "ประตูปิด";
    await lineReply(replyToken, { type: "text", text: `ℹ️ ตู้ ${id}\n• QR: ${qrTxt}\n• ตู้: ${doorTxt}` });
    return;
  }

  if (/(^ปิด$)|(^disable(\s+.+)?$)/.test(t)) {
    const id = parseLockerId(text);
    getLocker(id).disabled = true;
    publishLockerUpdate(id);
    await lineReply(replyToken, { type: "text", text: `⛔ ปิด QR ของตู้ ${id} แล้ว` });
    return;
  }

  if (/(^เปิด$)|(^enable(\s+.+)?$)/.test(t)) {
    const id = parseLockerId(text);
    getLocker(id).disabled = false;
    publishLockerUpdate(id);
    await lineReply(replyToken, { type: "text", text: `✅ เปิด QR ของตู้ ${id} แล้ว` });
    return;
  }

  if (/(^ปลดล็อก$)|(^unlock(\s+.+)?$)/.test(t)) {
    const id = parseLockerId(text);
    const rid = nanoid(10);
    requests.set(rid, { locker_id: id, status: "approved", createdAt: Date.now() });
    const l = getLocker(id);
    l.doorOpen = true;
    publishLockerUpdate(id);
    await lineReply(replyToken, { type: "text", text: `🔓 ปลดล็อกตู้ ${id}\nrequest_id: ${rid}\n` });
    publishRequestUpdate(rid);
    return;
  }

  await lineReply(replyToken, {
    type: "text",
    text:
`คำสั่ง:
• สถานะ [LOCKER_ID]  → แสดง QR & ประตู
• เปิด [LOCKER_ID]    → เปิด QR
• ปิด [LOCKER_ID]     → ปิด QR
• ปลดล็อก [LOCKER_ID] → เปิดประตูชั่วคราว
(ไม่ใส่ LOCKER_ID จะใช้ LOCKER001)`
  });
}

app.post("/webhook", async (req, res) => {
  try {
    const events = req.body?.events || [];
    for (const ev of events) {
      const fromOwner = ev.source?.userId === OWNER_USER_ID;

      if (ev.type === "message" && ev.message?.type === "text") {
        if (!fromOwner) {
          await lineReply(ev.replyToken, { type: "text", text: "บัญชีนี้ไม่ได้รับอนุญาตให้ควบคุมตู้" });
          continue;
        }
        await handleOwnerCommand(ev.message.text, ev.replyToken);
        continue;
      }

      if (ev.type === "postback") {
        if (!fromOwner) {
          if (ev.replyToken) await lineReply(ev.replyToken, { type: "text", text: "บัญชีนี้ไม่ได้รับอนุญาตให้ควบคุมตู้" });
          continue;
        }
        const data = Object.fromEntries(new URLSearchParams(ev.postback?.data || ""));
        const lockerId = (data.locker_id || "LOCKER001").toString();
        const action = (data.action || "").toLowerCase();

        if (action === "enable") {
          const l = getLocker(lockerId);
          l.disabled = false;
          publishLockerUpdate(lockerId);
          if (ev.replyToken) await lineReply(ev.replyToken, { type: "text", text: `✅ เปิด QR ของตู้ ${lockerId} แล้ว` });
          continue;
        }
        if (action === "disable") {
          const l = getLocker(lockerId);
          l.disabled = true;
          publishLockerUpdate(lockerId);
          if (ev.replyToken) await lineReply(ev.replyToken, { type: "text", text: `⛔ ปิด QR ของตู้ ${lockerId} แล้ว` });
          continue;
        }
        if (action === "status") {
          const l = getLocker(lockerId);
          const qrTxt = l.disabled ? "ปิด QR" : "เปิดรับคำขอ";
          const doorTxt = l.doorOpen ? "ประตูเปิด" : "ประตูปิด";
          if (ev.replyToken) await lineReply(ev.replyToken, { type: "text", text: `ℹ️ ตู้ ${lockerId}\n• QR: ${qrTxt}\n• ตู้: ${doorTxt}` });
          continue;
        }
        if (action === "unlock") {
          const rid = nanoid(10);
          requests.set(rid, { locker_id: lockerId, status: "approved", createdAt: Date.now() });
          const l = getLocker(lockerId);
          l.doorOpen = true;
          publishLockerUpdate(lockerId);
          if (ev.replyToken) await lineReply(ev.replyToken, { type: "text", text: `🔓 ปลดล็อกตู้ ${lockerId}\nrequest_id: ${rid}` });
          publishRequestUpdate(rid);
          continue;
        }
        if (ev.replyToken) await lineReply(ev.replyToken, { type: "text", text: "คำสั่งไม่ถูกต้อง" });
      }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("webhook error:", e);
    res.sendStatus(200);
  }
});

// ====== Start ======
app.listen(PORT, () => {
  console.log(`🚀 DROPMATE System (real-time, dual status) on http://localhost:${PORT}`);
  console.log(`   Public base: ${BASE_URL}`);
  console.log(`   Webhook URL: ${BASE_URL}/webhook`);
});