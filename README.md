# Order Tracker Telegram Bot

A Telegram Bot that queries and tracks live order status, buyer information, and refund/settlement milestones from a Google Apps Script Master Portal in real-time.

Built using Node.js and Chrome DevTools Protocol (CDP) for high-performance, headless browser communication.

---

## Features

- **Live Order Lookup:** Send any Order ID (e.g. `351692994041939520`) to the bot to retrieve live data directly from the master sheet portal.
- **Smart ID Extraction:** Detects 15–20 digit numeric Order IDs whether sent standalone or within sentences/notes.
- **Detailed Progress Tracker:**
  -  **Order Confirmation** (Date & Status)
  -  **Refund Form** (Submission & Verification Status)
  -  **Final Settlement** (Payment verification & completion)
- **Zero Heavy Dependencies:** Uses native Node.js capabilities (`fetch`, `WebSocket`, `child_process`).
- **Cross-Platform:** Runs seamlessly on Windows, macOS, Linux, and Docker.

---

## Quick Start (Local Setup)

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
   *(Alternatively, set the environment variable: `TELEGRAM_BOT_TOKEN="your_token"`)*

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

## 24/7 Cloud Hosting (Docker)

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

## Project Structure

```
├── bot.js               # Main bot logic and Chrome CDP runner
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
