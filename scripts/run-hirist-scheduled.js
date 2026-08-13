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
const config = require("../packages/config");
const { validatePortalConfig } = require("../packages/config/validation");
const pluginManager = require("../packages/plugins/PluginManager");
const browserPool = require("../packages/browser/BrowserPool");
const { checkExperienceEligibility } = require("../packages/router/ExperienceEligibilityFilter");
const { checkLocationEligibility } = require("../packages/router/LocationEligibilityFilter");
const intelligentJobRanker = require("../packages/router/IntelligentJobRanker");

function normalizeFailureReason(errMessage, statusReason) {
    const raw = String(statusReason || errMessage || "").toUpperCase();
    if (raw.includes("AUTH") || raw.includes("SESSION") || raw.includes("LOGIN") || raw.includes("401")) {
        return "AUTH_SESSION_EXPIRED";
    }
    if (raw.includes("APPLY_BUTTON_NOT_FOUND") || raw.includes("NO STANDARD APPLY") || raw.includes("BUTTON NOT FOUND")) {
        return "APPLY_BUTTON_NOT_FOUND";
    }
    if (raw.includes("FORM") || raw.includes("DRAWER") || raw.includes("NOT_REACHED")) {
        return "FORM_NOT_REACHED";
    }
    if (raw.includes("PROFILE") || raw.includes("INCOMPLETE")) {
        return "PROFILE_INCOMPLETE";
    }
    if (raw.includes("RESUME") || raw.includes("UPLOAD")) {
        return "RESUME_UPLOAD_FAILED";
    }
    if (raw.includes("QUESTION") || raw.includes("QUESTIONNAIRE")) {
        return "QUESTION_UNRESOLVED";
    }
    if (raw.includes("SELECTOR") || raw.includes("DOM")) {
        return "SELECTOR_CHANGED";
    }
    if (raw.includes("BLOCKED") || raw.includes("SAFETY")) {
        return "SUBMISSION_BLOCKED";
    }
    if (raw.includes("BROWSER") || raw.includes("TIMEOUT") || raw.includes("PLAYWRIGHT") || raw.includes("TARGET CLOSED")) {
        return "BROWSER_ERROR";
    }
    return statusReason || "UNKNOWN_ERROR";
}

