#!/bin/bash
set -e

BACKUP_DIR="/home/ubuntu/automation/backups"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
TARGET_DIR="${BACKUP_DIR}/candidate_backup_${TIMESTAMP}"

mkdir -p "${TARGET_DIR}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Candidate Knowledge Database & Asset Backup..."

# 1. Backup SQLite Database
if [ -f "/home/ubuntu/automation/database.sqlite" ]; then
    cp "/home/ubuntu/automation/database.sqlite" "${TARGET_DIR}/database.sqlite"
fi

# 2. Backup CV Resumes
if [ -d "/home/ubuntu/automation/resumes" ]; then
    cp -r "/home/ubuntu/automation/resumes" "${TARGET_DIR}/resumes"
fi

# 3. Create compressed archive
cd "${BACKUP_DIR}"
tar -czf "candidate_backup_${TIMESTAMP}.tar.gz" "candidate_backup_${TIMESTAMP}"
rm -rf "candidate_backup_${TIMESTAMP}"

# 4. Purge backups older than 14 days
find "${BACKUP_DIR}" -name "candidate_backup_*.tar.gz" -mtime +14 -exec rm -f {} \;

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Candidate Knowledge Backup Completed: ${BACKUP_DIR}/candidate_backup_${TIMESTAMP}.tar.gz"
