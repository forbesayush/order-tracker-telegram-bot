/**
 * Order Tracker Telegram Bot (Single & Batch Mode)
 *
 * Connects to Telegram via long-polling and queries the Google Apps Script
 * Master Order Status portal in real-time using headless Chrome DevTools Protocol.
 *
 * Supports:
 * - Single Order Check (detailed card)
 * - Batch Order Check (multi-line paste, list, or uploaded .txt/.csv file)
 * - Live progress tracking
 * - Automatic CSV report generation & upload
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ==================== CONFIGURATION ====================
let configToken = 'YOUR_BOT_TOKEN_HERE';
const configPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.bot_token && cfg.bot_token !== 'YOUR_BOT_TOKEN_HERE') {
      configToken = cfg.bot_token;
    }
  } catch (e) {}
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || configToken;
const TARGET_URL = process.env.PORTAL_URL || 'https://script.google.com/macros/s/AKfycbzqOmNRuLVKPAXtS3xwoSRxCzdRp-kOAyeseP9zmNolgp9IPeYyR1cK9hAS0t-2w7XX/exec';

const CHROME_PATH = process.env.CHROME_PATH || (
  process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome'
);

const CDP_PORT = parseInt(process.env.CDP_PORT || '9222', 10);
// =======================================================

let chromeProcess = null;
let wsIframe = null;
let msgId = 1;
const pending = new Map();
let isQuerying = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendCDP(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = msgId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

/**
 * Initializes headless Chrome and connects to the userHtmlFrame iframe.
 */
