const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

// Explicitly isolate Hirist execution
process.env.ENABLE_HIRIST = "true";
process.env.ENABLE_FOUNDIT = "false";
process.env.ENABLE_LINKEDIN = "false";
process.env.ENABLE_INSTAHYRE = "false";
process.env.ENABLE_WELLFOUND = "false";
process.env.ENABLE_REMOTEOK = "false";
process.env.ENABLE_WWR = "false";
process.env.ENABLE_NAUKRI = "false";

const db = require("../packages/database");
const logger = require("../packages/logger");
const telegramService = require("../apps/telegram");
const { validatePortalConfig } = require("../packages/config/validation");
const pluginManager = require("../packages/plugins/PluginManager");
const browserPool = require("../packages/browser/BrowserPool");
const config = require("../packages/config");

function parseExperience(expStr) {
    if (!expStr) return { min: 0, max: 0 };
    const match = expStr.match(/(\d+)\s*-\s*(\d+)/);
    if (match) return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
    const single = expStr.match(/(\d+)/);
    if (single) return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
    return { min: 0, max: 0 };
}

(async () => {
    const runStart = Date.now();
    const startTimeStr = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    console.log("==================================================");
    console.log("HIRIST SCHEDULED AUTOMATION RUNNER");
    console.log(`Run Started: ${new Date().toISOString()}`);
    console.log(`Trigger Time: ${startTimeStr} IST`);
    console.log("Portal: Hirist");
    console.log("==================================================\n");

    await db.init();

    // Step 1: Validate Hirist authentication
    const validation = await validatePortalConfig("hirist");
    if (validation.status === "AUTH_REQUIRED") {
        console.log("[Hirist Scheduled] Status: AUTH_REQUIRED");
        console.log("[Hirist Scheduled] Session expired or invalid. Notification sent.");
        
        await telegramService.sendMessage(
            `⚠️ <b>Hirist Authentication Needed</b>\n\nThe portable Hirist session has expired or requires login refresh. Please refresh Hirist authentication in a headed browser.`
        ).catch(() => {});
        
        process.exit(0);
    }

    pluginManager.loadPlugins();
    const plugin = pluginManager.getPlugin("hirist");
    if (!plugin) {
        console.error("❌ Hirist plugin not found!");
        process.exit(1);
    }

    let jobsDiscovered = 0;
    let jobsEligible = 0;
    let jobsSkippedDuplicate = 0;
    let applicationsAttempted = 0;
    let applicationsSubmitted = 0;
    let applicationsFailed = 0;
    let applicationsWaitingInput = 0;

    let browserInstance = null;
    let page = null;

    try {
        browserInstance = await browserPool.getInstance("hirist");
        page = await browserInstance.newPage();

        // 1. Login Verification
        const loginOk = await plugin.login(page);
        if (!loginOk) {
            console.log("[Hirist Scheduled] Authentication failed on page check. Marking AUTH_REQUIRED.");
            await telegramService.sendMessage(
                `⚠️ <b>Hirist Authentication Needed</b>\n\nThe portable Hirist session failed authentication check. Please refresh Hirist authentication.`
            ).catch(() => {});
            if (browserInstance) await browserInstance.close();
            process.exit(0);
        }

        // 2. Profile Check
        await plugin.updateProfile(page).catch(() => {});

        // 3. Job Search
        const rawJobs = await plugin.search(page).catch(e => {
            console.error(`[Hirist Scheduled] Job search error: ${e.message}`);
            return [];
        });

        jobsDiscovered = rawJobs.length;

        // Filter and Process Jobs
        const isLive = (config.search.dryRun === false || process.env.DRY_RUN === "false") && 
                       (config.search.allowLiveApplications === true || process.env.ALLOW_LIVE_APPLICATIONS === "true");

        for (const job of rawJobs) {
            const isDup = await db.isDuplicateJob("hirist", job.job_id);
            if (isDup) {
                jobsSkippedDuplicate++;
                continue;
            }

            // Keyword Match
            const matchesKeyword = config.search.keywords.some(kw => job.title.toLowerCase().includes(kw.toLowerCase()));
            if (!matchesKeyword) continue;

            // Location Match
            const matchesLocation = config.search.locations.some(loc => job.location.toLowerCase().includes(loc.toLowerCase()));
            if (!matchesLocation) continue;

            // Experience Match
            const jobExp = parseExperience(job.experience);
            const matchesExp = (config.search.minExperience <= jobExp.max) && (config.search.maxExperience >= jobExp.min);
            if (!matchesExp) continue;

            jobsEligible++;
            applicationsAttempted++;

            const applyResult = await plugin.apply(page, job).catch(err => ({ status: "FAILED", reason: err.message }));

            if (applyResult.status === "APPLIED") {
                applicationsSubmitted++;
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'APPLIED') ON CONFLICT(portal, job_id) DO UPDATE SET status = 'APPLIED', applied = 1",
                    ["hirist", job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                ).catch(() => {});
            } else if (applyResult.status === "WAITING_FOR_INPUT" || applyResult.status === "waiting_for_input") {
                applicationsWaitingInput++;
            } else {
                applicationsFailed++;
            }

            if (applicationsAttempted >= (config.search.maxApplicationsPerRun || 5)) {
                break;
            }
        }

    } catch (err) {
        console.error(`[Hirist Scheduled Error] ${err.message}`);
    } finally {
        if (browserInstance) {
            await browserInstance.close().catch(() => {});
        }
    }

    const durationSec = ((Date.now() - runStart) / 1000).toFixed(1);

    console.log("==================================================");
    console.log("HIRIST SCHEDULED RUN SUMMARY");
    console.log("==================================================");
    console.log(`Run Started: ${new Date(runStart).toISOString()}`);
    console.log(`Trigger Time: ${startTimeStr} IST`);
    console.log(`Portal: Hirist`);
    console.log(`Jobs Discovered: ${jobsDiscovered}`);
    console.log(`Jobs Eligible: ${jobsEligible}`);
    console.log(`Jobs Skipped Duplicate: ${jobsSkippedDuplicate}`);
    console.log(`Applications Attempted: ${applicationsAttempted}`);
    console.log(`Applications Successfully Submitted: ${applicationsSubmitted}`);
    console.log(`Applications Failed: ${applicationsFailed}`);
    console.log(`Applications Waiting For Input: ${applicationsWaitingInput}`);
    console.log(`Run Completed: ${new Date().toISOString()}`);
    console.log(`Execution Duration: ${durationSec} seconds`);
    console.log("==================================================\n");

    // Send Telegram Summary
    const slotHour = new Date().getHours();
    const slotName = slotHour < 12 ? "10:00 AM IST" : "2:00 PM IST";

    const tgSummary = `<b>Hirist Automation Complete</b>\n\n` +
                      `<b>Run:</b> ${slotName}\n` +
                      `<b>Jobs Discovered:</b> ${jobsDiscovered}\n` +
                      `<b>Eligible:</b> ${jobsEligible}\n` +
                      `<b>Applied:</b> ${applicationsSubmitted}\n` +
                      `<b>Skipped/Duplicate:</b> ${jobsSkippedDuplicate}\n` +
                      `<b>Failed:</b> ${applicationsFailed}\n` +
                      `<b>Waiting for Input:</b> ${applicationsWaitingInput}\n` +
                      `<b>Runtime:</b> ${durationSec}s`;

    await telegramService.sendMessage(tgSummary).catch(() => {});

    process.exit(0);
})();
