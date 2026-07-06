const browserPool = require("../packages/browser/BrowserPool");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const logger = require("../packages/logger");
const telegramService = require("../apps/telegram");
const config = require("../packages/config");
const resumeManager = require("../packages/resume/ResumeManager");
const fs = require("fs");
const path = require("path");

function parseExperience(expStr) {
    if (!expStr) return { min: 0, max: 0 };
    const match = expStr.match(/(\d+)\s*-\s*(\d+)/);
    if (match) {
        return { min: parseInt(match[1], 10), max: parseInt(match[2], 10) };
    }
    const single = expStr.match(/(\d+)/);
    if (single) {
        return { min: parseInt(single[1], 10), max: parseInt(single[1], 10) };
    }
    return { min: 0, max: 0 };
}

function sanitizeFilename(str) {
    return str.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase().substring(0, 30);
}

(async () => {
    logger.automation.info("=== Starting Controlled Live Naukri Run ===");
    
    let browserInstance = null;
    let page = null;
    let plugin = null;
    
    const maxApplicationsLimit = config.search.maxApplicationsPerRun || 5;
    let appliedCount = 0;
    let restartCount = 0;
    
    let stats = {
        found: 0,
        eligible: 0,
        applied: 0,
        alreadyApplied: 0,
        external: 0,
        questionnaire: 0,
        experienceMismatch: 0,
        keywordMismatch: 0,
        duplicates: 0,
        failed: 0,
        skipped: 0
    };

    async function initBrowser() {
        if (browserInstance) {
            try {
                await browserPool.closeAll();
            } catch (e) {}
        }
        logger.automation.info("Requesting active Browser context from pool...");
        browserInstance = await browserPool.getInstance("naukri");
        page = await browserInstance.newPage();
        
        logger.automation.info("Step 1: Commencing Login Verification...");
        const loginOk = await plugin.login(page);
        if (!loginOk) {
            throw new Error("Naukri login failed or could not be established.");
        }
        logger.automation.info("Naukri Login verified successfully!");
    }

    try {
        // Initialize DB and run columns check migrations
        await db.init();
        await db.run("ALTER TABLE jobs ADD COLUMN url TEXT").catch(() => {});
        await db.run("ALTER TABLE jobs ADD COLUMN status TEXT").catch(() => {});
        
        // Load Naukri plugin
        pluginManager.loadPlugins();
        plugin = pluginManager.getPlugin("naukri");
        if (!plugin) throw new Error("Naukri plugin failed to load.");
        
        // Start browser context
        await initBrowser();
        
        // Step 2: Profile Update
        logger.automation.info("Step 2: Commencing Profile and Resume updates...");
        const profileOk = await plugin.updateProfile(page);
        logger.automation.info(`Profile Update sequence completed with status: ${profileOk}`);
        
        // Step 3: Job Search
        logger.automation.info("Step 3: Commencing Job Search query...");
        const rawJobs = await plugin.search(page);
        stats.found = rawJobs.length;
        logger.automation.info(`Retrieved ${rawJobs.length} raw jobs from search queries.`);
        
        const candidateJobs = [];
        
        // Filter jobs based on search filters (experience, location, keywords) and DB status
        for (const job of rawJobs) {
            // Check duplicates in SQLite
            const existingJob = await db.get(
                "SELECT * FROM jobs WHERE portal = 'naukri' AND job_id = ?",
                [job.job_id]
            );
            
            if (existingJob) {
                stats.duplicates++;
                if (existingJob.applied === 1 || existingJob.status === "Applied") {
                    stats.alreadyApplied++;
                    logger.automation.info(`[SKIP] Duplicate (Already Applied in DB): "${job.title}" at "${job.company}"`);
                } else {
                    logger.automation.info(`[SKIP] Duplicate (Skipped/Failed in DB): "${job.title}" at "${job.company}"`);
                }
                continue;
            }
            
            // Validate Title Keyword Match
            const matchesKeyword = config.search.keywords.some(kw => 
                job.title.toLowerCase().includes(kw.toLowerCase())
            );
            if (!matchesKeyword) {
                stats.keywordMismatch++;
                logger.automation.info(`[SKIP] Title keyword mismatch: "${job.title}" does not contain configured keywords.`);
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Keyword mismatch')",
                    [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                ).catch(() => {});
                continue;
            }
            
            // Validate Location Match
            const matchesLocation = config.search.locations.some(loc => 
                job.location.toLowerCase().includes(loc.toLowerCase())
            );
            if (!matchesLocation) {
                stats.keywordMismatch++; // Track under keyword/criteria mismatch
                logger.automation.info(`[SKIP] Location mismatch: "${job.location}" does not match configured locations.`);
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Location mismatch')",
                    [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                ).catch(() => {});
                continue;
            }
            
            // Validate Experience Match
            const jobExp = parseExperience(job.experience);
            const matchesExp = (config.search.minExperience <= jobExp.max) && (config.search.maxExperience >= jobExp.min);
            if (!matchesExp) {
                stats.experienceMismatch++;
                logger.automation.info(`[SKIP] Experience mismatch: Job requires ${job.experience}, but config range is ${config.search.minExperience}-${config.search.maxExperience} yrs.`);
                await db.run(
                    "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Experience mismatch')",
                    [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                ).catch(() => {});
                continue;
            }
            
            candidateJobs.push(job);
        }
        
        stats.eligible = candidateJobs.length;
        logger.automation.info(`Discovered ${candidateJobs.length} eligible matching jobs. Commencing application submissions...`);
        
        let jobIndex = 0;
        
        while (jobIndex < candidateJobs.length && appliedCount < maxApplicationsLimit) {
            const job = candidateJobs[jobIndex];
            
            try {
                logger.automation.info(`Processing job details for: "${job.title}" at "${job.company}"`);
                
                // 1. Navigate to URL
                await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25000 });
                await page.waitForTimeout(2000);
                
                // 2. Pre-Apply Validations
                
                // A. Check if Login Expired
                const loggedIn = await plugin.health(page);
                if (!loggedIn) {
                    logger.automation.warn("Session expired during navigation. Triggering recovery re-login...");
                    const loginOk = await plugin.login(page);
                    if (!loginOk) {
                        stats.failed++;
                        await db.run(
                            "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Failed', 'Login expired')",
                            [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                        ).catch(() => {});
                        jobIndex++;
                        continue;
                    }
                }
                
                // B. Already Applied
                const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied'), div:has-text('Applied')";
                const isAlreadyApplied = await page.locator(alreadyAppliedSelector).count() > 0;
                if (isAlreadyApplied) {
                    stats.alreadyApplied++;
                    stats.skipped++;
                    logger.automation.info(`[SKIP] Already applied detected on details page for: "${job.title}"`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Already applied')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // C. External Company Site Redirection
                const externalApplySelector = "button:has-text('Apply on company website'), a:has-text('Apply on company website'), button:has-text('Apply on company site')";
                const isExternal = await page.locator(externalApplySelector).count() > 0;
                if (isExternal) {
                    stats.external++;
                    stats.skipped++;
                    logger.automation.info(`[SKIP] External website redirect required for: "${job.title}"`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'External redirect')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // D. Questionnaire requiring manual answers pre-apply
                const chatbotSelector = ".chatbot-container, .questionnaire-container, :has-text('Submit answers'), :has-text('Answer questions')";
                const isQuestionnaire = await page.locator(chatbotSelector).count() > 0;
                if (isQuestionnaire) {
                    stats.questionnaire++;
                    stats.skipped++;
                    logger.automation.info(`[SKIP] Questionnaire-heavy listing detected: "${job.title}"`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Questionnaire')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // E. Resume missing verification
                const resumePath = await resumeManager.getResumePath(plugin.name).catch(() => null);
                if (!resumePath || !fs.existsSync(resumePath)) {
                    stats.failed++;
                    logger.automation.warn("Resume missing on local disk.");
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Failed', 'Resume missing')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // F. Missing Apply button
                const applyBtnSelector = "button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')";
                const hasApplyBtn = await page.locator(applyBtnSelector).count() > 0;
                if (!hasApplyBtn) {
                    stats.skipped++;
                    logger.automation.warn("Missing Apply button on listing details page.");
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Missing Apply button')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // G. Unexpected premium prompt / blocking popups
                const popupSelector = ".drawer-wrapper, .modal-header, .premium-popup";
                const popupVisible = await page.locator(popupSelector).count() > 0;
                if (popupVisible) {
                    stats.skipped++;
                    logger.automation.warn("Unexpected popup blocking the UI.");
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Unexpected popup')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // 3. Take Before Screenshot
                const dateStr = new Date().toISOString().split("T")[0];
                const screenshotDir = path.join(process.cwd(), "screenshots", dateStr);
                fs.mkdirSync(screenshotDir, { recursive: true });
                
                const compClean = sanitizeFilename(job.company);
                const roleClean = sanitizeFilename(job.title);
                const beforeScreenshotPath = path.join(screenshotDir, `${compClean}_${roleClean}_before.png`);
                await page.screenshot({ path: beforeScreenshotPath, fullPage: false }).catch(() => {});
                
                // 4. Click Apply
                logger.automation.info(`Submitting application for: "${job.title}" at "${job.company}"`);
                await page.click(applyBtnSelector);
                
                // Wait for page transition
                await page.waitForTimeout(4000);
                
                // 5. Post-Apply Questionnaire / Chatbot Prompt Detection
                const hasPostQuestionnaire = await page.locator(chatbotSelector).count() > 0;
                if (hasPostQuestionnaire) {
                    stats.questionnaire++;
                    stats.skipped++;
                    logger.automation.warn(`Job triggered a post-apply chatbot/questionnaire for: "${job.title}". Skipping application.`);
                    
                    const failedScreenshotPath = path.join(screenshotDir, `${compClean}_${roleClean}_failed.png`);
                    await page.screenshot({ path: failedScreenshotPath }).catch(() => {});
                    
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Questionnaire')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    jobIndex++;
                    continue;
                }
                
                // 6. Verify Application Success State
                const toastSelector = ".toastMessage, .success-toast, :has-text('successfully applied'), :has-text('uploaded successfully'), button:has-text('Applied'), span:has-text('Applied')";
                const appliedSuccessful = await page.locator(toastSelector).count() > 0;
                
                if (appliedSuccessful) {
                    appliedCount++;
                    stats.applied++;
                    
                    // Take success after screenshot
                    const afterScreenshotPath = path.join(screenshotDir, `${compClean}_${roleClean}_after.png`);
                    await page.screenshot({ path: afterScreenshotPath }).catch(() => {});
                    
                    // Update database
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'Applied')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(async () => {
                        // In case it already exists in DB
                        await db.run(
                            "UPDATE jobs SET applied = 1, status = 'Applied', timestamp = CURRENT_TIMESTAMP WHERE portal = 'naukri' AND job_id = ?",
                            [job.job_id]
                        );
                    });
                    
                    logger.automation.info(`Applied successfully: "${job.title}" at "${job.company}"`);
                    
                    // Dispatched immediate Telegram alert
                    const applyMsg = `✅ *Applied Successfully*\n\n` +
                                     `• *Company*: ${job.company}\n` +
                                     `• *Role*: ${job.title}\n` +
                                     `• *Location*: ${job.location}\n` +
                                     `• *Experience*: ${job.experience}\n` +
                                     `• *URL*: ${job.url}\n\n` +
                                     `_Application #${appliedCount} of ${maxApplicationsLimit}_`;
                    await telegramService.sendMessage(applyMsg);
                } else {
                    stats.failed++;
                    logger.automation.warn(`Could not verify application success state for: "${job.title}"`);
                    
                    const failedScreenshotPath = path.join(screenshotDir, `${compClean}_${roleClean}_failed.png`);
                    await page.screenshot({ path: failedScreenshotPath }).catch(() => {});
                    
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Failed', 'Verification timeout')",
                        [job.portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                }
                
                jobIndex++;
            } catch (unexpectedJobErr) {
                // If it is an unexpected loop error (playwright context, navigation failure, page crash)
                logger.automation.error(`Unexpected loop error: ${unexpectedJobErr.message}`);
                
                if (restartCount === 0) {
                    restartCount++;
                    logger.automation.warn("Attempting to restart browser context once to recover loop...");
                    
                    const dateStr = new Date().toISOString().split("T")[0];
                    const screenshotDir = path.join(process.cwd(), "screenshots", dateStr);
                    fs.mkdirSync(screenshotDir, { recursive: true });
                    const errPath = path.join(screenshotDir, `unexpected_error_restart_1.png`);
                    await page.screenshot({ path: errPath, fullPage: true }).catch(() => {});
                    
                    // Try to re-initialize browser
                    await initBrowser();
                    logger.automation.info("Browser context restarted. Resuming job application...");
                    // Do not increment jobIndex so we retry the current job
                    continue;
                }
                
                // If it's the second crash, bubble up to the main catch block
                throw unexpectedJobErr;
            }
        }
        
        // Print Summary Report
        console.log("\n====================================================");
        console.log("               NAUKRI LIVE RUN SUMMARY              ");
        console.log("====================================================");
        console.log(`Jobs Found:          ${stats.found}`);
        console.log(`Eligible:            ${stats.eligible}`);
        console.log(`Applied:             ${stats.applied}`);
        console.log(`Already Applied:     ${stats.alreadyApplied}`);
        console.log(`External:            ${stats.external}`);
        console.log(`Questionnaire:       ${stats.questionnaire}`);
        console.log(`Experience Mismatch: ${stats.experienceMismatch}`);
        console.log(`Keyword Mismatch:    ${stats.keywordMismatch}`);
        console.log(`Duplicates:          ${stats.duplicates}`);
        console.log(`Failed:              ${stats.failed}`);
        console.log("====================================================\n");
        
        // Compute Remaining Daily limit (Naukri default daily limit is 50)
        const todayApplied = await db.get(
            "SELECT COUNT(*) as count FROM jobs WHERE portal = 'naukri' AND applied = 1 AND date(timestamp) = date('now')"
        );
        const remainingDaily = Math.max(0, 50 - (todayApplied ? todayApplied.count : 0));
        
        // Send final detailed summary report to Telegram
        const tgSummary = `🏁 *LIVE RUN COMPLETE*\n\n` +
                          `• *Jobs Found*: ${stats.found}\n` +
                          `• *Eligible*: ${stats.eligible}\n` +
                          `• *Applied*: ${stats.applied}\n` +
                          `• *Already Applied*: ${stats.alreadyApplied}\n` +
                          `• *External*: ${stats.external}\n` +
                          `• *Questionnaire*: ${stats.questionnaire}\n` +
                          `• *Experience Mismatch*: ${stats.experienceMismatch}\n` +
                          `• *Keyword Mismatch*: ${stats.keywordMismatch}\n` +
                          `• *Duplicates*: ${stats.duplicates}\n` +
                          `• *Failed*: ${stats.failed}\n` +
                          `• *Remaining Daily Limit*: ${remainingDaily}`;
        await telegramService.sendMessage(tgSummary);
        
        await browserPool.closeAll();
        process.exit(0);
        
    } catch (err) {
        logger.automation.error(`Fatal Live Run failure: ${err.message}`);
        
        // Attempt failure screenshot
        const dateStr = new Date().toISOString().split("T")[0];
        const screenshotDir = path.join(process.cwd(), "screenshots", dateStr);
        fs.mkdirSync(screenshotDir, { recursive: true });
        const finalErrPath = path.join(screenshotDir, `fatal_error_run_failure.png`);
        if (page) {
            await page.screenshot({ path: finalErrPath, fullPage: true }).catch(() => {});
        }
        
        // Send critical alert Telegram alert
        const alertMsg = `🚨 *FATAL RUN FAILURE*\n\n` +
                         `An unexpected error occurred twice or aborted run execution:\n` +
                         `\`${err.message}\`\n\n` +
                         `Execution terminated. Details and screenshot attached.`;
        if (fs.existsSync(finalErrPath)) {
            await telegramService.sendPhoto(finalErrPath, alertMsg);
        } else {
            await telegramService.sendMessage(alertMsg);
        }
        
        await browserPool.closeAll().catch(() => {});
        process.exit(1);
    }
})();
