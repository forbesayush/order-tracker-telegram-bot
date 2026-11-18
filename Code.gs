/**
 * ===================================================================
 * TELEGRAM ORDER STATUS TRACKING BOT (CLOUD-HOSTED IN GOOGLE APPS SCRIPT)
 * ===================================================================
 *
 * This script runs 100% inside Google Apps Script (on Google Cloud servers).
 * It receives Order IDs from Telegram, queries the Master Tracking Portal,
 * and replies with the detailed status of each Order ID.
 *
 * Supports:
 * - Single Order Check
 * - Batch Order Check (paste 2, 10, 50+ IDs at once)
 * - Message splitting (handles Telegram's 4096 char limit)
 * - Automatic CSV report generation
 */

// ==================== CONFIGURATION ====================
// Your Telegram Bot Token from @BotFather
const TELEGRAM_BOT_TOKEN = "9060968963:AAF_1XvGuUf-NVfvzjnuUph45hfF-WLkpuo";
const TELEGRAM_API = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN;

// The live Master Order Status Web App URL to query
const PORTAL_BASE_URL = "https://script.google.com/macros/s/AKfycbzqOmNRuLVKPAXtS3xwoSRxCzdRp-kOAyeseP9zmNolgp9IPeYyR1cK9hAS0t-2w7XX";
// =======================================================

/**
 * Webhook entry point: Receives messages from Telegram
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput("OK");
    }

    const update = JSON.parse(e.postData.contents);
    if (!update.message) {
      return ContentService.createTextOutput("OK");
    }

    const msg = update.message;
    const chatId = msg.chat.id;
    const userName = msg.from ? (msg.from.first_name || msg.from.username) : "User";

    // 1. Support uploaded text/CSV files containing Order IDs
    if (msg.document) {
      const doc = msg.document;
      const isText = doc.file_name && (doc.file_name.endsWith(".txt") || doc.file_name.endsWith(".csv"));
      if (isText) {
        sendTelegramMessage(chatId, "📥 *Reading file:* `" + doc.file_name + "`...", msg.message_id);
        const fileContent = getTelegramFileContent(doc.file_id);
        const orderIds = extractOrderIds(fileContent);
        if (orderIds.length === 0) {
          sendTelegramMessage(chatId, "⚠️ *No valid 15-20 digit Order IDs found in the file!*", msg.message_id);
          return ContentService.createTextOutput("OK");
        }
        handleOrderCheck(chatId, orderIds, msg.message_id);
        return ContentService.createTextOutput("OK");
      }
    }

    // 2. Text message handler
    if (!msg.text) {
      return ContentService.createTextOutput("OK");
    }

    const text = msg.text.trim();

    // Help & Start command
    if (text === "/start" || text === "/help") {
      const helpMsg =
        "👋 *Hello " + userName + "!*\n\n" +
        "Welcome to the *Order Tracking Bot*.\n\n" +
        "📌 *How to use:*\n" +
        "• *Single Order:* Send an Order ID (e.g. `351692994041939520`)\n" +
        "• *Batch Check:* Paste multiple Order IDs separated by newlines, commas, or inside text blocks.\n" +
        "• *File Upload:* Upload a `.txt` or `.csv` file with Order IDs.";
      sendTelegramMessage(chatId, helpMsg, msg.message_id);
      return ContentService.createTextOutput("OK");
    }

    // Extract all numeric Order IDs (15 to 20 digits)
    const orderIds = extractOrderIds(text);
    if (orderIds.length === 0) {
      sendTelegramMessage(chatId, "⚠️ *Invalid input!*\n\nPlease send one or more valid Order IDs (e.g. `351692994041939520`).", msg.message_id);
      return ContentService.createTextOutput("OK");
    }

    // Process the Order ID(s)
    handleOrderCheck(chatId, orderIds, msg.message_id);

  } catch (err) {
    Logger.log("doPost Error: " + err.toString());
  }

  return ContentService.createTextOutput("OK");
}

/**
 * Extracts unique 15-20 digit order IDs from any text or block
 */
function extractOrderIds(text) {
  const matches = text.match(/\b\d{15,20}\b/g);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

/**
 * Queries the Master Google Apps Script portal via direct RPC POST
 */
function queryPortal(orderId) {
  try {
    const url = PORTAL_BASE_URL + "/callback?nocache_id=" + Date.now();
    const payload = "request=" + encodeURIComponent(JSON.stringify(["checkStatus", JSON.stringify([String(orderId)]), null, [0], null, null, 1, 0]));

    const options = {
      method: "post",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      headers: {
        "X-Same-Domain": "1",
        "Referer": PORTAL_BASE_URL + "/exec",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
      },
      payload: payload,
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const text = response.getContentText();
    const cleanJson = text.replace(/^\)\]\}'/, '').trim();
    const parsed = JSON.parse(cleanJson);

    for (let i = 0; i < parsed.length; i++) {
      const item = parsed[i];
      if (item[0] === "op.exec" && item[1]) {
        const raw = item[1][1];
        if (raw === "Invalid Order ID" || !raw) return "Invalid Order ID";
        if (typeof raw === "string" && raw.startsWith("{")) return JSON.parse(raw);
        return raw;
      }
    }
  } catch (e) {
    Logger.log("queryPortal error for " + orderId + ": " + e.toString());
  }
  return "Invalid Order ID";
}