async function initBrowser() {
  if (chromeProcess) {
    try { chromeProcess.kill(); } catch (e) {}
    chromeProcess = null;
  }
  if (wsIframe) {
    try { wsIframe.close(); } catch (e) {}
    wsIframe = null;
  }

  console.log('[Browser] Starting headless Chrome from:', CHROME_PATH);
  const tempProfile = process.env.TEMP
    ? `${process.env.TEMP}\\chrome_gas_bot_${Date.now()}`
    : `/tmp/chrome_gas_bot_${Date.now()}`;

  chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${tempProfile}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check'
  ]);

  process.on('exit', () => { if (chromeProcess) chromeProcess.kill(); });
  process.on('SIGINT', () => { if (chromeProcess) chromeProcess.kill(); process.exit(); });

  console.log('[Browser] Connecting to Chrome DevTools Protocol...');
  let version = null;
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      version = await res.json();
      if (version && version.webSocketDebuggerUrl) break;
    } catch (e) {
      await sleep(300);
    }
  }

  if (!version) {
    throw new Error('Could not connect to Chrome on port ' + CDP_PORT);
  }

  console.log('[Browser] Opening Google Apps Script portal...');
  await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(TARGET_URL)}`, { method: 'PUT' });

  let iframeTarget = null;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const targetsRes = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
    const targets = await targetsRes.json();
    iframeTarget = targets.find(t => t.type === 'iframe' && t.url.includes('googleusercontent.com'));
    if (iframeTarget && iframeTarget.webSocketDebuggerUrl) break;
  }

  if (!iframeTarget) {
    throw new Error('Could not locate Google Apps Script iframe target');
  }

  console.log('[Browser] Connecting to App iframe...');
  wsIframe = new WebSocket(iframeTarget.webSocketDebuggerUrl);

  wsIframe.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(data.error);
      else resolve(data.result);
    }
  };

  await new Promise(r => wsIframe.onopen = r);
  await sendCDP(wsIframe, 'Runtime.enable');

  console.log('[Browser] Waiting for portal runner to initialize...');
  for (let i = 0; i < 30; i++) {
    const res = await sendCDP(wsIframe, 'Runtime.evaluate', {
      expression: `!!(document.getElementById('userHtmlFrame')?.contentWindow?.google?.script?.run?.checkStatus)`,
      returnByValue: true
    });
    if (res.result && res.result.value === true) {
      console.log('[Browser] Portal runner is ready!');
      return;
    }
    await sleep(500);
  }

  throw new Error('Timeout waiting for Google Apps Script runner');
}

/**
 * Checks an order ID using the live Google Apps Script web app
 */
async function checkOrder(orderId, retryCount = 1) {
  while (isQuerying) {
    await sleep(100);
  }
  isQuerying = true;

  try {
    const evalResult = await sendCDP(wsIframe, 'Runtime.evaluate', {
      expression: `
        new Promise((resolve) => {
          try {
            const win = document.getElementById('userHtmlFrame').contentWindow;
            win.google.script.run
              .withSuccessHandler(res => resolve({ success: true, res }))
              .withFailureHandler(err => resolve({ success: false, err: err ? (err.message || JSON.stringify(err)) : 'Unknown script error' }))
              .checkStatus(${JSON.stringify(orderId)});
          } catch(e) {
            resolve({ success: false, err: e.toString() });
          }
        })
      `,
      awaitPromise: true,
      returnByValue: true
    });

    const val = evalResult.result ? evalResult.result.value : null;
    return val;
  } catch (err) {
    console.error('[Browser] Evaluation error:', err.message);
    if (retryCount > 0) {
      console.log('[Browser] Attempting to reconnect browser session...');
      await initBrowser();
      return await checkOrder(orderId, retryCount - 1);
    }
    return { success: false, err: err.message };
  } finally {
    isQuerying = false;
  }
}

/**
 * Telegram API Helpers
 */
async function sendTelegram(chatId, text, replyToMessageId = null) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };
  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await res.json();
  } catch (err) {
    console.error('[Telegram] Error sending message:', err.message);
    return null;
  }
}

async function editTelegram(chatId, messageId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown'
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data;
  } catch (err) {
    console.error('[Telegram] Error editing message:', err.message);
    return null;
  }
}

async function sendTelegramDocument(chatId, bufferOrString, filename, caption = '') {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('caption', caption);
  formData.append('document', new Blob([bufferOrString], { type: 'text/csv' }), filename);

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: formData
    });
    return await res.json();
  } catch (err) {
    console.error('[Telegram] Error sending document:', err.message);
    return null;
  }
}

async function getTelegramFileContent(fileId) {
  const fileInfoUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`;
  const infoRes = await fetch(fileInfoUrl);
  const infoData = await infoRes.json();
  if (!infoData.ok || !infoData.result.file_path) {
    throw new Error('Failed to retrieve file metadata from Telegram');
  }

  const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${infoData.result.file_path}`;
  const fileRes = await fetch(downloadUrl);
  return await fileRes.text();
}

/**
 * Single Order Handler
 */
async function handleSingleOrder(chatId, orderId, replyToMessageId) {
  const progressRes = await sendTelegram(chatId, `🔍 *Checking Order ID:* \`${orderId}\`...`, replyToMessageId);
  const progressMsgId = progressRes && progressRes.result ? progressRes.result.message_id : null;

  try {
    const res = await checkOrder(orderId);

    if (!res || !res.success) {
      const errorText = `⚠️ *Error querying portal:* ${res ? res.err : 'No response from portal'}`;
      if (progressMsgId) await editTelegram(chatId, progressMsgId, errorText);
      else await sendTelegram(chatId, errorText, replyToMessageId);
      return;
    }

    if (res.res === 'Invalid Order ID' || !res.res) {
      const notFoundText =
        `❌ *Order Not Found*\n\n` +
        `Order ID: \`${orderId}\` is *not in the database*.\n` +
        `_Tip: It may belong to a newer batch not yet synced to the master sheet._`;
      if (progressMsgId) await editTelegram(chatId, progressMsgId, notFoundText);
      else await sendTelegram(chatId, notFoundText, replyToMessageId);
      return;
    }

    const d = res.res;
    const formStatus = (d.step2 === 'Refund Form Filled')
      ? '✅ *Received & Verified*'
      : `⏳ ${d.step2 || 'Pending'}`;

    const settlementStatus = (d.step3 === 'Refund Completed')
      ? '✅ *Completed*'
      : (d.step3 && d.step3 !== 'Pending')
        ? `⚠️ ${d.step3}`
        : '⏳ Processing Payment';

    const reply =
      `📦 *Order Details*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🆔 *Order ID:* \`${orderId}\`\n` +
      `👤 *Buyer:* ${d.buyerName || 'N/A'}\n` +
      `💰 *Amount:* ₹${d.amount || 0}\n` +
      `📅 *Order Date:* ${d.orderDate || 'N/A'}\n\n` +
      `📊 *Status Tracker:*\n` +
      `1️⃣ *Order Status:* ✅ Confirmed\n` +
      `2️⃣ *Refund Form:* ${formStatus}\n` +
      `3️⃣ *Settlement:* ${settlementStatus}`;

    if (progressMsgId) {
      await editTelegram(chatId, progressMsgId, reply);
    } else {
      await sendTelegram(chatId, reply, replyToMessageId);
    }
  } catch (err) {
    console.error('[Error] Lookup failed for', orderId, err);
    const failText = `⚠️ *Error:* Failed to fetch details for \`${orderId}\` (${err.message})`;
    if (progressMsgId) await editTelegram(chatId, progressMsgId, failText);
    else await sendTelegram(chatId, failText, replyToMessageId);
  }
}

