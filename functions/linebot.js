/**
 * ============================================================
 * LINE Messaging API 多輪對話機器人
 * 檔案位置：functions/linebot.js
 *
 * 整合架構：
 *   LINE App → Netlify Function → 狀態機
 *   → Google Sheets 查詢（文字 orderNo OR 圖片 Vision AI）
 *   → n8n Webhook → Google Sheets
 *
 * 你的設定：
 *   Netlify URL : https://ubiquitous-tiramisu-9b96d7.netlify.app
 *   LINE Webhook: https://ubiquitous-tiramisu-9b96d7.netlify.app/webhook
 * ============================================================
 */

'use strict';
const crypto = require('crypto');
const https  = require('https');

// ============================================================
// 設定（敏感資料請放到 Netlify 環境變數，不要寫死在這裡）
// ============================================================
const CFG = {
  LINE_CHANNEL_SECRET      : process.env.LINE_CHANNEL_SECRET       || '',
  LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
  N8N_WEBHOOK_URL          : process.env.N8N_WEBHOOK_URL           || '',
};

// ============================================================
// 狀態定義（State Machine）
// ============================================================
const S = {
  IDLE               : 'IDLE',
  ASKED_PURCHASE     : 'ASKED_PURCHASE',
  WAITING_ORDER      : 'WAITING_ORDER',
  CONFIRMING_1SHOP   : 'CONFIRMING_1SHOP',
  MANUAL_NAME        : 'MANUAL_NAME',
  MANUAL_GENDER      : 'MANUAL_GENDER',
  MANUAL_AGE         : 'MANUAL_AGE',
  MANUAL_PHONE       : 'MANUAL_PHONE',
  MANUAL_EMAIL       : 'MANUAL_EMAIL',
  MANUAL_CITY        : 'MANUAL_CITY',
  MANUAL_IS_SELLER   : 'MANUAL_IS_SELLER',
  MANUAL_NOTE        : 'MANUAL_NOTE',
  CONFIRMING_MANUAL  : 'CONFIRMING_MANUAL',
  CONFIRMING_ALL     : 'CONFIRMING_ALL',
};

// ============================================================
// 記憶體 Session（30 分鐘自動過期）
// 正式上線建議換成 Redis 或 Netlify Blobs
// ============================================================
const sessions = new Map();

function getSession(uid) {
  const s = sessions.get(uid);
  if (!s) return null;
  if (Date.now() - s.ts > 30 * 60 * 1000) { sessions.delete(uid); return null; }
  return s;
}

function setState(uid, state, data = {}) {
  const prev = getSession(uid);
  sessions.set(uid, { state, data: { ...(prev ? prev.data : {}), ...data }, ts: Date.now() });
}

function clearSession(uid) { sessions.delete(uid); }

// ============================================================
// LINE 工具函式
// ============================================================

/** 驗證 LINE Webhook 簽名（防偽造） */
function verifySignature(rawBody, sig) {
  const hash = crypto.createHmac('SHA256', CFG.LINE_CHANNEL_SECRET)
    .update(rawBody).digest('base64');
  return hash === sig;
}

/** 呼叫 LINE API */
function lineApi(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.line.me', path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CFG.LINE_CHANNEL_ACCESS_TOKEN}`,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d || '{}')));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const reply = (token, msgs) => lineApi('/v2/bot/message/reply', { replyToken: token, messages: msgs });
const push  = (uid,   msgs) => lineApi('/v2/bot/message/push',  { to: uid,         messages: msgs });

/** 取得使用者 LINE 顯示名稱 */
function getProfile(uid) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.line.me', path: `/v2/bot/profile/${uid}`, method: 'GET',
      headers: { Authorization: `Bearer ${CFG.LINE_CHANNEL_ACCESS_TOKEN}` },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
    req.on('error', () => resolve({ displayName: '使用者' }));
    req.end();
  });
}

// ============================================================
// 1shop API 整合模組
// ============================================================

/**
 * 依訂單編號查詢 1shop 訂單
 * @returns {{ ok, name, phone, email, amount, status, err }}
 */