(async () => {
    const runStart = Date.now();
    const startTimeStr = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    
    // Effective execution mode resolution
    const dryRunEnv = process.env.DRY_RUN;
    const allowLiveEnv = process.env.ALLOW_LIVE_APPLICATIONS;
    const singleJobAllowlist = process.env.SINGLE_JOB_ALLOWLIST || null;

    const isDryRunEffective = dryRunEnv !== undefined ? (dryRunEnv === "true") : (config.search.dryRun === true);
    const isAllowLiveEffective = allowLiveEnv !== undefined ? (allowLiveEnv === "true") : (config.search.allowLiveApplications === true);
    const isLiveSubmissionAllowed = (!isDryRunEffective) && isAllowLiveEffective;

    console.log("==================================================");
    console.log("HIRIST SCHEDULED AUTOMATION RUNNER");
    console.log(`Run Started: ${new Date().toISOString()}`);
    console.log(`Trigger Time: ${startTimeStr} IST`);
    console.log(`Portal: Hirist`);
    console.log("--------------------------------------------------");
    console.log(`HIRIST EFFECTIVE EXECUTION MODE:`);
    console.log(`DRY_RUN: ${isDryRunEffective ? "TRUE" : "FALSE"} (Source: ${dryRunEnv !== undefined ? ".env/CLI" : "application default"})`);
    console.log(`ALLOW_LIVE_APPLICATIONS: ${isAllowLiveEffective ? "TRUE" : "FALSE"} (Source: ${allowLiveEnv !== undefined ? ".env/CLI" : "application default"})`);
    console.log(`SINGLE_JOB_ALLOWLIST: ${singleJobAllowlist || "NONE"} (Source: ${singleJobAllowlist ? ".env/CLI" : "application default"})`);
    console.log(`LIVE_SUBMISSION_ALLOWED: ${isLiveSubmissionAllowed ? "TRUE" : "FALSE"}`);
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
    let applicationsDryRunCount = 0;
    let applicationsFailed = 0;
    let applicationsWaitingInput = 0;
    let applicationsPendingVerification = 0;
    
    // Failure Breakdown map
    const failureBreakdown = {};

    let browserInstance = null;
    let page = null;

    // Cleanup stale lock files before browser launch
    try {
        const lockFile = path.join(process.cwd(), "sessions", "hirist", "SingletonLock");
        if (fs.existsSync(lockFile)) {
            fs.removeSync(lockFile);
            console.log("[Hirist Scheduled] Removed stale profile SingletonLock file.");
        }
    } catch (e) {}

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

        const diagStats = {
            discovered: rawJobs.length,
            roleEligible: 0,
            roleRejected: 0,
            sreRejected: 0,
            expEligible: 0,
            expRejected: 0,
            locEligible: 0,
            locRejected: 0,
            duplicate: 0,
            applyTypeRejected: 0,
            finalEligible: 0
        };

        const eligibleJobsList = [];
        const rejectedJobsList = [];

        console.log(`\n--- HIRIST DIAGNOSTIC DISCOVERY TRACE (${rawJobs.length} Jobs Discovered) ---`);
        for (const job of rawJobs) {
            // Single Job Allowlist Filter
            if (singleJobAllowlist && String(job.job_id) !== String(singleJobAllowlist)) {
                continue;
            }

            const isDup = await db.isDuplicateJob("hirist", job.job_id);
            if (isDup) diagStats.duplicate++;

            const isSre = intelligentJobRanker.isSreRole(job.title);
            if (isSre) diagStats.sreRejected++;

            const matchesKeyword = config.search.keywords ? config.search.keywords.some(kw => job.title.toLowerCase().includes(kw.toLowerCase())) : true;
            if (matchesKeyword && !isSre) diagStats.roleEligible++;
            else if (!isSre) diagStats.roleRejected++;

            const expEval = checkExperienceEligibility(job.experience);
            if (expEval.eligible) diagStats.expEligible++;
            else diagStats.expRejected++;

            const locEval = checkLocationEligibility(job.location, job.title);
            if (locEval.eligible) diagStats.locEligible++;
            else diagStats.locRejected++;

            const applyType = intelligentJobRanker.detectApplyType(job);
            const rankResult = intelligentJobRanker.rankJob(job);

            let rejectionReason = "NONE";
            if (isDup) rejectionReason = "DUPLICATE_JOB";
            else if (isSre) rejectionReason = "SRE_EXCLUDED";
            else if (!matchesKeyword) rejectionReason = "KEYWORD_ROLE_MISMATCH";
            else if (!expEval.eligible) rejectionReason = expEval.reason;
            else if (!locEval.eligible) rejectionReason = locEval.reason;
            else if (!rankResult.isEligible) rejectionReason = rankResult.ineligibleReason || "RANKER_INELIGIBLE";

            const isFinalEligible = !isDup && !isSre && matchesKeyword && expEval.eligible && locEval.eligible && rankResult.isEligible;

            if (isFinalEligible) {
                diagStats.finalEligible++;
                eligibleJobsList.push({
                    ...job,
                    applyType,
                    rankScore: rankResult.rankScore,
                    selectionReason: rankResult.selectionReason
                });
            } else {
                rejectedJobsList.push({
                    ...job,
                    rejectionReason
                });
            }

            console.log(`[Job ${job.job_id}] "${job.title}" at "${job.company}"`);
            console.log(`  ├─ Loc: "${job.location}" | Exp: "${job.experience}" | Age: "${job.postedAgo || 'N/A'}" | ApplyType: ${applyType}`);
            console.log(`  ├─ Dup: ${isDup ? 'YES' : 'NO'} | SRE: ${isSre ? 'REJECTED' : 'PASS'} | RoleMatch: ${matchesKeyword ? 'PASS' : 'REJECTED'} | Exp: ${expEval.eligible ? 'PASS' : 'FAIL'} | Loc: ${locEval.eligible ? 'PASS' : 'FAIL'}`);
            console.log(`  └─ Final Status: ${isFinalEligible ? '✅ ELIGIBLE (Score: ' + rankResult.rankScore + ')' : '❌ INELIGIBLE (' + rejectionReason + ')'}`);
        }

        console.log("\n==================================================");
        console.log("FIRST 10 REJECTED JOBS");
        console.log("==================================================");
        rejectedJobsList.slice(0, 10).forEach((j, idx) => {
            console.log(`${idx + 1}. Title: "${j.title}" | Company: "${j.company}"`);
            console.log(`   Location: "${j.location}" | Exp: "${j.experience}" | Age: "${j.postedAgo || 'N/A'}"`);
            console.log(`   Rejection Reason: ${j.rejectionReason}`);
        });

        console.log("\n==================================================");
        console.log("FIRST 10 ELIGIBLE JOBS");
        console.log("==================================================");
        eligibleJobsList.slice(0, 10).forEach((j, idx) => {
            console.log(`${idx + 1}. Title: "${j.title}" | Company: "${j.company}"`);
            console.log(`   Location: "${j.location}" | Exp: "${j.experience}" | Age: "${j.postedAgo || 'N/A'}"`);
            console.log(`   ApplyType: ${j.applyType} | Rank Score: ${j.rankScore} | Reason: ${j.selectionReason}`);
        });

        console.log("\n==================================================");
        console.log("HIRIST DISCOVERY DIAGNOSTIC AGGREGATE SUMMARY");
        console.log("==================================================");
        console.log(`Discovered: ${diagStats.discovered}`);
        console.log(`Role Eligible: ${diagStats.roleEligible}`);
        console.log(`Role Rejected: ${diagStats.roleRejected}`);
        console.log(`SRE Rejected: ${diagStats.sreRejected}`);
        console.log(`Experience Eligible: ${diagStats.expEligible}`);
        console.log(`Experience Rejected: ${diagStats.expRejected}`);
        console.log(`Location Eligible: ${diagStats.locEligible}`);
        console.log(`Location Rejected: ${diagStats.locRejected}`);
        console.log(`Duplicate: ${diagStats.duplicate}`);
        console.log(`Apply Type Eligible: ${diagStats.finalEligible}`);
        console.log(`Final Eligible: ${diagStats.finalEligible}`);
        console.log("==================================================\n");

        jobsEligible = eligibleJobsList.length;

        // Sort eligible jobs by rank score
        eligibleJobsList.sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0));

        for (const job of eligibleJobsList) {
            applicationsAttempted++;

            let applyResult = null;
            let applyError = null;
            try {
                applyResult = await plugin.apply(page, job);
            } catch (err) {
                applyError = err;
            }

            const statusReason = job.statusReason || "";
            const isSuccessBool = applyResult === true || (applyResult && (applyResult.status === "APPLIED" || applyResult.status === "DRY_RUN"));

            if (isSuccessBool) {
                if (statusReason === "dry_run_validated" || isDryRunEffective) {
                    applicationsDryRunCount++;
                    console.log(`[Hirist Scheduled] [DRY RUN] Job ${job.job_id} ("${job.title}" at "${job.company}") validated successfully.`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'DRY_RUN', 'Dry run validated') ON CONFLICT(portal, job_id) DO UPDATE SET status = 'DRY_RUN', reason = 'Dry run validated'",
                        ["hirist", job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                } else if (statusReason === "submission_pending_verification" || job.status === "SUBMISSION_PENDING_VERIFICATION") {
                    applicationsSubmitted++;
                    applicationsPendingVerification++;
                    console.log(`[Hirist Scheduled] Job ${job.job_id} submitted (pending verification).`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'SUBMISSION_PENDING_VERIFICATION', 'Click executed, confirmation pending verification') ON CONFLICT(portal, job_id) DO UPDATE SET status = 'SUBMISSION_PENDING_VERIFICATION', applied = 1, reason = 'Click executed, confirmation pending verification'",
                        ["hirist", job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                } else {
                    applicationsSubmitted++;
                    console.log(`[Hirist Scheduled] Job ${job.job_id} applied and verified.`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'VERIFIED_APPLIED', 'Successfully verified applied') ON CONFLICT(portal, job_id) DO UPDATE SET status = 'VERIFIED_APPLIED', applied = 1, reason = 'Successfully verified applied'",
                        ["hirist", job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                }
            } else if (statusReason === "questionnaire" || (applyResult && applyResult.status === "WAITING_FOR_INPUT")) {
                applicationsWaitingInput++;
                console.log(`[Hirist Scheduled] Job ${job.job_id} waiting for questionnaire input.`);
            } else if (statusReason === "alreadyApplied") {
                jobsSkippedDuplicate++;
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'ALREADY_APPLIED', 'Already applied') ON CONFLICT(portal, job_id) DO UPDATE SET status = 'ALREADY_APPLIED', applied = 1, reason = 'Already applied'",
                    ["hirist", job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                ).catch(() => {});
            } else {
                applicationsFailed++;
                const failCategory = normalizeFailureReason(applyError ? applyError.message : null, statusReason);
                failureBreakdown[failCategory] = (failureBreakdown[failCategory] || 0) + 1;

                console.error(`[Hirist Scheduled] Job ${job.job_id} failed. Reason: ${failCategory} (Message: ${applyError ? applyError.message : statusReason})`);
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'FAILED', ?) ON CONFLICT(portal, job_id) DO UPDATE SET status = 'FAILED', reason = ?",
                    ["hirist", job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url, failCategory, failCategory]
                ).catch(() => {});
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
    console.log(`Applications Submitted (Live): ${applicationsSubmitted}`);
    console.log(`Applications Validated (Dry Run): ${applicationsDryRunCount}`);
    console.log(`Applications Failed: ${applicationsFailed}`);
    console.log(`Applications Waiting For Input: ${applicationsWaitingInput}`);
    if (applicationsFailed > 0) {
        console.log(`Failure Breakdown: ${JSON.stringify(failureBreakdown, null, 2)}`);
    }
    console.log(`Run Completed: ${new Date().toISOString()}`);
    console.log(`Execution Duration: ${durationSec} seconds`);
    console.log("==================================================\n");

    // Send Telegram Summary
    const slotHour = new Date().getHours();
    const slotName = slotHour < 12 ? "10:00 AM IST" : "2:00 PM IST";

    let failureBreakdownStr = "";
    if (applicationsFailed > 0) {
        failureBreakdownStr = `\n<b>Failure Breakdown:</b>\n` +
            Object.entries(failureBreakdown).map(([k, v]) => `• <code>${k}</code>: ${v}`).join("\n");
    }

    const appliedOrDryRunLabel = isDryRunEffective ? `<b>Dry Run Validated:</b> ${applicationsDryRunCount}` : `<b>Applied:</b> ${applicationsSubmitted}`;

    const tgSummary = `<b>Hirist Automation Complete</b>\n\n` +
                      `<b>Run:</b> ${slotName}\n` +
                      `<b>Mode:</b> ${isLiveSubmissionAllowed ? "LIVE" : "DRY RUN"}\n` +
                      `<b>Jobs Discovered:</b> ${jobsDiscovered}\n` +
                      `<b>Eligible:</b> ${jobsEligible}\n` +
                      `${appliedOrDryRunLabel}\n` +
                      `<b>Skipped/Duplicate:</b> ${jobsSkippedDuplicate}\n` +
                      `<b>Failed:</b> ${applicationsFailed}\n` +
                      `<b>Waiting for Input:</b> ${applicationsWaitingInput}${failureBreakdownStr}\n` +
                      `<b>Runtime:</b> ${durationSec}s`;

    await telegramService.sendMessage(tgSummary).catch(() => {});

    process.exit(0);
})();