/**
 * Handles checking Order IDs (Single or Batch) and returns individual status for each
 */
function handleOrderCheck(chatId, orderIds, replyToMessageId) {
  const total = orderIds.length;

  // Single Order Case
  if (total === 1) {
    const orderId = orderIds[0];
    const progressRes = sendTelegramMessage(chatId, "🔍 *Checking Order ID:* `" + orderId + "`...", replyToMessageId);
    const progressMsgId = progressRes && progressRes.result ? progressRes.result.message_id : null;

    const data = queryPortal(orderId);

    if (data === "Invalid Order ID" || !data || typeof data !== "object") {
      const notFound =
        "❌ *Order Not Found*\n" +
        "━━━━━━━━━━━━━━━━━━━━━━\n" +
        "🆔 *Order ID:* `" + orderId + "`\n" +
        "⚠️ *Status:* Not in database (Invalid Order ID)";
      if (progressMsgId) editTelegramMessage(chatId, progressMsgId, notFound);
      else sendTelegramMessage(chatId, notFound, replyToMessageId);
      return;
    }

    const formStatus = (data.step2 === "Refund Form Filled")
      ? "✅ *Received & Verified*"
      : "⏳ " + (data.step2 || "Pending");

    const settlementStatus = (data.step3 === "Refund Completed")
      ? "✅ *Completed*"
      : (data.step3 && data.step3 !== "Pending")
        ? "⚠️ " + data.step3
        : "⏳ Processing Payment";

    const singleReport =
      "📦 *Order Status Details*\n" +
      "━━━━━━━━━━━━━━━━━━━━━━\n" +
      "🆔 *Order ID:* `" + orderId + "`\n" +
      "👤 *Buyer:* " + (data.buyerName || "N/A") + "\n" +
      "💰 *Amount:* ₹" + (data.amount || 0) + "\n" +
      "📅 *Order Date:* " + (data.orderDate || "N/A") + "\n\n" +
      "📊 *Tracker Steps:*\n" +
      "1️⃣ *Order Status:* ✅ Confirmed\n" +
      "2️⃣ *Refund Form:* " + formStatus + "\n" +
      "3️⃣ *Settlement:* " + settlementStatus;

    if (progressMsgId) editTelegramMessage(chatId, progressMsgId, singleReport);
    else sendTelegramMessage(chatId, singleReport, replyToMessageId);
    return;
  }

  // Batch Case (Multiple Orders)
  const progressRes = sendTelegramMessage(
    chatId,
    "🔄 *Batch Check Started*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total Orders: *" + total + "*\n⏳ Progress: 0/" + total + " (0%)\n\n_Checking live Google Sheet database..._",
    replyToMessageId
  );
  const progressMsgId = progressRes && progressRes.result ? progressRes.result.message_id : null;

  const results = [];
  let foundCount = 0;
  let notFoundCount = 0;
  let totalAmount = 0;
  let lastEditTime = Date.now();

  for (let i = 0; i < total; i++) {
    const orderId = orderIds[i];
    const data = queryPortal(orderId);

    if (data && typeof data === "object" && data !== "Invalid Order ID") {
      const amt = parseFloat(data.amount) || 0;
      totalAmount += amt;
      foundCount++;
      results.push({
        orderId: orderId,
        found: true,
        buyerName: data.buyerName || "N/A",
        amount: amt,
        orderDate: data.orderDate || "N/A",
        step1: data.step1 || "Order Placed",
        step2: data.step2 || "Pending",
        step3: data.step3 || "Pending"
      });
    } else {
      notFoundCount++;
      results.push({
        orderId: orderId,
        found: false,
        buyerName: "N/A",
        amount: 0,
        orderDate: "N/A",
        step1: "N/A",
        step2: "N/A",
        step3: "N/A"
      });
    }

    // Update progress periodically (every ~3 seconds to stay within Telegram rate limits)
    const now = Date.now();
    const isLast = (i === total - 1);
    if (progressMsgId && (now - lastEditTime > 3000 || isLast)) {
      lastEditTime = now;
      const pct = Math.round(((i + 1) / total) * 100);
      editTelegramMessage(
        chatId,
        progressMsgId,
        "🔄 *Batch Check in Progress*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total Orders: *" + total + "*\n⏳ Checked: *" + (i + 1) + "/" + total + "* (" + pct + "%)\n✅ Found: *" + foundCount + "* | ❌ Not Found: *" + notFoundCount + "*"
      );
    }

    Utilities.sleep(150);
  }

  // Build the Header Summary
  let summaryHeader =
    "📊 *Batch Orders Status Report*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📦 *Total Orders Checked:* " + total + "\n" +
    "✅ *Found in Database:* " + foundCount + "\n" +
    "❌ *Not in Database:* " + notFoundCount + "\n" +
    "💰 *Total Amount (Found):* ₹" + totalAmount.toFixed(2) + "\n\n" +
    "📋 *Individual Status for Each Order:*\n";

  // Build detailed cards for each order
  const messagesToSend = [];
  let currentChunk = summaryHeader;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    let card = "";

    if (item.found) {
      const fIcon = item.step2 === "Refund Form Filled" ? "✅" : "⏳";
      const sIcon = item.step3 === "Refund Completed" ? "✅" : "⏳";
      card =
        (i + 1) + ". 🆔 `" + item.orderId + "` — ✅ *FOUND*\n" +
        "   👤 *Buyer:* " + item.buyerName + " | 💰 *Amount:* ₹" + item.amount + "\n" +
        "   📅 *Date:* " + item.orderDate + " | Form: " + fIcon + " " + item.step2 + " | Pay: " + sIcon + " " + item.step3 + "\n\n";
    } else {
      card =
        (i + 1) + ". 🆔 `" + item.orderId + "` — ❌ *NOT FOUND* (Invalid Order ID)\n\n";
    }

    // Check if adding this card exceeds Telegram's 4096 character limit
    if ((currentChunk + card).length > 3800) {
      messagesToSend.push(currentChunk);
      currentChunk = card;
    } else {
      currentChunk += card;
    }
  }

  if (currentChunk.trim().length > 0) {
    messagesToSend.push(currentChunk);
  }

  // Update progress message with the first chunk
  if (progressMsgId) {
    editTelegramMessage(chatId, progressMsgId, messagesToSend[0]);
  } else {
    sendTelegramMessage(chatId, messagesToSend[0], replyToMessageId);
  }

  // Send subsequent chunks if order list is very long
  for (let m = 1; m < messagesToSend.length; m++) {
    sendTelegramMessage(chatId, messagesToSend[m]);
    Utilities.sleep(300);
  }

  // Generate and attach CSV export file for easy Excel tracking
  let csv = "Order ID,Status,Buyer Name,Amount,Order Date,Step 1,Step 2 (Refund Form),Step 3 (Settlement)\n";
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    csv += '"' + r.orderId + '","' + (r.found ? "FOUND" : "NOT FOUND") + '","' + r.buyerName.replace(/"/g, '""') + '","' + r.amount + '","' + r.orderDate + '","' + r.step1 + '","' + r.step2 + '","' + r.step3 + '"\n';
  }

  const timestamp = Utilities.formatDate(new Date(), "GMT+5:30", "yyyyMMdd_HHmmss");
  sendTelegramDocument(chatId, csv, "order_status_report_" + timestamp + ".csv", "📄 CSV Report for " + total + " checked orders.");
}

