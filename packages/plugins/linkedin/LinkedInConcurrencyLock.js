const fs = require("fs-extra");
const path = require("path");
const os = require("os");
const logger = require("../../logger").plugin("linkedin");

class LinkedInConcurrencyLock {
    constructor(lockName = "linkedin_automation.lock") {
        this.lockPath = path.join(os.tmpdir(), lockName);
        this.locked = false;
    }

    acquire() {
        try {
            if (fs.existsSync(this.lockPath)) {
                try {
                    const data = fs.readJsonSync(this.lockPath);
                    if (data && data.pid) {
                        try {
                            process.kill(data.pid, 0); // Throws if PID does not exist
                            logger.warn(`⚠️ LinkedIn process already running under PID ${data.pid} (Lock file: ${this.lockPath}). Exiting as SKIPPED_ALREADY_RUNNING.`);
                            return false;
                        } catch (staleErr) {
                            logger.info(`Cleaning stale lock file from inactive PID ${data.pid}...`);
                            fs.removeSync(this.lockPath);
                        }
                    }
                } catch (readErr) {
                    fs.removeSync(this.lockPath);
                }
            }

            fs.writeJsonSync(this.lockPath, {
                pid: process.pid,
                acquiredAt: new Date().toISOString()
            });

            this.locked = true;

            process.once("exit", () => this.release());
            process.once("SIGINT", () => this.release());
            process.once("SIGTERM", () => this.release());

            return true;
        } catch (err) {
            logger.error(`Failed to acquire LinkedIn lock: ${err.message}`);
            return false;
        }
    }

    release() {
        if (this.locked && fs.existsSync(this.lockPath)) {
            try {
                fs.removeSync(this.lockPath);
                this.locked = false;
            } catch (err) {}
        }
    }
}

module.exports = LinkedInConcurrencyLock;
