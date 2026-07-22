#!/bin/bash
set -e

LOCK_FILE="/tmp/hirist_automation.lock"
exec 200>"$LOCK_FILE"

if ! flock -n 200; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] HIRIST_RUN_SKIPPED_ALREADY_RUNNING"
    exit 0
fi

cd /home/ubuntu/automation
export NODE_ENV=production
mkdir -p /home/ubuntu/automation/logs

LOG_FILE="/home/ubuntu/automation/logs/hirist_scheduled_$(date '+%Y-%m-%d').log"

echo "==================================================" >> "$LOG_FILE"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Hirist Scheduled Automation Run Started" >> "$LOG_FILE"
echo "==================================================" >> "$LOG_FILE"

/usr/bin/node scripts/run-hirist-scheduled.js >> "$LOG_FILE" 2>&1
