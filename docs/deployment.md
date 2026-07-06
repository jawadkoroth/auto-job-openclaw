# Production Deployment Guide

This guide explains how to set up, secure, and deploy the Autonomous Job Automation Platform on an Oracle Cloud Ubuntu VM.

---

## 📋 Prerequisites

1. **Docker & Docker Compose**: Install them on your Ubuntu VM:
   ```bash
   sudo apt-get update
   sudo apt-get install -y docker.io docker-compose
   sudo systemctl enable --now docker
   ```
2. **Git**: Clone the repository onto your host VM:
   ```bash
   git clone <your-repository-url> /opt/job-automation
   cd /opt/job-automation
   ```

---

## ⚙️ Configuration Setup

Create your production environment file from the template:
```bash
cp .env.example .env
nano .env
```

Ensure the following settings are configured:
* Set `BROWSER_HEADLESS=true` (crucial for headless cloud VMs).
* Enter valid `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` to receive alert updates.
* Insert `OPENROUTER_API_KEY` for intelligent command processing.
* Provide login details for Naukri and other portals.

---

## 🚀 Running the Platform

Launch the platform containers in detached mode:
```bash
docker-compose -f docker/docker-compose.yml up -d --build
```

This launches two long-running services:
1. `job_scheduler`: Runs the cron daemon to execute scheduled runs.
2. `job_telegram_bot`: Runs the polling listener for your natural language commands.

### Verifying Container Status
```bash
docker ps
```
Both `job_scheduler` and `job_telegram_bot` should show `Up`.

---

## 🔒 Security Best Practices

1. **Host Isolation**: The browser and scheduler run entirely inside the Docker container. Do not modify the host network interface or routing tables. Never install VPNs or WARP directly on the host VM.
2. **Authorized Commands Only**: The Telegram bot strictly verifies incoming `message.chat.id` against the configured `TELEGRAM_CHAT_ID` in `.env` to prevent unauthorized execution of commands.
3. **Environment Security**: The `.env` file, the `./sessions` folder, and the `./screenshots` folder are ignored by git to prevent committing sensitive passwords, credentials, and session keys to source repositories.
