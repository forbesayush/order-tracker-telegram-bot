/**
 * Order Tracking Telegram Bot (100% Cloud-Hosted in Google Apps Script)
 *
 * Runs 24/7 on Google Cloud Servers with ZERO local machine or PC required.
 *
 * Features:
 * - Single Order Lookup (Detailed card)
 * - Batch Order Lookup (Multi-line text, list, or uploaded .txt/.csv)
 * - Real-time Progress Tracking in Telegram
 * - Automatic CSV Report Generation & Attachment
 */

// ==================== CONFIGURATION ====================
const TELEGRAM_BOT_TOKEN = "9060968963:AAF_1XvGuUf-NVfvzjnuUph45hfF-WLkpuo";
const TELEGRAM_API = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN;

// The live Master Order Status Web App URL
const PORTAL_URL = "https://script.google.com/macros/s/AKfycbzqOmNRuLVKPAXtS3xwoSRxCzdRp-kOAyeseP9zmNolgp9IPeYyR1cK9hAS0t-2w7XX";
// =======================================================

/**
 * Main Webhook Receiver from Telegram
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

    // 1. Check for uploaded file (.txt or .csv)
    if (msg.document) {
      const doc = msg.document;
      const isText = doc.file_name && (doc.file_name.endsWith(".txt") || doc.file_name.endsWith(".csv"));
      if (isText) {
        sendTelegramMessage(chatId, "📥 *Reading file:* `" + doc.file_name + "`...", msg.message_id);
        const fileContent = getTelegramFileContent(doc.file_id);
        const matches = extractOrderIds(fileContent);
        if (matches.length === 0) {
          sendTelegramMessage(chatId, "⚠️ *No valid 15-20 digit Order IDs found in the file!*", msg.message_id);
          return ContentService.createTextOutput("OK");
        }
        processBatchOrders(chatId, matches, msg.message_id);
        return ContentService.createTextOutput("OK");
      }
    }

    // 2. Check for text message
    if (!msg.text) {
      return ContentService.createTextOutput("OK");
    }

    const text = msg.text.trim();

    // Commands /start or /help
    if (text === "/start" || text === "/help") {
      const welcome =
        "👋 *Hello " + userName + "!*\n\n" +
        "Welcome to the *Order Tracking Bot* (Cloud Hosted on Google Apps Script)!\n\n" +
        "📌 *How to use:*\n" +
        "• *Single Order:* Send one ID (e.g. `351692994041939520`)\n" +
        "• *Batch Check:* Paste multiple IDs at once or upload a `.txt` / `.csv` file\n" +
        "• *CSV Export:* Automatically attaches a downloadable CSV report for batch runs!";
      sendTelegramMessage(chatId, welcome, msg.message_id);
      return ContentService.createTextOutput("OK");
    }

    // Extract Order IDs
    const orderIds = extractOrderIds(text);
    if (orderIds.length === 0) {
      sendTelegramMessage(chatId, "⚠️ *Invalid input!*\n\nPlease send a valid numeric Order ID (e.g. `351692994041939520`), a list of IDs, or upload a .txt/.csv file.", msg.message_id);
      return ContentService.createTextOutput("OK");
    }

    if (orderIds.length === 1) {
      processSingleOrder(chatId, orderIds[0], msg.message_id);
    } else {
      processBatchOrders(chatId, orderIds, msg.message_id);
    }

  } catch (err) {
    Logger.log("doPost Error: " + err.toString());
  }

  return ContentService.createTextOutput("OK");
}

/**
 * Extracts unique 15-20 digit order IDs from any text
 */
function extractOrderIds(text) {
  const matches = text.match(/\b\d{15,20}\b/g);
  if (!matches) return [];
  // Return unique IDs
  return Array.from(new Set(matches));
}

/**
 * Queries the Master Google Apps Script portal via direct RPC POST
 */
function queryPortal(orderId) {
  try {
    const url = PORTAL_URL + "/callback?nocache_id=" + Date.now();
    const payload = "request=" + encodeURIComponent(JSON.stringify(["checkStatus", JSON.stringify([String(orderId)]), null, [0], null, null, 1, 0]));

    const options = {
      method: "post",
      contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      headers: {
        "X-Same-Domain": "1",
        "Referer": PORTAL_URL + "/exec",
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
        if (raw === "Invalid Order ID" || !raw) {
          return "Invalid Order ID";
        }
        if (typeof raw === "string" && raw.startsWith("{")) {
          return JSON.parse(raw);
        }
        return raw;
      }
    }
  } catch (e) {
    Logger.log("Error querying portal for " + orderId + ": " + e.toString());
  }
  return "Invalid Order ID";
}

/**
 * Handles Single Order Check
 */
