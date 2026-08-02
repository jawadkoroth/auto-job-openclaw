const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const logger = require("../logger");

class ScriptRunner {
    constructor() {
        this.scriptsMap = {
            "naukri.updateProfile": "scripts/run-naukri-profile-refresh.js",
            "naukri.apply": "scripts/run-naukri-production.js",
            "hirist.updateProfile": "scripts/run-hirist-scheduled.js",
            "hirist.apply": "scripts/run-hirist-scheduled.js",
            "cutshort.apply": "scripts/run-cutshort-production.js",
            "foundit.apply": "scripts/run-controlled-foundit-live.js",
            "weworkremotely.apply": "scripts/run-weworkremotely-runner.js"
        };
    }

    /**
     * Resolve path to production script for given portal and action
     * @param {string} portal 
     * @param {string} action 
     */
    resolveScriptPath(portal, action) {
        const key = `${portal.toLowerCase()}.${action}`;
        const relativePath = this.scriptsMap[key] || `scripts/run-${portal.toLowerCase()}-production.js`;
        const fullPath = path.join(process.cwd(), relativePath);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
        return null;
    }

    /**
     * Execute real automation script in a child process and AWAIT exit code
     * @param {string} portal Portal name
     * @param {string} action Action name
     * @param {Object} args Additional arguments
     * @returns {Promise<{ success: boolean, exitCode: number, durationMs: number, stdout: string, stderr: string }>}
     */
    async runScript(portal, action, args = {}) {
        const scriptPath = this.resolveScriptPath(portal, action);
        
        if (!scriptPath) {
            logger.worker.warn(`[ScriptRunner] No script registered for ${portal}.${action}. Falling back to default plugin handler.`);
            return null;
        }

        logger.worker.info(`[ScriptRunner] Spawning real automation script: ${path.basename(scriptPath)} (${portal}.${action})`);
        
        const startTime = Date.now();
        let stdout = "";
        let stderr = "";

        return new Promise((resolve) => {
            const childEnv = { ...process.env, PORTAL_ACTION: action, TASK_ARGS: JSON.stringify(args) };
            const child = spawn("node", [scriptPath], {
                cwd: process.cwd(),
                env: childEnv,
                stdio: ["pipe", "pipe", "pipe"]
            });

            child.stdout.on("data", (data) => {
                const chunk = data.toString();
                stdout += chunk;
                logger.worker.info(`[ScriptRunner:stdout] ${chunk.trim()}`);
            });

            child.stderr.on("data", (data) => {
                const chunk = data.toString();
                stderr += chunk;
                logger.worker.warn(`[ScriptRunner:stderr] ${chunk.trim()}`);
            });

            child.on("error", (err) => {
                const durationMs = Date.now() - startTime;
                logger.worker.error(`[ScriptRunner] Child process error: ${err.message}`);
                resolve({
                    success: false,
                    exitCode: 1,
                    durationMs,
                    stdout,
                    stderr: stderr + "\n" + err.message
                });
            });

            child.on("close", (code) => {
                const durationMs = Date.now() - startTime;
                const exitCode = code === null ? 1 : code;
                const success = exitCode === 0;

                logger.worker.info(`[ScriptRunner] Script finished: ${path.basename(scriptPath)} (Exit Code: ${exitCode}, Duration: ${(durationMs / 1000).toFixed(1)}s)`);
                
                resolve({
                    success,
                    exitCode,
                    durationMs,
                    stdout,
                    stderr
                });
            });
        });
    }
}

module.exports = new ScriptRunner();
