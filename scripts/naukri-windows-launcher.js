const path = require("path");
const fs = require("fs-extra");
const https = require("https");
const http = require("http");
const { execSync, fork } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const logger = require("../packages/logger").plugin("naukri");
const telegramService = require("../apps/telegram");
const NaukriConcurrencyLock = require("../packages/plugins/naukri/NaukriConcurrencyLock");
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");

const STATE_FILE = path.join(process.cwd(), "sessions", "naukri", "naukri_schedule_state.json");
fs.mkdirpSync(path.dirname(STATE_FILE));

function getTodayIstDateStr() {
    return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
}

function getNowIstTime() {
    const d = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "Asia/Kolkata",
        hour: "numeric",
        minute: "numeric",
        hour12: false
    }).formatToParts(d);
    let hour = 0;
    let minute = 0;
    for (const p of parts) {
        if (p.type === "hour") hour = parseInt(p.value, 10);
        if (p.type === "minute") minute = parseInt(p.value, 10);
    }
    return { hour, minute, totalMinutes: hour * 60 + minute };
}

function readScheduleState() {
    if (fs.existsSync(STATE_FILE)) {
        try {
            return fs.readJsonSync(STATE_FILE) || {};
        } catch (e) {}
    }
    return {};
}

function writeScheduleState(state) {
    try {
        fs.writeJsonSync(STATE_FILE, state, { spaces: 2 });
    } catch (e) {}
}

function markSlotState(dateStr, slotName, status, reason = null) {
    const state = readScheduleState();
    if (!state[dateStr]) state[dateStr] = {};
    state[dateStr][slotName] = {
        status,
        updatedAt: new Date().toISOString(),
        reason
    };
    writeScheduleState(state);
}

function checkHttpsConnectivity(urlStr, timeoutMs = 4000) {
    return new Promise((resolve) => {
        try {
            const parsed = new URL(urlStr);
            const lib = parsed.protocol === "https:" ? https : http;
            const req = lib.request(urlStr, { method: "HEAD", timeout: timeoutMs }, (res) => {
                resolve(res.statusCode < 500 || res.statusCode === 403);
            });
            req.on("error", () => resolve(false));
            req.on("timeout", () => { req.destroy(); resolve(false); });
            req.end();
        } catch (e) {
            resolve(false);
        }
    });
}

async function checkInternetConnection() {
    // Check reachability to Naukri & Oracle API
    const naukriOnline = await checkHttpsConnectivity("https://www.naukri.com");
    const googleOnline = await checkHttpsConnectivity("https://www.google.com");
    const oracleOnline = await checkHttpsConnectivity("http://140.245.212.88:3005/api/naukri/daily-count");

    if (naukriOnline || googleOnline || oracleOnline) {
        return { isOnline: true, naukriOnline, oracleOnline };
    }
    return { isOnline: false, naukriOnline: false, oracleOnline: false };
}

async function main() {
    const args = process.argv.slice(2);
    const taskType = args.includes("--task") ? args[args.indexOf("--task") + 1] : "jobs"; // 'profile' or 'jobs'

    logger.info(`==================================================`);
    logger.info(`NAUKRI WINDOWS LAUNCHER WRAPPER`);
    logger.info(`Task Type: ${taskType.toUpperCase()}`);
    logger.info(`Execution Time: ${new Date().toISOString()}`);
    logger.info(`==================================================\n`);

    const lock = new NaukriConcurrencyLock("naukri_runner.lock");
    if (!lock.acquire()) {
        logger.warn("⚠️ Naukri worker is already running. Launcher exiting cleanly.");
        process.exit(0);
    }

    const dateStr = getTodayIstDateStr();
    const timeIst = getNowIstTime();
    const state = readScheduleState();
    const dateState = state[dateStr] || {};

    // Determine due slots based on IST time
    const dueSlots = [];
    if (taskType === "profile") {
        if (timeIst.totalMinutes >= (9 * 60 + 30)) dueSlots.push("profile_0930");
        if (timeIst.totalMinutes >= (14 * 60 + 0)) dueSlots.push("profile_1400");
    } else {
        if (timeIst.totalMinutes >= (9 * 60 + 45)) dueSlots.push("jobs_0945");
        if (timeIst.totalMinutes >= (14 * 60 + 15)) dueSlots.push("jobs_1415");
    }

    // Filter slots not completed yet today
    const uncompletedSlots = dueSlots.filter(slot => {
        const s = dateState[slot];
        return !s || s.status !== "COMPLETED";
    });

    if (uncompletedSlots.length === 0 && !args.includes("--force")) {
        logger.info(`✓ All due slots for ${taskType.toUpperCase()} on ${dateStr} are already COMPLETED.`);
        lock.release();
        process.exit(0);
    }

    logger.info(`Due Uncompleted Slot(s): [${uncompletedSlots.join(", ")}] (Coalesced into 1 Execution Run)`);

    // 1. Internet Reachability Preflight
    const net = await checkInternetConnection();
    if (!net.isOnline) {
        logger.warn("⚠️ Windows host is currently OFFLINE / Internet Unreachable. Deferring scheduled run.");
        for (const slot of uncompletedSlots) {
            markSlotState(dateStr, slot, "DEFERRED_OFFLINE", "No Internet Connection");
        }
        lock.release();
        process.exit(0);
    }

    // 2. Naukri Session Auth Preflight
    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status === "SESSION_EXPIRED") {
        logger.error("❌ Session expired during preflight. Halting run.");
        for (const slot of uncompletedSlots) {
            markSlotState(dateStr, slot, "BLOCKED_AUTH", "SESSION_EXPIRED");
        }
        if (boot.browser) await boot.browser.close().catch(() => {});
        lock.release();
        process.exit(0);
    }

    if (boot.browser) await boot.browser.close().catch(() => {});

    // 3. Execute Target Runner Script
    const scriptToRun = taskType === "profile" 
        ? path.join(__dirname, "run-naukri-profile-refresh.js")
        : path.join(__dirname, "run-naukri-production.js");

    const passArgs = args.filter(a => a !== "--task" && a !== taskType);
    logger.info(`🚀 Launching child worker script: node ${scriptToRun} ${passArgs.join(" ")}`);

    lock.release(); // Release wrapper lock before delegating to runner script's own lock

    const child = fork(scriptToRun, passArgs, { stdio: "inherit" });
    child.on("exit", (code) => {
        if (code === 0) {
            logger.info(`✅ Child worker script completed successfully. Marking slot(s) COMPLETED.`);
            for (const slot of uncompletedSlots) {
                markSlotState(dateStr, slot, "COMPLETED");
            }
        } else {
            logger.error(`❌ Child worker script exited with error code ${code}.`);
            for (const slot of uncompletedSlots) {
                markSlotState(dateStr, slot, "FAILED", `Exit code ${code}`);
            }
        }
    });
}

main().catch(err => {
    logger.error(`Launcher Error: ${err.message}`);
    process.exit(1);
});