/**
 * Batch Orders Handler
 */
async function handleBatchOrders(chatId, orderIds, replyToMessageId) {
  const total = orderIds.length;
  console.log(`[Batch] Starting verification for ${total} orders...`);

  // Initial progress notice
  const progressRes = await sendTelegram(
    chatId,
    `🔄 *Batch Check Started*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total Orders: *${total}*\n⏳ Progress: 0/${total} (0%)\n\n_Please wait, checking database in real-time..._`,
    replyToMessageId
  );
  const progressMsgId = progressRes && progressRes.result ? progressRes.result.message_id : null;

  const foundList = [];
  const notFoundList = [];
  let totalAmount = 0;
  let lastEditTime = Date.now();

  for (let i = 0; i < total; i++) {
    const orderId = orderIds[i];
    try {
      const res = await checkOrder(orderId);
      if (res && res.success && typeof res.res === 'object' && res.res !== null) {
        const d = res.res;
        const amt = parseFloat(d.amount) || 0;
        totalAmount += amt;
        foundList.push({
          orderId,
          buyerName: d.buyerName || 'N/A',
          amount: amt,
          orderDate: d.orderDate || 'N/A',
          step1: d.step1 || 'Order Placed',
          step2: d.step2 || 'Pending',
          step3: d.step3 || 'Pending'
        });
      } else {
        notFoundList.push(orderId);
      }
    } catch (err) {
      notFoundList.push(orderId);
    }

    // Update progress message periodically (every 3 items or every 2 seconds to avoid Telegram rate limits)
    const now = Date.now();
    const isLast = i === total - 1;
    if (progressMsgId && (now - lastEditTime > 2500 || isLast)) {
      lastEditTime = now;
      const pct = Math.round(((i + 1) / total) * 100);
      await editTelegram(
        chatId,
        progressMsgId,
        `🔄 *Batch Check in Progress*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total Orders: *${total}*\n⏳ Checked: *${i + 1}/${total}* (${pct}%)\n✅ Found: *${foundList.length}* | ❌ Not Found: *${notFoundList.length}*`
      );
    }

    await sleep(250); // slight breathing room between calls
  }

  // Build the Final Batch Summary Message
  let summary =
    `📊 *Batch Check Complete*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `📦 *Total Orders Checked:* ${total}\n` +
    `✅ *In Database (Found):* ${foundList.length}\n` +
    `❌ *Not In Database:* ${notFoundList.length}\n` +
    `💰 *Total Amount:* ₹${totalAmount.toFixed(2)}\n\n`;

  if (foundList.length > 0) {
    summary += `✅ *Found Orders:*\n`;
    const previewCount = Math.min(foundList.length, 12);
    for (let k = 0; k < previewCount; k++) {
      const item = foundList[k];
      const formIcon = item.step2 === 'Refund Form Filled' ? '✅' : '⏳';
      const setIcon = item.step3 === 'Refund Completed' ? '✅' : '⏳';
      summary += `${k + 1}. \`${item.orderId}\` — *${item.buyerName}* (₹${item.amount})\n   └ Date: ${item.orderDate} | Form: ${formIcon} | Pay: ${setIcon}\n`;
    }
    if (foundList.length > previewCount) {
      summary += `_...and ${foundList.length - previewCount} more found orders (see CSV attached)_\n`;
    }
    summary += `\n`;
  }

  if (notFoundList.length > 0) {
    summary += `❌ *Orders Not Found / Invalid (${notFoundList.length}):*\n`;
    const previewNotFound = Math.min(notFoundList.length, 10);
    for (let k = 0; k < previewNotFound; k++) {
      summary += `• \`${notFoundList[k]}\`\n`;
    }
    if (notFoundList.length > previewNotFound) {
      summary += `_...and ${notFoundList.length - previewNotFound} more (see CSV attached)_\n`;
    }
  }

  // Update progress message with the final summary
  if (progressMsgId) {
    await editTelegram(chatId, progressMsgId, summary);
  } else {
    await sendTelegram(chatId, summary, replyToMessageId);
  }

  // Generate CSV Report
  let csv = 'Order ID,Status,Buyer Name,Amount,Order Date,Step 1,Step 2 (Refund Form),Step 3 (Settlement)\n';
  for (const item of foundList) {
    csv += `"${item.orderId}","FOUND","${item.buyerName.replace(/"/g, '""')}","${item.amount}","${item.orderDate}","${item.step1}","${item.step2}","${item.step3}"\n`;
  }
  for (const id of notFoundList) {
    csv += `"${id}","NOT FOUND","","","","","",""\n`;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const csvFileName = `batch_orders_report_${timestamp}.csv`;

  await sendTelegramDocument(
    chatId,
    csv,
    csvFileName,
    `📄 Detailed CSV report for ${total} checked orders.`
  );
  console.log(`[Batch] Completed and sent CSV report for ${total} orders.`);
}

