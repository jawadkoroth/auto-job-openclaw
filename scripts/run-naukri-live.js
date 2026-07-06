const browserPool = require("../packages/browser/BrowserPool");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const logger = require("../packages/logger");
const telegramService = require("../apps/telegram");
const config = require("../packages/config");

/**
 * Parse experience string (e.g. "2 - 5 Yrs", "3 - 8 Yrs", "0 - 1 Yrs")
 * @param {string} expStr 
 * @returns {{min: number, max: number}}
 */
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

(async () => {
    logger.automation.info("=== Starting Live Naukri Verification Run ===");
    
    let browserInstance = null;
    let page = null;
    
    try {
        // Initialize DB
        await db.init();
        
        // Load Naukri plugin
        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin("naukri");
        if (!plugin) throw new Error("Naukri plugin failed to load.");
        
        // Resolve DRY_RUN mode
        const isDryRun = process.env.DRY_RUN === "true" || config.search.dryRun;
        logger.automation.info(`Mode configured: ${isDryRun ? "DRY_RUN (Safe Dry Run Mode - No Submissions)" : "REAL MODE (Active Submissions)"}`);
        
        // 1. Request Browser Context
        logger.automation.info("Requesting active Browser context from pool...");
        browserInstance = await browserPool.getInstance("naukri");
        page = await browserInstance.newPage();
        
        // 2. Perform Login Flow
        logger.automation.info("Step 1: Commencing Login Verification...");
        const loginOk = await plugin.login(page);
        if (!loginOk) {
            throw new Error("Naukri login failed or could not be established.");
        }
        logger.automation.info("Naukri Login verified successfully!");
        
        // 3. Perform Profile & Resume Update
        logger.automation.info("Step 2: Commencing Profile and Resume updates...");
        const profileOk = await plugin.updateProfile(page);
        logger.automation.info(`Profile Update sequence completed with status: ${profileOk}`);
        
        // 4. Perform Job Search matching
        logger.automation.info("Step 3: Commencing Job Search query...");
        const rawJobs = await plugin.search(page);
        logger.automation.info(`Retrieved ${rawJobs.length} raw jobs from search queries.`);
        
        let stats = {
            found: rawJobs.length,
            supported: 0,
            external: 0,
            alreadyApplied: 0,
            duplicates: 0,
            readyToApply: 0
        };
        
        const readyJobs = [];
        
        for (const job of rawJobs) {
            // Check duplicates and previously applied in SQLite
            const existingJob = await db.get(
                "SELECT * FROM jobs WHERE portal = 'naukri' AND job_id = ?",
                [job.job_id]
            );
            
            if (existingJob) {
                if (existingJob.applied === 1) {
                    stats.alreadyApplied++;
                    logger.automation.info(`[SKIP] Already Applied in DB: "${job.title}" at "${job.company}"`);
                } else {
                    stats.duplicates++;
                    logger.automation.info(`[SKIP] Duplicate in DB (pending): "${job.title}" at "${job.company}"`);
                }
                continue;
            }
            
            // Validate Title Keyword Match
            const matchesKeyword = config.search.keywords.some(kw => 
                job.title.toLowerCase().includes(kw.toLowerCase())
            );
            if (!matchesKeyword) {
                logger.automation.info(`[SKIP] Title keyword mismatch: "${job.title}" does not contain configured keywords.`);
                continue;
            }
            
            // Validate Location Match
            const matchesLocation = config.search.locations.some(loc => 
                job.location.toLowerCase().includes(loc.toLowerCase())
            );
            if (!matchesLocation) {
                logger.automation.info(`[SKIP] Location mismatch: "${job.location}" does not match configured locations.`);
                continue;
            }
            
            // Validate Experience Match
            const jobExp = parseExperience(job.experience);
            const matchesExp = (config.search.minExperience <= jobExp.max) && (config.search.maxExperience >= jobExp.min);
            if (!matchesExp) {
                logger.automation.info(`[SKIP] Experience mismatch: Job requires ${job.experience}, but config range is ${config.search.minExperience}-${config.search.maxExperience} yrs.`);
                continue;
            }

            // Save new discovered job to SQLite DB as pending
            try {
                const insertSql = `
                    INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, applied, ignored)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
                `;
                await db.run(insertSql, [
                    job.portal, 
                    job.job_id, 
                    job.company, 
                    job.title, 
                    job.location, 
                    job.experience, 
                    job.salary
                ]);
            } catch (dbErr) {
                logger.automation.error(`Database insertion failed: ${dbErr.message}`);
            }

            // Navigate to job details page to verify external redirect and questionnaire triggers
            logger.automation.info(`Checking job details for: "${job.title}" at "${job.company}"...`);
            try {
                await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 25000 });
                
                // Inspect external redirect button triggers
                const externalApplySelector = "button:has-text('Apply on company website'), a:has-text('Apply on company website'), button:has-text('Apply on company site')";
                const isExternal = await page.locator(externalApplySelector).count() > 0;
                
                if (isExternal) {
                    stats.external++;
                    logger.automation.info(`[SKIP] External Redirect: "${job.title}" requires company site redirection.`);
                    await db.run("UPDATE jobs SET ignored = 1, reason = 'External redirect' WHERE portal = 'naukri' AND job_id = ?", [job.job_id]);
                    continue;
                }

                // Inspect questionnaire pop-ups
                const chatbotSelector = ".chatbot-container, .questionnaire-container, :has-text('Submit answers'), :has-text('Answer questions')";
                const isQuestionnaire = await page.locator(chatbotSelector).count() > 0;
                if (isQuestionnaire) {
                    logger.automation.info(`[SKIP] Questionnaire-heavy: "${job.title}" requires manual answer inputs.`);
                    await db.run("UPDATE jobs SET ignored = 1, reason = 'Questionnaire' WHERE portal = 'naukri' AND job_id = ?", [job.job_id]);
                    continue;
                }

                // Passes all application filters
                stats.supported++;
                stats.readyToApply++;
                readyJobs.push(job);
                logger.automation.info(`[READY] Supported and Ready to Apply: "${job.title}" at "${job.company}"`);

            } catch (detErr) {
                logger.automation.error(`Failed loading job details page: ${detErr.message}`);
                await db.run("UPDATE jobs SET ignored = 1, reason = 'Page load error' WHERE portal = 'naukri' AND job_id = ?", [job.job_id]);
            }
        }
        
        // Print Summary Report
        console.log("\n====================================================");
        console.log("               NAUKRI DRY RUN SUMMARY               ");
        console.log("====================================================");
        console.log(`Jobs Found:       ${stats.found}`);
        console.log(`Supported:        ${stats.supported}`);
        console.log(`External:         ${stats.external}`);
        console.log(`Already Applied:  ${stats.alreadyApplied}`);
        console.log(`Duplicates:       ${stats.duplicates}`);
        console.log(`Ready To Apply:   ${stats.readyToApply}`);
        console.log("====================================================\n");
        
        // Apply sequence or Dry Run log triggers
        if (isDryRun) {
            for (const job of readyJobs) {
                logger.automation.info(`DRY RUN - Application skipped for: "${job.title}" at "${job.company}"`);
            }
            
            // Telegram dry run summary alert
            const tgMsg = `⚠️ *DRY RUN COMPLETE*\n\n` +
                          `• *Jobs Found*: ${stats.found}\n` +
                          `• *Ready To Apply*: ${stats.readyToApply}\n` +
                          `• *Skipped*: ${stats.found - stats.readyToApply}\n\n` +
                          `_No applications submitted (Safe Dry Run mode active)._`;
            await telegramService.sendMessage(tgMsg);
        } else {
            logger.automation.info("REAL MODE: Commencing actual application submissions...");
            for (const job of readyJobs) {
                try {
                    const applyOk = await plugin.apply(page, job);
                    if (applyOk) {
                        await db.run("UPDATE jobs SET applied = 1, timestamp = CURRENT_TIMESTAMP WHERE portal = 'naukri' AND job_id = ?", [job.job_id]);
                        logger.automation.info(`Applied successfully to "${job.title}" at "${job.company}"`);
                    } else {
                        await db.run("UPDATE jobs SET ignored = 1, reason = 'Apply failed' WHERE portal = 'naukri' AND job_id = ?", [job.job_id]);
                    }
                } catch (applyErr) {
                    logger.automation.error(`Apply crash for "${job.title}": ${applyErr.message}`);
                }
            }
        }
        
        await browserPool.closeAll();
        process.exit(0);
        
    } catch (err) {
        logger.automation.error(`Live verification run failure: ${err.message}`);
        await browserPool.closeAll().catch(() => {});
        process.exit(1);
    }
})();