function query1shop(orderNo) {
  return new Promise(resolve => {
    const ts  = Math.floor(Date.now() / 1000).toString();
    const sig = crypto.createHmac('SHA256', CFG.ONESHOP_API_SECRET)
      .update(CFG.ONESHOP_API_KEY + ts).digest('hex');

    const req = https.request({
      hostname: 'openapi.1shop.io',
      path: `/api/orders/${encodeURIComponent(orderNo)}`,
      method: 'GET',
      headers: {
        'X-Api-Key': CFG.ONESHOP_API_KEY,
        'X-Timestamp': ts,
        'X-Signature': sig,
        'Content-Type': 'application/json',
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (res.statusCode === 200 && j.data) {
            const o = j.data;
            resolve({
              ok: true,
              name  : o.buyer_name  || o.name   || '',
              phone : o.buyer_phone || o.mobile  || '',
              email : o.buyer_email || o.email   || '',
              amount: o.total_amount || 0,
              status: o.payment_status || '',
            });
          } else {
            resolve({ ok: false, err: j.message || '查無此訂單' });
          }
        } catch { resolve({ ok: false, err: '解析失敗' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, err: '無法連線 1shop' }));
    req.end();
  });
}

// ============================================================
// Google Sheets 查詢（透過 n8n）
// ============================================================

/**
 * 依文字訂單編號查 Google Sheets（L 欄）
 * @returns {{ ok, data: { name, phone, email, orderNo }, err }}
 */
function queryOrderNoText(orderNo) {
  return new Promise(resolve => {
    const body = JSON.stringify({ action: 'lookup', orderNo });
    const url  = new URL(CFG.N8N_WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ ok: false, err: '解析失敗' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, err: '無法連線 n8n' }));
    req.write(body);
    req.end();
  });
}

/**
 * 依圖片 base64 查 Google Sheets（圖片路線：Vision AI 讀 orderNo → 再查表）
 * @returns {{ ok, data: { name, phone, email, orderNo }, err }}
 */
function queryByImage(base64Data) {
  return new Promise(resolve => {
    const body = JSON.stringify({ action: 'lookup_by_image', image: base64Data });
    const url  = new URL(CFG.N8N_WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch { resolve({ ok: false, err: '解析失敗' }); }
      });
    });
    req.on('error', () => resolve({ ok: false, err: '無法連線 n8n' }));
    req.write(body);
    req.end();
  });
}

// ============================================================
// n8n Webhook 推送
// ============================================================

/**
 * 建立送往 n8n 的標準 Payload
 * n8n HTTP Request Node 範例 JSON：
 * {
 *   "lineUserId"     : "Uxxxxxxxx",
 *   "lineDisplayName": "蝦米老師",
 *   "realName"       : "王小明",
 *   "phone"          : "0912345678",
 *   "email"          : "test@gmail.com",
 *   "orderNo"        : "ORD20240001",
 *   "source"         : "1shop",   // 或 "manual"
 *   "submittedAt"    : "2026-05-15T01:00:00.000Z"
 * }
 */
function buildPayload(uid, displayName, data, source) {
  return {
    lineUserId     : uid,
    lineDisplayName: displayName,
    realName       : data.name       || '',
    gender         : data.gender     || '',
    ageGroup       : data.ageGroup   || '',
    phone          : data.phone      || '',
    email          : data.email     || '',
    city           : data.city       || '',
    isSeller       : data.isSeller   || '',
    note           : data.note      || '',
    orderNo        : data.orderNo   || '',
    source,
    submittedAt    : new Date().toISOString(),
  };
}