/**
 * Long-polling Telegram loop
 */
async function startTelegramPolling() {
  console.log('[Telegram] Connected successfully! Listening for messages...');
  let offset = 0;

  while (true) {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.ok) {
        if (data.error_code === 401) {
          console.error('[Telegram] Invalid BOT TOKEN! Please verify your token in config.json.');
          process.exit(1);
        }
        console.error('[Telegram] Error response:', data.description);
        await sleep(3000);
        continue;
      }

      for (const update of data.result) {
        offset = update.update_id + 1;
        if (update.message) {
          handleIncomingMessage(update.message);
        }
      }
    } catch (err) {
      console.error('[Telegram] Polling connection error:', err.message);
      await sleep(3000);
    }
  }
}

/**
 * Handles incoming message
 */
async function handleIncomingMessage(msg) {
  const chatId = msg.chat.id;
  const userName = msg.from ? (msg.from.first_name || msg.from.username) : 'User';

  // 1. Check for uploaded file (.txt or .csv)
  if (msg.document) {
    const doc = msg.document;
    const isText = doc.file_name && (doc.file_name.endsWith('.txt') || doc.file_name.endsWith('.csv'));
    if (isText) {
      console.log(`[Message] Document received from ${userName}: ${doc.file_name}`);
      await sendTelegram(chatId, `📥 *Reading file:* \`${doc.file_name}\`...`, msg.message_id);
      try {
        const fileContent = await getTelegramFileContent(doc.file_id);
        const matches = [...new Set(fileContent.match(/\b\d{15,20}\b/g) || [])];
        if (matches.length === 0) {
          await sendTelegram(chatId, `⚠️ *No Order IDs found in file!* Please ensure it contains 15-20 digit order IDs.`, msg.message_id);
          return;
        }
        await handleBatchOrders(chatId, matches, msg.message_id);
      } catch (err) {
        console.error('[Error] File read failed:', err);
        await sendTelegram(chatId, `⚠️ *Error reading file:* ${err.message}`, msg.message_id);
      }
      return;
    }
  }

  // 2. Check for text message
  if (!msg.text) return;
  const text = msg.text.trim();
  console.log(`[Message] From ${userName} (${chatId}): "${text.slice(0, 100)}..."`);

  if (text === '/start' || text === '/help') {
    await sendTelegram(chatId,
      `👋 *Hello ${userName}!*\n\n` +
      `Welcome to the *Order Tracking Bot* with **Batch Support**!\n\n` +
      `📌 *Features:*\n` +
      `• *Single Order Check:* Send one ID (e.g. \`351692994041939520\`) to get full details card.\n` +
      `• *Batch Order Check:* Paste a list of multiple Order IDs at once, or upload a \`.txt\` / \`.csv\` file.\n` +
      `• *Live Progress & CSV Export:* Live progress updates and an automatic downloadable CSV report for batch runs!`,
      msg.message_id
    );
    return;
  }

  // Extract all 15-20 digit order IDs and remove duplicates
  const rawMatches = text.match(/\b\d{15,20}\b/g);
  if (!rawMatches || rawMatches.length === 0) {
    await sendTelegram(chatId,
      `⚠️ *Invalid input!*\n\nPlease send one or more valid numeric Order IDs (e.g. \`351692994041939520\`), or upload a .txt/.csv file.`,
      msg.message_id
    );
    return;
  }

  const orderIds = [...new Set(rawMatches)];

  if (orderIds.length === 1) {
    // Single Order Mode
    await handleSingleOrder(chatId, orderIds[0], msg.message_id);
  } else {
    // Batch Mode
    await handleBatchOrders(chatId, orderIds, msg.message_id);
  }
}

// ==================== MAIN ====================
async function main() {
  console.log('==============================================');
  console.log('   Telegram Bot - Order Status & Batch System ');
  console.log('==============================================');

  if (BOT_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('ERROR: Please set your TELEGRAM_BOT_TOKEN before starting!');
    console.log('You can set it in config.json or pass it as an environment variable.');
    process.exit(1);
  }

  await initBrowser();
  await startTelegramPolling();
}

main().catch(err => {
  console.error('Fatal initialization error:', err);
  process.exit(1);
});