function processSingleOrder(chatId, orderId, replyToMessageId) {
  const progressRes = sendTelegramMessage(chatId, "🔍 *Checking Order ID:* `" + orderId + "`...", replyToMessageId);
  const progressMsgId = progressRes && progressRes.result ? progressRes.result.message_id : null;

  const result = queryPortal(orderId);

  if (result === "Invalid Order ID" || !result || typeof result !== "object") {
    const notFound =
      "❌ *Order Not Found*\n\n" +
      "Order ID: `" + orderId + "` is *not in the database*.\n" +
      "_Tip: It may belong to a newer batch not yet synced to the master sheet._";
    if (progressMsgId) editTelegramMessage(chatId, progressMsgId, notFound);
    else sendTelegramMessage(chatId, notFound, replyToMessageId);
    return;
  }

  const formStatus = (result.step2 === "Refund Form Filled")
    ? "✅ *Received & Verified*"
    : "⏳ " + (result.step2 || "Pending");

  const settlementStatus = (result.step3 === "Refund Completed")
    ? "✅ *Completed*"
    : (result.step3 && result.step3 !== "Pending")
      ? "⚠️ " + result.step3
      : "⏳ Processing Payment";

  const reply =
    "📦 *Order Details*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "🆔 *Order ID:* `" + orderId + "`\n" +
    "👤 *Buyer:* " + (result.buyerName || "N/A") + "\n" +
    "💰 *Amount:* ₹" + (result.amount || 0) + "\n" +
    "📅 *Order Date:* " + (result.orderDate || "N/A") + "\n\n" +
    "📊 *Status Tracker:*\n" +
    "1️⃣ *Order Status:* ✅ Confirmed\n" +
    "2️⃣ *Refund Form:* " + formStatus + "\n" +
    "3️⃣ *Settlement:* " + settlementStatus;

  if (progressMsgId) {
    editTelegramMessage(chatId, progressMsgId, reply);
  } else {
    sendTelegramMessage(chatId, reply, replyToMessageId);
  }
}

/**
 * Handles Batch Order Check
 */
