# Order Tracker Telegram Bot

A high-performance Telegram Bot that queries and tracks live order status, buyer information, and refund/settlement milestones from a Google Apps Script Master Portal in real-time.

Built with Node.js and Chrome DevTools Protocol (CDP).

---

## 🚀 Features

- **Single Order Check:** Send any Order ID (e.g. `351692994041939520`) to get a full order status card.
- **⚡ Batch Order Check System:**
  - Paste any number of Order IDs in a single message (multi-line, comma-separated, or text blocks).
  - Automatically deduplicates and extracts 15–20 digit numeric IDs.
  - **Live Progress Updates:** Real-time progress bar (`⏳ Checked: 8/17 (47%)...`).
  - **Batch Summary Report:** Clean breakdown with total checked, count found, count missing, and total amount.
  - **📄 Automatic CSV Export:** Generates and uploads a downloadable `.csv` file to the chat with all details for Excel/Google Sheets.
- **📁 File Upload Support:** Upload a `.txt` or `.csv` file with Order IDs, and the bot will parse and batch-check every order automatically.
- **Zero Heavy Dependencies:** Uses native Node.js capabilities (`fetch`, `WebSocket`, `FormData`, `child_process`).
- **Cross-Platform & Docker Ready:** Ready to run locally or 24/7 on cloud hosting.

---

## 🛠️ Quick Start (Local Setup)

### Prerequisites
- [Node.js 18+](https://nodejs.org/) installed
- [Google Chrome](https://www.google.com/chrome/) installed

### Installation & Run

1. **Clone the repository:**
   ```bash
   git clone https://github.com/forbesayush/order-tracker-telegram-bot.git
   cd order-tracker-telegram-bot
   ```

2. **Configure your Telegram Bot Token:**
   Copy `config.example.json` to `config.json`:
   ```bash
   cp config.example.json config.json
   ```
   Add your token from [@BotFather](https://t.me/BotFather):
   ```json
   {
     "bot_token": "YOUR_ACTUAL_TELEGRAM_BOT_TOKEN"
   }
   ```
   *(Or pass as environment variable: `TELEGRAM_BOT_TOKEN="your_token"`)*

3. **Start the Bot:**
   - **Windows:** Double-click `run.bat` or run:
     ```bash
     node bot.js
     ```
   - **Linux / macOS:**
     ```bash
     node bot.js
     ```

---

## ☁️ 24/7 Cloud Hosting (Docker)

To run the bot 24/7 on a cloud VPS (e.g., DigitalOcean, Hetzner, Render, Railway, or AWS):

1. **Using Docker Compose:**
   ```bash
   docker compose up -d --build
   ```

2. **Using Docker CLI:**
   ```bash
   docker build -t order-tracker-telegram-bot .
   docker run -d --restart=always -e TELEGRAM_BOT_TOKEN="YOUR_TOKEN" order-tracker-telegram-bot
   ```

---

## 📁 Project Structure

```
├── bot.js               # Bot logic, Batch Engine, and Chrome CDP runner
├── config.example.json  # Configuration template
├── run.bat              # Windows one-click launcher
├── Dockerfile           # Production Docker container definition
├── docker-compose.yml   # Multi-container orchestration
├── package.json         # Project metadata
└── README.md            # Documentation
```

---

## License

This project is licensed under the MIT License.
