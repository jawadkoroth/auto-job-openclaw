# Autonomous Job Automation Platform

An enterprise-ready, modular, and AI-orchestrated job automation platform designed to run 24/7 on an Oracle Cloud Ubuntu VM inside Docker. The system automates Naukri profile updates twice daily, searches and applies for jobs across multiple job portals (Naukri, LinkedIn, Foundit, Hirist, Instahyre), sends alerts and failure screenshots via Telegram, and features an intelligent natural language orchestration layer powered by OpenClaw AI.

---

## 🛠️ Repository Architecture

The codebase is refactored into clean separation of concerns matching standard monorepo-style systems:

```text
apps/
  ├── scheduler/        # Cron daemon scheduling twice-daily updates and applies
  ├── worker/           # Core job execution wrapper with retries and recovery
  └── telegram/         # Interactive Telegram command listener and alerting bot

packages/
  ├── browser/          # Playwright Chromium lifecycle (BrowserManager)
  ├── session/          # Cookie/profile directory manager (SessionManager)
  ├── logger/           # Structured console, file, and JSON logger (Winston)
  ├── config/           # Consolidated .env and application config manager
  ├── ai/               # OpenClaw AI natural language processing (OpenRouter)
  └── plugins/          # Extensible portal automation plugins
        ├── BasePlugin.js
        ├── PluginManager.js
        ├── naukri/     # Multi-module Naukri automation
        ├── linkedin/   # LinkedIn automation skeleton
        ├── foundit/    # Foundit automation skeleton
        ├── hirist/     # Hirist automation skeleton
        └── instahyre/  # Instahyre automation skeleton
```

For detailed guides, please refer to the documentation in [docs/](file:///c:/Users/JAWAD%20KOROTH/Documents/auto-job-openclaw/auto-job-openclaw/docs):
* [Architecture & System Flow](file:///c:/Users/JAWAD%20KOROTH/Documents/auto-job-openclaw/auto-job-openclaw/docs/architecture.md)
* [Production Deployment Guide](file:///c:/Users/JAWAD%20KOROTH/Documents/auto-job-openclaw/auto-job-openclaw/docs/deployment.md)
* [Failure Recovery & Debugging](file:///c:/Users/JAWAD%20KOROTH/Documents/auto-job-openclaw/auto-job-openclaw/docs/recovery.md)
* [Creating Portal Plugins](file:///c:/Users/JAWAD%20KOROTH/Documents/auto-job-openclaw/auto-job-openclaw/docs/plugins.md)

---

## 🚀 Getting Started

### 1. Prerequisites
* Node.js v18 or later
* Docker and Docker Compose (for production deployment)

### 2. Configuration Setup
Clone the environment template and populate it with your API tokens and credentials:
```bash
cp .env.example .env
```

Parameters inside `.env`:
* `TELEGRAM_BOT_TOKEN` & `TELEGRAM_CHAT_ID`: Credentials to receive real-time execution alerts and failed execution screenshots.
* `OPENROUTER_API_KEY`: API Key for OpenClaw AI natural language command parsing.
* Portal credentials (`NAUKRI_EMAIL`, etc.) for logging in.

### 3. Local Verification Tests
Verify the installation by running the validation suite:
```bash
# Install dependencies
npm install

# Test logging outputs
node scripts/test-logger.js

# Test AI natural language command parsing fallback
node scripts/test-ai.js

# Validate Playwright Browser launch, healthcheck, and screenshots
node scripts/test-browser-manager.js

# Validate Worker executing skeleton flows
node scripts/test-worker.js
```

---

## 🐳 Docker Deployment (Production)

The platform is designed to be fully containerized. Both the Scheduler and the interactive Telegram Bot run as isolated services but share session caches to avoid re-authentications.

### Build and Launch Containers
```bash
docker-compose -f docker/docker-compose.yml up -d --build
```

### Inspect Container Logs
```bash
# View Scheduler logs
docker logs -f job_scheduler

# View Telegram Bot logs
docker logs -f job_telegram_bot
```