function processBatchOrders(chatId, orderIds, replyToMessageId) {
  const total = orderIds.length;
  const progressRes = sendTelegramMessage(
    chatId,
    "🔄 *Batch Check Started*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total Orders: *" + total + "*\n⏳ Progress: 0/" + total + " (0%)\n\n_Checking Google Sheet database in cloud..._",
    replyToMessageId
  );
  const progressMsgId = progressRes && progressRes.result ? progressRes.result.message_id : null;

  const foundList = [];
  const notFoundList = [];
  let totalAmount = 0;
  let lastEditTime = Date.now();

  for (let i = 0; i < total; i++) {
    const orderId = orderIds[i];
    const res = queryPortal(orderId);

    if (res && typeof res === "object" && res !== "Invalid Order ID") {
      const amt = parseFloat(res.amount) || 0;
      totalAmount += amt;
      foundList.push({
        orderId: orderId,
        buyerName: res.buyerName || "N/A",
        amount: amt,
        orderDate: res.orderDate || "N/A",
        step1: res.step1 || "Order Placed",
        step2: res.step2 || "Pending",
        step3: res.step3 || "Pending"
      });
    } else {
      notFoundList.push(orderId);
    }

    // Update progress message every few items
    const now = Date.now();
    const isLast = (i === total - 1);
    if (progressMsgId && (now - lastEditTime > 3000 || isLast)) {
      lastEditTime = now;
      const pct = Math.round(((i + 1) / total) * 100);
      editTelegramMessage(
        chatId,
        progressMsgId,
        "🔄 *Batch Check in Progress*\n━━━━━━━━━━━━━━━━━━━━━━\n📦 Total Orders: *" + total + "*\n⏳ Checked: *" + (i + 1) + "/" + total + "* (" + pct + "%)\n✅ Found: *" + foundList.length + "* | ❌ Not Found: *" + notFoundList.length + "*"
      );
    }

    Utilities.sleep(150);
  }

  // Final Summary Message
  let summary =
    "📊 *Batch Check Complete*\n" +
    "━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📦 *Total Orders Checked:* " + total + "\n" +
    "✅ *In Database (Found):* " + foundList.length + "\n" +
    "❌ *Not In Database:* " + notFoundList.length + "\n" +
    "💰 *Total Amount:* ₹" + totalAmount.toFixed(2) + "\n\n";

  if (foundList.length > 0) {
    summary += "✅ *Found Orders:*\n";
    const preview = Math.min(foundList.length, 12);
    for (let k = 0; k < preview; k++) {
      const item = foundList[k];
      const formIcon = item.step2 === "Refund Form Filled" ? "✅" : "⏳";
      const setIcon = item.step3 === "Refund Completed" ? "✅" : "⏳";
      summary += (k + 1) + ". `" + item.orderId + "` — *" + item.buyerName + "* (₹" + item.amount + ")\n   └ Date: " + item.orderDate + " | Form: " + formIcon + " | Pay: " + setIcon + "\n";
    }
    if (foundList.length > preview) {
      summary += "_...and " + (foundList.length - preview) + " more found orders (see attached CSV)_\n";
    }
    summary += "\n";
  }

  if (notFoundList.length > 0) {
    summary += "❌ *Orders Not Found / Invalid (" + notFoundList.length + "):*\n";
    const previewNF = Math.min(notFoundList.length, 10);
    for (let k = 0; k < previewNF; k++) {
      summary += "• `" + notFoundList[k] + "`\n";
    }
    if (notFoundList.length > previewNF) {
      summary += "_...and " + (notFoundList.length - previewNF) + " more (see attached CSV)_\n";
    }
  }

  if (progressMsgId) {
    editTelegramMessage(chatId, progressMsgId, summary);
  } else {
    sendTelegramMessage(chatId, summary, replyToMessageId);
  }

  // Generate and send CSV file
  let csv = "Order ID,Status,Buyer Name,Amount,Order Date,Step 1,Step 2 (Refund Form),Step 3 (Settlement)\n";
  for (let k = 0; k < foundList.length; k++) {
    const item = foundList[k];
    csv += '"' + item.orderId + '","FOUND","' + item.buyerName.replace(/"/g, '""') + '","' + item.amount + '","' + item.orderDate + '","' + item.step1 + '","' + item.step2 + '","' + item.step3 + '"\n';
  }
  for (let k = 0; k < notFoundList.length; k++) {
    csv += '"' + notFoundList[k] + '","NOT FOUND","","","","","",""\n';
  }

  const timestamp = Utilities.formatDate(new Date(), "GMT+5:30", "yyyyMMdd_HHmmss");
  sendTelegramDocument(chatId, csv, "batch_orders_report_" + timestamp + ".csv", "📄 Detailed CSV report for " + total + " checked orders.");
}

/**
 * Telegram API Helpers
 */
function sendTelegramMessage(chatId, text, replyToMessageId) {
  const url = TELEGRAM_API + "/sendMessage";
  const payload = {
    chat_id: chatId,
    text: text,
    parse_mode: "Markdown"
  };
  if (replyToMessageId) {
    payload.reply_to_message_id = replyToMessageId;
  }
  try {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    return JSON.parse(response.getContentText());
  } catch (e) {
    Logger.log("sendTelegramMessage error: " + e.toString());
    return null;
  }
}

function editTelegramMessage(chatId, messageId, text) {
  const url = TELEGRAM_API + "/editMessageText";
  const payload = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: "Markdown"
  };
  try {
    const response = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    const data = JSON.parse(response.getContentText());
    if (!data.ok) {
      sendTelegramMessage(chatId, text);
    }
    return data;
  } catch (e) {
    Logger.log("editTelegramMessage error: " + e.toString());
    sendTelegramMessage(chatId, text);
    return null;
  }
}

function sendTelegramDocument(chatId, csvString, filename, caption) {
  const url = TELEGRAM_API + "/sendDocument";
  const blob = Utilities.newBlob(csvString, "text/csv", filename);
  const payload = {
    chat_id: String(chatId),
    caption: caption,
    document: blob
  };
  try {
    UrlFetchApp.fetch(url, {
      method: "post",
      payload: payload,
      muteHttpExceptions: true
    });
  } catch (e) {
    Logger.log("sendTelegramDocument error: " + e.toString());
  }
}

function getTelegramFileContent(fileId) {
  const infoUrl = TELEGRAM_API + "/getFile?file_id=" + fileId;
  const res = UrlFetchApp.fetch(infoUrl, { muteHttpExceptions: true });
  const data = JSON.parse(res.getContentText());
  if (!data.ok || !data.result.file_path) {
    throw new Error("Unable to retrieve file path from Telegram.");
  }
  const downloadUrl = "https://api.telegram.org/file/bot" + TELEGRAM_BOT_TOKEN + "/" + data.result.file_path;
  const fileRes = UrlFetchApp.fetch(downloadUrl, { muteHttpExceptions: true });
  return fileRes.getContentText();
}

/**
 * Run this function once from the Apps Script editor to connect Telegram to this script
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

/**
 * Remove webhook (if switching back to polling)
 */
function deleteTelegramWebhook() {
  const url = TELEGRAM_API + "/deleteWebhook";
  const response = UrlFetchApp.fetch(url);
  Logger.log("Delete Webhook: " + response.getContentText());
}