function sendToN8n(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url  = new URL(CFG.N8N_WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname, path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ============================================================
// 訊息模板
// ============================================================

const M = {
  askPurchase: () => ({
    type: 'text',
    text: '👋 歡迎！\n請問您是否已經成功報名並購買課程？',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '✅ 是，我已購買', text: '是，我已購買' } },
      { type: 'action', action: { type: 'message', label: '❌ 否，我尚未購買', text: '否，我尚未購買' } },
    ]},
  }),

  askOrder: () => ({
    type: 'text',
    text: '📦 請輸入您的「蝦皮叔叔」訂單編號，\n也可以直接上傳訂單截圖（截圖需包含姓名或電話）：',
  }),

  confirm1shop: (name, phone, email) => ({
    type: 'text',
    text: `📋 查到您的訂單資料如下：\n\n👤 姓名：${name}\n📱 電話：${phone}\n📧 Email：${email}\n\n請問資料是否正確？`,
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '✅ 正確，送出資料', text: '正確，送出資料' } },
      { type: 'action', action: { type: 'message', label: '✏️ 不正確，重新輸入', text: '不正確，重新輸入' } },
    ]},
  }),

  askName  : () => ({ type: 'text', text: '👤 請輸入您的真實姓名：' }),
  askGender: () => ({
    type: 'text',
    text: '⚧️ 請選擇您的性別：',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '👨 男', text: '男' } },
      { type: 'action', action: { type: 'message', label: '👩 女', text: '女' } },
    ]},
  }),
  askAge: () => ({
    type: 'text',
    text: '🎂 請選擇您的年齡區間：',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '18~30歲', text: '18~30歲' } },
      { type: 'action', action: { type: 'message', label: '31~40歲', text: '31~40歲' } },
      { type: 'action', action: { type: 'message', label: '41~50歲', text: '41~50歲' } },
      { type: 'action', action: { type: 'message', label: '51~60歲', text: '51~60歲' } },
      { type: 'action', action: { type: 'message', label: '60歲以上', text: '60歲以上' } },
    ]},
  }),
  askPhone : () => ({ type: 'text', text: '📱 請輸入您的手機號碼：\n（格式：0912345678）' }),
  askEmail : () => ({ type: 'text', text: '📧 請輸入您的電子郵件（Email）：' }),
  askCity  : () => ({ type: 'text', text: '📍 請輸入您所在的縣市（例：台北、桃園、台中）：' }),
  askIsSeller: () => ({
    type: 'text',
    text: '🏪 請問您是否是蝦皮賣家？',
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '✅ 是', text: '是' } },
      { type: 'action', action: { type: 'message', label: '❌ 否', text: '否' } },
    ]},
  }),
  askNote: () => ({ type: 'text', text: '📝 有任何想補充的嗎？（若無可直接傳「無」）' }),

  confirmManual: (d) => ({
    type: 'text',
    text: `📋 請確認您填寫的資料：\n\n👤 姓名：${d.name}\n⚧️ 性別：${d.gender}\n🎂 年齡：${d.ageGroup}\n📱 電話：${d.phone}\n📧 Email：${d.email}\n📍 縣市：${d.city}\n🏪 蝦皮賣家：${d.isSeller}\n📝 備註：${d.note}\n\n資料是否正確？`,
    quickReply: { items: [
      { type: 'action', action: { type: 'message', label: '✅ 確認送出', text: '確認送出' } },
      { type: 'action', action: { type: 'message', label: '✏️ 重新填寫', text: '重新填寫' } },
    ]},
  }),

  success: name => ({ type: 'text', text: `🎉 ${name}，您的資料已成功送出！\n\n我們會盡快與您聯繫，感謝！` }),
  err    : msg  => ({ type: 'text', text: `⚠️ ${msg}` }),
  loading: ()   => ({ type: 'text', text: '🔍 正在查詢您的訂單，請稍候...' }),
};

// ============================================================
// LINE 圖片處理
// ============================================================

/** 下載 LINE 伺服器上的圖片並轉成 base64 */
async function downloadLineImage(messageId) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.data.line.me',
      path: `/v2/bot/message/${messageId}/content`,
      method: 'GET',
      headers: { Authorization: `Bearer ${CFG.LINE_CHANNEL_ACCESS_TOKEN}` },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('base64')));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 處理圖片上傳：在 WAITING_ORDER 狀態下，把圖片送往 n8n AI 解析訂單資料 */
