const path = require("path");
const os = require("os");
const axios = require("axios");
const { fork } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const ORACLE_SERVER_URL = process.env.ORACLE_SERVER_URL || process.env.ORCHESTRATOR_URL || "http://localhost:3005";
const WORKER_ID = "windows";
const HEARTBEAT_INTERVAL_MS = 15000;
const POLL_INTERVAL_MS = 5000;

console.log("==================================================");
console.log("OPENCLAW WINDOWS WORKER AGENT DAEMON");
console.log(`Server Endpoint: ${ORACLE_SERVER_URL}`);
console.log(`Worker Node: ${WORKER_ID} (${os.hostname()} - ${os.platform()})`);
console.log("==================================================\n");

let currentTask = null;
let isExecuting = false;

async function sendHeartbeat() {
    try {
        const status = isExecuting ? "busy" : "online";
        await axios.post(`${ORACLE_SERVER_URL}/api/worker/heartbeat`, {
            workerId: WORKER_ID,
            hostname: os.hostname(),
            platform: os.platform(),
            capabilities: ["naukri", "linkedin", "foundit", "hirist", "cutshort", "instahyre", "wellfound", "remoteok", "weworkremotely"],
            status,
            currentTask: currentTask ? currentTask.id : null,
            lastHeartbeat: Date.now()
        }, { timeout: 8000 });
        console.log(`[Windows Agent] Heartbeat sent (${status})`);
    } catch (err) {
        console.warn(`[Windows Agent Warning] Heartbeat failed: ${err.message}`);
    }
}

async function pollTask() {
    if (isExecuting) return;

    try {
        const res = await axios.get(`${ORACLE_SERVER_URL}/api/worker/poll`, {
            params: { workerId: WORKER_ID },
            timeout: 8000
        });

        if (res.data && res.data.task) {
            const task = res.data.task;
            console.log(`[Windows Agent] Received Task #${task.id.substring(0, 8)}: portal=${task.portal}, action=${task.action}`);
            await executeTask(task);
        }
    } catch (err) {
        // Poll silent fallback
    }
}

async function executeTask(task) {
    isExecuting = true;
    currentTask = task;

    try {
        // 1. Acknowledge Task
        await axios.post(`${ORACLE_SERVER_URL}/api/worker/ack`, {
            taskId: task.id,
            workerId: WORKER_ID
        }, { timeout: 8000 }).catch(() => {});
        console.log(`[Windows Agent] Acknowledged Task #${task.id.substring(0, 8)}`);

        // 2. Select Script
        let scriptPath = null;
        let scriptArgs = [];

        if (task.portal === "naukri") {
            scriptPath = path.join(__dirname, "../../scripts/naukri-windows-launcher.js");
            scriptArgs = ["--task", task.action === "updateProfile" ? "profile" : "jobs"];
        } else if (task.portal === "linkedin") {
            scriptPath = path.join(__dirname, "../../scripts/linkedin-windows-launcher.js");
            scriptArgs = ["--task", task.action === "updateProfile" ? "profile" : "jobs"];
        } else {
            scriptPath = path.join(__dirname, "../../scripts/run-naukri-production.js");
        }

        console.log(`[Windows Agent] Launching script: node ${scriptPath} ${scriptArgs.join(" ")}`);

        const child = fork(scriptPath, scriptArgs, { stdio: "inherit" });

        child.on("exit", async (code) => {
            isExecuting = false;
            currentTask = null;

            if (code === 0) {
                console.log(`[Windows Agent] Task #${task.id.substring(0, 8)} COMPLETED successfully.`);
                await axios.post(`${ORACLE_SERVER_URL}/api/worker/complete`, {
                    taskId: task.id,
                    workerId: WORKER_ID,
                    result: { success: true, exitCode: 0 }
                }, { timeout: 8000 }).catch(() => {});
            } else {
                console.error(`[Windows Agent] Task #${task.id.substring(0, 8)} FAILED with exit code ${code}.`);
                await axios.post(`${ORACLE_SERVER_URL}/api/worker/fail`, {
                    taskId: task.id,
                    workerId: WORKER_ID,
                    error: `Process exited with error code ${code}`
                }, { timeout: 8000 }).catch(() => {});
            }
        });

    } catch (err) {
        console.error(`[Windows Agent Error] Execution failed: ${err.message}`);
        isExecuting = false;
        currentTask = null;
        await axios.post(`${ORACLE_SERVER_URL}/api/worker/fail`, {
            taskId: task.id,
            workerId: WORKER_ID,
            error: err.message
        }, { timeout: 8000 }).catch(() => {});
    }
}

// Start Heartbeat and Polling loops
sendHeartbeat();
setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
setInterval(pollTask, POLL_INTERVAL_MS);

console.log("[Windows Agent] Agent loop started. Listening for tasks...");