/**
 * Telegram API Helpers
 */
function sendTelegramMessage(chatId, text, replyToMessageId) {
  const url = TELEGRAM_API + "/sendMessage";
  const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
  if (replyToMessageId) payload.reply_to_message_id = replyToMessageId;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return JSON.parse(response.getContentText());
  } catch (e) {
    return null;
  }
}

function editTelegramMessage(chatId, messageId, text) {
  const url = TELEGRAM_API + "/editMessageText";
  const payload = { chat_id: chatId, message_id: messageId, text: text, parse_mode: "Markdown" };
  try {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const data = JSON.parse(response.getContentText());
    if (!data.ok) sendTelegramMessage(chatId, text);
    return data;
  } catch (e) {
    sendTelegramMessage(chatId, text);
    return null;
  }
}

function sendTelegramDocument(chatId, csvString, filename, caption) {
  const url = TELEGRAM_API + "/sendDocument";
  const blob = Utilities.newBlob(csvString, "text/csv", filename);
  const payload = { chat_id: String(chatId), caption: caption, document: blob };
  try {
    UrlFetchApp.fetch(url, { method: "post", payload: payload, muteHttpExceptions: true });
  } catch (e) {}
}

function getTelegramFileContent(fileId) {
  const infoUrl = TELEGRAM_API + "/getFile?file_id=" + fileId;
  const res = UrlFetchApp.fetch(infoUrl, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  if (!data.ok || !data.result.file_path) throw new Error("Unable to retrieve file from Telegram.");
  const downloadUrl = "https://api.telegram.org/file/bot" + TELEGRAM_BOT_TOKEN + "/" + data.result.file_path;
  const fileRes = UrlFetchApp.fetch(downloadUrl, { muteHttpExceptions: true });
  return fileRes.getContentText();
}

/**
 * Run this function once from the Google Apps Script editor to connect Telegram to this web app
 */
function setTelegramWebhook() {
  const webAppUrl = ScriptApp.getService().getUrl();
  if (!webAppUrl) {
    Logger.log("ERROR: You must deploy as a Web App first!");
    return;
  }
  const url = TELEGRAM_API + "/setWebhook?url=" + encodeURIComponent(webAppUrl);
  const response = UrlFetchApp.fetch(url);
  Logger.log("Webhook Response: " + response.getContentText());
}