async function handleImageMessage(uid, messageId, token) {
  const session = getSession(uid);
  const state   = session ? session.state : S.IDLE;

  // 只有在等待訂單編號的狀態才處理圖片
  if (state !== S.WAITING_ORDER) {
    return reply(token, [
      M.err('請先輸入「開始」來啟動報名流程。'),
      M.askPurchase(),
    ]);
  }

  await reply(token, [M.loading()]);

  const base64Data = await downloadLineImage(messageId);
  const r = await queryByImage(base64Data);

  if (!r.ok || !r.data) {
    setState(uid, S.MANUAL_NAME, { orderNo: '(圖片)' });
    return push(uid, [
      M.err(`無法讀取圖片：${r.err || '查無此訂單'}\n將為您改為手動填寫。`),
      M.askName(),
    ]);
  }

  const o = r.data;
  setState(uid, S.CONFIRMING_1SHOP, {
    orderNo: o.orderNo || '(圖片)',
    name  : o.name  || o.buyer_name  || '',
    phone : o.phone || o.buyer_phone || '',
    email : o.email || o.buyer_email || '',
  });
  return push(uid, [M.confirm1shop(o.name || o.buyer_name || '', o.phone || o.buyer_phone || '', o.email || o.buyer_email || '')]);
}

// ============================================================
// 主要狀態機（State Machine）
// ============================================================

const TRIGGERS = ['開始', '報名', '加入', 'start', 'hi', '你好', 'hello', '哈囉'];

