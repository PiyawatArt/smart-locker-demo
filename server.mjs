// server.mjs — Smart Locker MVP + LINE + Rich Menu + Real-time (SSE) + Dual status (QR & Door)
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
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title><link rel="icon" href="data:,">
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto;max-width:720px;margin:32px auto;padding:0 16px;line-height:1.6}
  .card{border:1px solid #ddd;border-radius:12px;padding:20px;margin:16px 0}
  .btn{display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid #ccc;text-decoration:none}
  .ok{background:#e6ffed;border-color:#b7f5c0}
  .warn{background:#fff8e1;border-color:#ffe08a}
  .err{background:#ffe8e8;border-color:#ffb3b3}
  .muted{color:#555}
  .mono{font-family: ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid #ddd;font-size:12px}
  .pill.ok{background:#e6ffed;border-color:#b7f5c0}
  .pill.err{background:#ffe8e8;border-color:#ffb3b3}
</style>
</head>
<body>
${body}
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
  res.send(htmlPage("Smart Locker MVP", `
    <h1>Smart Locker MVP</h1>
    <div class="card">
      <p>เมนู LINE: เปิด/ปิด QR, สถานะ, ปลดล็อก → เว็บอัปเดต <b>real-time</b></p>
      <p class="muted">ENV: <span class="mono">BASE_URL</span>, <span class="mono">LINE_CHANNEL_ACCESS_TOKEN</span>, <span class="mono">OWNER_USER_ID</span></p>
      <p>
        <a class="btn" href="/scan?locker_id=LOCKER001">ส่งคำขอเปิดตู้ Locker</a>
        <a class="btn" href="/locker?locker_id=LOCKER001">ดูสถานะตู้ (real-time)</a>
      </p>
    </div>
  `));
});

// ผู้มาเยือนสแกน -> สร้าง request
app.get("/scan", async (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const locker = getLocker(locker_id);

  if (locker.disabled) {
    res.send(htmlPage("Locker disabled", `
      <div class="card err"><h2>⛔ ปิดรับคำขอชั่วคราว</h2><p>ตู้ <b>${locker_id}</b> ถูกปิดโดยเจ้าของ</p></div>
    `));
    return;
  }

  const request_id = nanoid(10);
  requests.set(request_id, { locker_id, status: "pending", createdAt: Date.now() });
  await notifyOwnerNewRequest(request_id, locker_id);

  const statusUrl = `${BASE_URL}/status?request_id=${encodeURIComponent(request_id)}`;
  const scripts = `
    const out = document.getElementById('status');
    const rid = ${JSON.stringify(request_id)};
    const es = new EventSource('/status-stream?request_id=' + encodeURIComponent(rid));
    es.addEventListener('update', (ev) => {
      const data = JSON.parse(ev.data);
      if (data?.payload?.status) {
        out.textContent = data.payload.status;
        if (['approved','denied','closed'].includes(data.payload.status)) {
          document.getElementById('done').style.display = 'block';
        }
      }
    });
  `;
  res.send(htmlPage("รออนุมัติ (Real-time)", `
    <div class="card">
      <h2>📨 ส่งคำขอไปยังเจ้าของแล้ว</h2>
      <p>request_id: <span class="mono">${request_id}</span></p>
      <p>สถานะ (real-time): <span id="status" class="pill">pending</span></p>
      <div id="done" style="display:none;margin-top:8px">
        <a class="btn" href="${statusUrl}">ดูสรุปผล</a>
      </div>
    </div>
  `, scripts));
});

// หน้าสรุปสถานะคำขอ
app.get("/status", (req, res) => {
  const rid = (req.query.request_id || "").toString();
  if (!rid || !requests.has(rid)) {
    res.status(404).send(htmlPage("ไม่พบคำขอ", `<div class="card err"><h2>❌ ไม่พบ request_id นี้</h2></div>`));
    return;
  }
  const reqObj = requests.get(rid);
  const mapTxt = {
    pending: "กำลังรอเจ้าของตัดสินใจ…",
    approved: "✅ อนุมัติแล้ว (เดโม: ถือว่าเปิดตู้สำเร็จ)",
    denied: "❌ ถูกปฏิเสธ",
    closed: "⛔ ปิดคำขอ"
  };
  res.send(htmlPage("สถานะคำขอ", `
    <div class="card">
      <h2>สถานะคำขอ</h2>
      <p>request_id: <span class="mono">${rid}</span></p>
      <p>ตู้: <b>${reqObj.locker_id}</b></p>
      <p>สถานะ: <b>${reqObj.status}</b> — ${mapTxt[reqObj.status] || ""}</p>
    </div>
  `));
});

// หน้า “สถานะตู้” (QR + Door) แบบ real-time
app.get("/locker", (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const l = getLocker(locker_id);
  const scripts = `
    const lid = ${JSON.stringify(locker_id)};
    const qrBadge   = document.getElementById('qrStatus');
    const doorBadge = document.getElementById('doorStatus');
    const es = new EventSource('/locker-stream?locker_id=' + encodeURIComponent(lid));
    es.addEventListener('update', (ev) => {
      const data = JSON.parse(ev.data)?.payload;
      if (!data) return;
      // QR
      qrBadge.textContent = data.disabled ? 'QR: DISABLED' : 'QR: ENABLED';
      qrBadge.className = 'pill ' + (data.disabled ? 'err' : 'ok');
      // Door
      doorBadge.textContent = data.doorOpen ? 'DOOR: OPEN' : 'DOOR: CLOSED';
      doorBadge.className = 'pill ' + (data.doorOpen ? 'ok' : '');
    });
  `;
  res.send(htmlPage("สถานะตู้ (Real-time)", `
    <div class="card">
      <h2>ตู้ <span class="mono">${locker_id}</span></h2>
      <p>
        <span id="qrStatus" class="pill ${l.disabled ? 'err' : 'ok'}">${l.disabled ? 'QR: DISABLED' : 'QR: ENABLED'}</span>
        &nbsp;
        <span id="doorStatus" class="pill ${l.doorOpen ? 'ok' : ''}">${l.doorOpen ? 'DOOR: OPEN' : 'DOOR: CLOSED'}</span>
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
    res.send(htmlPage("QR Disabled", `
      <div class="card warn"><h2>⛔ ปิดรับคำขอของตู้ ${id}</h2>
      <p>เปิดใหม่ที่ <a href="/enable?locker_id=${id}">/enable?locker_id=${id}</a></p></div>
    `));
    return;
  }

  const rid = (request_id || "").toString();
  if (!rid || !requests.has(rid)) {
    res.status(404).send(htmlPage("Not found", `<div class="card err"><h2>❌ ไม่พบคำขอ</h2></div>`));
    return;
  }

  const reqObj = requests.get(rid);
  if (reqObj.status !== "pending") {
    res.send(htmlPage("Already decided", `
      <div class="card warn"><h2>คำขอถูกตัดสินใจแล้ว</h2><p>สถานะ: <b>${reqObj.status}</b></p></div>
    `));
    return;
  }

  if (act === "approve") {
    reqObj.status = "approved";
    publishRequestUpdate(rid);
    await linePush(OWNER_USER_ID, { type: "text", text: `✅ อนุมัติคำขอ ${rid} ของตู้ ${reqObj.locker_id}` });
    res.send(htmlPage("Approved", `<div class="card ok"><h2>✅ อนุมัติสำเร็จ</h2><p>request_id: <span class="mono">${rid}</span></p></div>`));
    return;
  }

  if (act === "deny") {
    reqObj.status = "denied";
    publishRequestUpdate(rid);
    await linePush(OWNER_USER_ID, { type: "text", text: `❌ ปฏิเสธคำขอ ${rid} ของตู้ ${reqObj.locker_id}` });
    res.send(htmlPage("Denied", `<div class="card err"><h2>❌ ปฏิเสธแล้ว</h2><p>request_id: <span class="mono">${rid}</span></p></div>`));
    return;
  }

  res.status(400).send(htmlPage("Bad request", `<div class="card err"><h2>action ไม่ถูกต้อง</h2></div>`));
});

// เปิด QR ใหม่ (URI)
app.get("/enable", async (req, res) => {
  const locker_id = (req.query.locker_id || "LOCKER001").toString();
  const locker = getLocker(locker_id);
  locker.disabled = false;
  publishLockerUpdate(locker_id);
  await linePush(OWNER_USER_ID, { type: "text", text: `✅ เปิด QR ของตู้ ${locker_id} แล้ว` });
  res.send(htmlPage("Enabled", `
    <div class="card ok"><h2>✅ เปิดรับคำขอของตู้ ${locker_id}</h2>
    <p><a class="btn" href="/locker?locker_id=${locker_id}">หน้าสถานะตู้ (real-time)</a></p></div>
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
    return res.send(htmlPage("Door Open", `<div class="card ok"><h2>🔓 ประตู ${locker_id} เปิด</h2></div>`));
  }
  if (action === "close") {
    l.doorOpen = false;
    publishLockerUpdate(locker_id);
    return res.send(htmlPage("Door Close", `<div class="card warn"><h2>🔒 ประตู ${locker_id} ปิด</h2></div>`));
  }
  return res.status(400).send(htmlPage("Bad request", `<div class="card err"><h2>action ต้องเป็น open|close</h2></div>`));
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
    // เดโม: เปิดประตู 10 วินาทีแล้วปิดเอง
    const l = getLocker(id);
    l.doorOpen = true;
publishLockerUpdate(id);
await lineReply(replyToken, { type: "text", text: `🔓 ปลดล็อกตู้ ${id}\nrequest_id: ${rid}\n` });
    publishRequestUpdate(rid);
    return;
  }

  // เมนูช่วยเหลือ
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
  console.log(`🚀 Smart Locker MVP (real-time, dual status) on http://localhost:${PORT}`);
  console.log(`   Public base: ${BASE_URL}`);
  console.log(`   Webhook URL: ${BASE_URL}/webhook`);
});
