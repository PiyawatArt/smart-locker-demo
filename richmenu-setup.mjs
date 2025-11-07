// richmenu-setup.mjs
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const DEFAULT_LOCKER_ID = process.env.DEFAULT_LOCKER_ID || 'LOCKER001';

// ตั้งชื่อไฟล์รูปที่นี่ (PNG/JPG ขนาด 2500x843 หรือ 2500x1686, ขนาดไฟล์ ≤ 1MB)
const IMAGE_PATH = './richmenu.png';

if (!LINE_TOKEN) {
  console.error('❌ Missing LINE_CHANNEL_ACCESS_TOKEN');
  process.exit(1);
}

async function jfetch(url, opts = {}) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${opts.method || 'GET'} ${url} -> ${res.status}: ${t}`);
  }
  return res;
}

function detectMimeByExt(p) {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  throw new Error('รองรับเฉพาะ .png หรือ .jpg เท่านั้น');
}

async function createRichMenu() {
  // สร้างเมนู 2x2 (2500x843)
  const body = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'SmartLockerMenu',
    chatBarText: 'เมนูควบคุมตู้',
    areas: [
      // ซ้ายบน: enable
      {
        bounds: { x: 0, y: 0, width: 1250, height: 421 },
        action: { type: 'postback', data: `action=enable&locker_id=${DEFAULT_LOCKER_ID}`, displayText: '✅ เปิด QR' }
      },
      // ขวาบน: disable
      {
        bounds: { x: 1250, y: 0, width: 1250, height: 421 },
        action: { type: 'postback', data: `action=disable&locker_id=${DEFAULT_LOCKER_ID}`, displayText: '⛔ ปิด QR' }
      },
      // ซ้ายล่าง: status
      {
        bounds: { x: 0, y: 421, width: 1250, height: 422 },
        action: { type: 'postback', data: `action=status&locker_id=${DEFAULT_LOCKER_ID}`, displayText: 'ℹ️ สถานะ' }
      },
      // ขวาล่าง: unlock
      {
        bounds: { x: 1250, y: 421, width: 1250, height: 422 },
        action: { type: 'postback', data: `action=unlock&locker_id=${DEFAULT_LOCKER_ID}`, displayText: '🔓 ปลดล็อก' }
      }
    ]
  };

  const res = await jfetch('https://api.line.me/v2/bot/richmenu', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return data.richMenuId;
}

async function uploadRichMenuImage(richMenuId, imagePath) {
  const fileBuffer = await fs.readFile(imagePath);
  const mime = detectMimeByExt(imagePath);

  // เช็คขนาดไฟล์ (≤ 1MB)
  const sizeKB = Math.round(fileBuffer.length / 1024);
  if (fileBuffer.length > 1024 * 1024) {
    throw new Error(`ไฟล์ใหญ่เกินไป (${sizeKB} KB) — บีบอัดให้ ≤ 1024 KB และขนาดภาพ 2500x843/2500x1686`);
  }

  // อัปโหลดรูปต้องใช้ api-data.line.me
  await jfetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': mime,
      'Content-Length': String(fileBuffer.length)
    },
    body: fileBuffer
  });
}

async function setDefaultRichMenu(richMenuId) {
  await jfetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
  });
}

async function listRichMenus() {
  const res = await jfetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
  });
  const data = await res.json();
  return data.richmenus || [];
}

async function deleteRichMenu(id) {
  await jfetch(`https://api.line.me/v2/bot/richmenu/${id}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${LINE_TOKEN}` }
  });
}

const cmd = process.argv[2] || 'setup';

(async () => {
  try {
    if (cmd === 'list') {
      const list = await listRichMenus();
      console.log('Rich menus:', list.map(m => ({ id: m.richMenuId, name: m.name, size: m.size })));
      process.exit(0);
    }

    if (cmd === 'clean') {
      const list = await listRichMenus();
      for (const m of list) {
        console.log('Deleting', m.richMenuId, m.name);
        await deleteRichMenu(m.richMenuId);
      }
      console.log('✅ Cleaned all rich menus.');
      process.exit(0);
    }

    // default: setup
    console.log('Creating rich menu…');
    const id = await createRichMenu();
    console.log('Rich menu id:', id);

    console.log('Uploading image… (richmenu.png/.jpg ต้องเป็น 2500x843 หรือ 2500x1686 และ ≤ 1MB)');
    await uploadRichMenuImage(id, IMAGE_PATH);

    console.log('Setting as default…');
    await setDefaultRichMenu(id);

    console.log('✅ Done. Rich menu is set as default.');
  } catch (e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
