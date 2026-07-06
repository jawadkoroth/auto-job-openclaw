# Failure Recovery & Debugging Guide

This document describes how the platform handles errors and details procedures for manual diagnostics.

---

## 🔄 Automatic Error Recovery

The platform includes built-in recovery routines to keep the automation working:

1. **Browser Crash Detection**: The `BrowserManager` checks if the Chromium process is alive via its `healthCheck()` method before starting a job. If the page is unresponsive, it automatically restarts Chromium.
2. **Context Interruption**: If a page action crashes mid-run, the `Worker` catches the failure, calls `BrowserManager.takeScreenshot()`, uploads the screenshot to Telegram, and closes/reopens the browser for the next retry attempt.
3. **Queue Continuance**: If a portal plugin permanently fails after all retries (e.g. if the portal layout changed or authentication expired), the `Worker` releases the browser and gracefully ends the task so subsequent scheduled runs can continue.

---

## 🛠️ Troubleshooting & Diagnostics

### 1. Inspecting Logs
To review the structured logs, open the `logs/` directory:
- **`logs/automation.log`**: Human-readable text format logs.
- **`logs/automation.json`**: Structured JSON format for machines or log forwarders.

Inside the Docker container:
```bash
docker logs -f job_scheduler
docker logs -f job_telegram_bot
```

### 2. Resetting Portal Sessions
If a portal's persistent session state gets corrupted, or if you want to force a clean re-login, delete the session folder for that portal:
```bash
# Force fresh login on Naukri
rm -rf sessions/naukri

# Force fresh login on LinkedIn
rm -rf sessions/linkedin
```
The next run will automatically reconstruct the directory and run the login script.

### 3. Capturing Manual Verification Screenshots
To capture the exact state of the browser, check the `screenshots/` directory on the host. Any runtime exception triggers a screenshot:
`screenshots/<timestamp>-<portal>_<action>_fail_attempt_<number>.png`