async function handleMessage(uid, text, token) {
  const session = getSession(uid);
  const state   = session ? session.state : S.IDLE;
  const data    = session ? session.data  : {};
  const t       = text.trim();

  console.log(`[狀態機] uid=${uid} state=${state} input="${t}"`);

  // ── 觸發關鍵字 → 重新開始 ──────────────────────────────
  if (state === S.IDLE || TRIGGERS.some(k => t.toLowerCase().includes(k))) {
    setState(uid, S.ASKED_PURCHASE);
    return reply(token, [M.askPurchase()]);
  }

  // ── 已問「是否購買」，等待選擇 ──────────────────────────
  if (state === S.ASKED_PURCHASE) {
    if (t.includes('已購買') || t === '是') {
      setState(uid, S.WAITING_ORDER);
      return reply(token, [M.askOrder()]);
    }
    if (t.includes('尚未購買') || t === '否') {
      setState(uid, S.MANUAL_NAME);
      return reply(token, [M.askName()]);
    }
    return reply(token, [M.err('請點選下方按鈕選擇選項。'), M.askPurchase()]);
  }

  // ── 等待訂單編號（文字 OR 圖片）─────────────────────────
  if (state === S.WAITING_ORDER) {
    if (!t) return reply(token, [M.err('請输入訂單編號，或直接上傳訂單截圖。')]);

    await reply(token, [M.loading()]);
    const r = await queryOrderNoText(t);

    if (!r.ok || !r.data) {
      setState(uid, S.MANUAL_NAME, { orderNo: t });
      return push(uid, [
        M.err(`查無此訂單：${r.err || '請確認訂單編號是否正確'}\n將為您改為手動填寫。`),
        M.askName(),
      ]);
    }

    const o = r.data;
    setState(uid, S.CONFIRMING_1SHOP, {
      orderNo: o.orderNo || t,
      name  : o.name  || '',
      phone : o.phone || '',
      email : o.email || '',
    });
    return push(uid, [M.confirm1shop(o.name || '', o.phone || '', o.email || '')]);
  }

// ── 確認 1shop 撈出的資料 ────────────────────────────────
  if (state === S.CONFIRMING_1SHOP) {
    if (t.includes('正確') || t.includes('送出')) {
      setState(uid, S.MANUAL_GENDER, { from1shop: true });
      return reply(token, [M.askGender()]);
    }
    if (t.includes('不正確') || t.includes('重新')) {
      setState(uid, S.MANUAL_NAME, { orderNo: data.orderNo });
      return reply(token, [{ type: 'text', text: '沒關係，請手動填寫您的資料。' }, M.askName()]);
    }
    return reply(token, [M.err('請點選下方按鈕。'), M.confirm1shop(data.name, data.phone, data.email)]);
  }

  // ── 從 1shop 流程進入手動欄位蒐集（性別）──
  if (state === S.MANUAL_GENDER && data.from1shop) {
    if (!['男', '女'].includes(t)) return reply(token, [M.err('請選擇男或女'), M.askGender()]);
    setState(uid, S.MANUAL_AGE, { gender: t, from1shop: true });
    return reply(token, [M.askAge()]);
  }

  // ── 從 1shop 流程進入手動欄位蒐集（年齡）──
  if (state === S.MANUAL_AGE && data.from1shop) {
    const ages = ['18~30歲', '31~40歲', '41~50歲', '51~60歲', '60歲以上'];
    if (!ages.includes(t)) return reply(token, [M.err('請選擇年齡區間'), M.askAge()]);
    setState(uid, S.MANUAL_CITY, { ageGroup: t, from1shop: true });
    return reply(token, [M.askCity()]);
  }

  // ── 從 1shop 流程進入手動欄位蒐集（縣市）──
  if (state === S.MANUAL_CITY && data.from1shop) {
    if (t.trim().length < 2) return reply(token, [M.err('請輸入有效的縣市名稱。')]);
    setState(uid, S.MANUAL_IS_SELLER, { city: t.trim(), from1shop: true });
    return reply(token, [M.askIsSeller()]);
  }

  // ── 從 1shop 流程進入手動欄位蒐集（是否蝦皮賣家）──
  if (state === S.MANUAL_IS_SELLER && data.from1shop) {
    if (!['是', '否'].includes(t)) return reply(token, [M.err('請選擇是或否'), M.askIsSeller()]);
    setState(uid, S.MANUAL_NOTE, { isSeller: t, from1shop: true });
    return reply(token, [M.askNote()]);
  }

  // ── 從 1shop 流程進入手動欄位蒐集（備註）──
  if (state === S.MANUAL_NOTE && data.from1shop) {
    const note = t.trim() === '無' ? '' : t.trim();
    const allData = { ...data, note, from1shop: undefined };
    setState(uid, S.CONFIRMING_ALL, allData);
    return reply(token, [M.confirmManual(allData)]);
  }

  // ── 最終確認（1shop 或 manual 都走這裡）──
  if (state === S.CONFIRMING_ALL) {
    if (t.includes('確認') || t.includes('送出')) {
      const profile = await getProfile(uid);
      const payload = buildPayload(uid, profile.displayName, data, data.orderNo ? '1shop' : 'manual');
      await sendToN8n(payload);
      clearSession(uid);
      return reply(token, [M.success(data.name)]);
    }
    if (t.includes('重新')) {
      setState(uid, S.MANUAL_NAME);
      return reply(token, [{ type: 'text', text: '好的，請重新填寫。' }, M.askName()]);
    }
    return reply(token, [M.err('請點選下方按鈕。'), M.confirmManual(data)]);
  }

  // ── 手動填寫：姓名 ───────────────────────────────────────
  if (state === S.MANUAL_NAME) {
    if (t.length < 2) return reply(token, [M.err('請輸入有效的姓名（至少 2 個字）。')]);
    setState(uid, S.MANUAL_GENDER, { name: t });
    return reply(token, [M.askGender()]);
  }

  // ── 手動填寫：性別 ──────────────────────────────────────
  if (state === S.MANUAL_GENDER) {
    if (!['男', '女'].includes(t)) return reply(token, [M.err('請選擇男或女'), M.askGender()]);
    setState(uid, S.MANUAL_AGE, { gender: t });
    return reply(token, [M.askAge()]);
  }

  // ── 手動填寫：年齡 ─────────────────────────────────────
  if (state === S.MANUAL_AGE) {
    const ages = ['18~30歲', '31~40歲', '41~50歲', '51~60歲', '60歲以上'];
    if (!ages.includes(t)) return reply(token, [M.err('請選擇年齡區間'), M.askAge()]);
    setState(uid, S.MANUAL_PHONE, { ageGroup: t });
    return reply(token, [M.askPhone()]);
  }

  // ── 手動填寫：手機 ─────────────────────────────────────
  if (state === S.MANUAL_PHONE) {
    const phone = t.replace(/[\s-]/g, '');
    if (!/^09\d{8}$/.test(phone)) {
      return reply(token, [M.err('格式不正確，請輸入 09 開頭的 10 位數字（例：0912345678）。')]);
    }
    setState(uid, S.MANUAL_EMAIL, { phone });
    return reply(token, [M.askEmail()]);
  }

  // ── 手動填寫：Email ────────────────────────────────────
  if (state === S.MANUAL_EMAIL) {
    const email = t.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply(token, [M.err('Email 格式不正確，請重新輸入。')]);
    }
    setState(uid, S.MANUAL_CITY, { email });
    return reply(token, [M.askCity()]);
  }

  // ── 手動填寫：縣市 ─────────────────────────────────────
  if (state === S.MANUAL_CITY) {
    if (t.trim().length < 2) return reply(token, [M.err('請輸入有效的縣市名稱。')]);
    setState(uid, S.MANUAL_IS_SELLER, { city: t.trim() });
    return reply(token, [M.askIsSeller()]);
  }

  // ── 手動填寫：是否蝦皮賣家 ────────────────────────────
  if (state === S.MANUAL_IS_SELLER) {
    if (!['是', '否'].includes(t)) return reply(token, [M.err('請選擇是或否'), M.askIsSeller()]);
    setState(uid, S.MANUAL_NOTE, { isSeller: t });
    return reply(token, [M.askNote()]);
  }

  // ── 手動填寫：備註 ─────────────────────────────────────
  if (state === S.MANUAL_NOTE) {
    const note = t.trim() === '無' ? '' : t.trim();
    setState(uid, S.CONFIRMING_MANUAL, { note });
    const d2 = getSession(uid).data;
    return reply(token, [M.confirmManual(d2)]);
  }

  // ── 確認手動填寫資料 ────────────────────────────────────
  if (state === S.CONFIRMING_MANUAL) {
    if (t.includes('確認') || t.includes('送出')) {
      const profile = await getProfile(uid);
      const payload = buildPayload(uid, profile.displayName, data, 'manual');
      await sendToN8n(payload);
      clearSession(uid);
      return reply(token, [M.success(data.name)]);
    }
    if (t.includes('重新')) {
      setState(uid, S.MANUAL_NAME);
      return reply(token, [{ type: 'text', text: '好的，請重新填寫。' }, M.askName()]);
    }
    return reply(token, [M.err('請點選下方按鈕。'), M.confirmManual(data)]);
  }

  // ── 預設：任何未知狀態重新開始 ──────────────────────────
  setState(uid, S.ASKED_PURCHASE);
  return reply(token, [M.askPurchase()]);
}

// ============================================================
// Netlify Function 入口
// ============================================================
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  // 【安全驗證】驗證 LINE 簽名
  const sig = event.headers['x-line-signature'];
  if (!verifySignature(event.body, sig)) {
    console.error('[Security] 簽名驗證失敗');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  // 處理所有事件（LINE 可能一次送多個）
  await Promise.all(body.events.map(async ev => {
    if (ev.type === 'message') {
      if (ev.message.type === 'text') {
        try {
          await handleMessage(ev.source.userId, ev.message.text, ev.replyToken);
        } catch (err) {
          console.error('[Error]', err);
          await reply(ev.replyToken, [M.err('系統發生錯誤，請稍後再試。')]).catch(() => {});
        }
      } else if (ev.message.type === 'image') {
        try {
          await handleImageMessage(ev.source.userId, ev.message.id, ev.replyToken);
        } catch (err) {
          console.error('[Image Error]', err);
          await reply(ev.replyToken, [M.err('圖片處理失敗，請稍後再試。')]).catch(() => {});
        }
      }
    }
  }));

  return { statusCode: 200, body: JSON.stringify({ status: 'ok' }) };
};
