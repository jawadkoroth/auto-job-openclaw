const browserPool = require("../packages/browser/BrowserPool");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const logger = require("../packages/logger");
const telegramService = require("../apps/telegram");
const config = require("../packages/config");
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
    logger.automation.info("=== Starting Production Job Automation ===");
    const runStart = Date.now();
    
    // Determine enabled portals from config and env flags using validation
    const { validatePortalConfig } = require("../packages/config/validation");
    const portals = Object.keys(config.portals);
    const enabledPortals = [];
    const portalStatuses = {};

    for (const portal of portals) {
        const validation = await validatePortalConfig(portal);
        portalStatuses[portal] = validation.status;
        if (validation.status === "PASS") {
            enabledPortals.push(portal);
        } else if (validation.status === "CONFIG_REQUIRED") {
            logger.automation.warn(`[${portal}] CONFIG_REQUIRED: Missing authentication configuration. Required: ${validation.requiredMessage}`);
        } else if (validation.status === "AUTH_REQUIRED") {
            logger.automation.warn(`[${portal}] AUTH_REQUIRED: Session expired. Skipping portal.`);
        }
    }

    logger.automation.info(`Active portals for this run: ${enabledPortals.join(", ")}`);

    const portalStats = {};
    for (const portal of enabledPortals) {
        portalStats[portal] = {
            found: 0,
            matchingFilters: 0,
            applied: 0,
            failed: 0,
            skipped: 0,
            alreadyApplied: 0,
            experienceMismatch: 0,
            keywordMismatch: 0,
            externalSkip: 0,
            questionnaireSkip: 0,
            successState: "FAIL"
        };
    }

    try {
        await db.init();
        await db.run("ALTER TABLE jobs ADD COLUMN url TEXT").catch(() => {});
        await db.run("ALTER TABLE jobs ADD COLUMN status TEXT").catch(() => {});
        
        pluginManager.loadPlugins();
    } catch (e) {
        logger.automation.error(`Failed database or plugin initialization: ${e.message}`);
        process.exit(1);
    }

    const maxApplicationsLimit = config.search.maxApplicationsPerPortal || parseInt(process.env.LIVE_MAX_APPLICATIONS || "5", 10);

    for (const portal of enabledPortals) {
        logger.automation.info(`\n🚀 Starting automation run for portal: ${portal.toUpperCase()}`);
        let browserInstance = null;
        let page = null;
        let plugin = null;

        try {
            plugin = pluginManager.getPlugin(portal);
            if (!plugin) {
                throw new Error(`Plugin for ${portal} is not registered or failed to load.`);
            }

            // Launch browser context
            logger.automation.info(`[${portal}] Launching browser instance...`);
            browserInstance = await browserPool.getInstance(portal);
            page = await browserInstance.newPage();

            // Step 1: Login Verification
            logger.automation.info(`[${portal}] Verifying login session...`);
            const loginOk = await plugin.login(page);
            if (!loginOk) {
                throw new Error(`Authentication failed on ${portal}.`);
            }
            logger.automation.info(`[${portal}] Authentication successful!`);

            // Step 2: Profile Update
            logger.automation.info(`[${portal}] Commencing profile/resume update checks...`);
            const profileOk = await plugin.updateProfile(page).catch(e => {
                logger.automation.warn(`[${portal}] Profile update check skipped/failed: ${e.message}`);
                return false;
            });
            logger.automation.info(`[${portal}] Profile update completed (Status: ${profileOk})`);

            // Step 3: Job Search
            logger.automation.info(`[${portal}] Commencing job search...`);
            const rawJobs = await plugin.search(page).catch(e => {
                logger.automation.error(`[${portal}] Job search failed: ${e.message}`);
                return [];
            });
            portalStats[portal].found = rawJobs.length;
            logger.automation.info(`[${portal}] Retrieved ${rawJobs.length} raw jobs from search.`);

            const candidateJobs = [];

            const isDebug = process.env.DEBUG === "true";

            // Filtering phase
            for (const job of rawJobs) {
                // Check duplicates in SQLite
                const existingJob = await db.get(
                    "SELECT * FROM jobs WHERE portal = ? AND job_id = ?",
                    [portal, job.job_id]
                );

                if (existingJob) {
                    portalStats[portal].skipped++;
                    portalStats[portal].alreadyApplied++;
                    if (isDebug) {
                        logger.automation.info(`[${portal}] [SKIP] Duplicate in DB: "${job.title}" at "${job.company}"`);
                    }
                    continue;
                }

                // Title Keyword Match
                const matchesKeyword = config.search.keywords.some(kw => 
                    job.title.toLowerCase().includes(kw.toLowerCase())
                );
                if (!matchesKeyword) {
                    portalStats[portal].skipped++;
                    portalStats[portal].keywordMismatch++;
                    if (isDebug) {
                        logger.automation.info(`[${portal}] [SKIP] Keyword mismatch: "${job.title}"`);
                    }
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Keyword mismatch')",
                        [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    continue;
                }

                // Location Match
                const matchesLocation = config.search.locations.some(loc => 
                    job.location.toLowerCase().includes(loc.toLowerCase())
                );
                if (!matchesLocation) {
                    portalStats[portal].skipped++;
                    portalStats[portal].keywordMismatch++;
                    if (isDebug) {
                        logger.automation.info(`[${portal}] [SKIP] Location mismatch: "${job.location}"`);
                    }
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Location mismatch')",
                        [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    continue;
                }

                // Experience Match
                const jobExp = parseExperience(job.experience);
                const matchesExp = (config.search.minExperience <= jobExp.max) && (config.search.maxExperience >= jobExp.min);
                if (!matchesExp) {
                    portalStats[portal].skipped++;
                    portalStats[portal].experienceMismatch++;
                    if (isDebug) {
                        logger.automation.info(`[${portal}] [SKIP] Experience mismatch: ${job.experience}`);
                    }
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Experience mismatch')",
                        [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                    ).catch(() => {});
                    continue;
                }

                candidateJobs.push(job);
            }

            portalStats[portal].matchingFilters = candidateJobs.length;
            logger.automation.info(`[${portal}] Found ${candidateJobs.length} eligible jobs. Applying (Limit: ${maxApplicationsLimit})...`);

            let appliedCount = 0;
            let jobIndex = 0;

            while (jobIndex < candidateJobs.length && appliedCount < maxApplicationsLimit) {
                const job = candidateJobs[jobIndex];
                try {
                    logger.automation.info(`[${portal}] Applying to: "${job.title}" at "${job.company}"`);
                    
                    const resumeSelector = require("../packages/resume/ResumeSelector");
                    const externalApplicationRouter = require("../packages/router/ExternalApplicationRouter");

                    const resumeType = resumeSelector.selectResume(job.title, job.job_description || "");
                    job.resumeType = resumeType;

                    const applyOk = await plugin.apply(page, job);
                    const statusReason = job.statusReason || "";
                    
                    if (applyOk) {
                        appliedCount++;
                        portalStats[portal].applied++;
                        
                        let dbStatus = "APPLIED";
                        let dbReason = "Successfully applied";
                        if (statusReason === "alreadyApplied") {
                            dbStatus = "ALREADY_APPLIED";
                            dbReason = "Already applied";
                            portalStats[portal].alreadyApplied++;
                        } else if (statusReason === "clicked_unverified") {
                            dbStatus = "CLICKED_UNVERIFIED";
                            dbReason = "Clicked but unverified";
                        }
                        
                        await db.run(
                            "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason, job_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)",
                            [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url, dbStatus, dbReason, job.job_description || ""]
                        ).catch(async () => {
                            await db.run(
                                "UPDATE jobs SET applied = 1, status = ?, reason = ?, timestamp = CURRENT_TIMESTAMP, job_description = ? WHERE portal = ? AND job_id = ?",
                                [dbStatus, dbReason, job.job_description || "", portal, job.job_id]
                            );
                        });

                        logger.automation.info(`[${portal}] Successfully applied to: "${job.title}"`);

                        // Telegram notification
                        const successMsg = `✅ *Applied Successfully via ${portal.toUpperCase()}*\n\n` +
                                           `• *Company*: ${job.company}\n` +
                                           `• *Role*: ${job.title}\n` +
                                           `• *Status*: ${dbStatus}\n` +
                                           `• *URL*: ${job.url}`;
                        await telegramService.sendMessage(successMsg).catch(() => {});
                    } else {
                        portalStats[portal].skipped++;
                        
                        let dbStatus = "FAILED";
                        let dbReason = "Selector action failed";
                        
                        if (statusReason === "external") {
                            portalStats[portal].externalSkip++;
                            dbStatus = "EXTERNAL_PENDING";
                            dbReason = "External redirect";
                            
                            let extUrl = job.externalUrl || job.url;
                            const ats = await externalApplicationRouter.route(job, extUrl);
                            logger.automation.info(`Job ${job.job_id} routed to external ATS queue: ${ats}`);
                        } else if (statusReason === "questionnaire") {
                            portalStats[portal].questionnaireSkip++;
                            dbStatus = "WAITING_FOR_INPUT";
                            dbReason = "Questionnaire";
                        } else if (statusReason === "alreadyApplied") {
                            portalStats[portal].alreadyApplied++;
                            dbStatus = "ALREADY_APPLIED";
                            dbReason = "Already applied";
                        }
                        
                        await db.run(
                            "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason, job_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)",
                            [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url, dbStatus, dbReason, job.job_description || ""]
                        ).catch(async () => {
                            await db.run(
                                "UPDATE jobs SET status = ?, reason = ?, ignored = 1, job_description = ? WHERE portal = ? AND job_id = ?",
                                [dbStatus, dbReason, job.job_description || "", portal, job.job_id]
                            );
                        });
                    }
                } catch (applyErr) {
                    portalStats[portal].failed++;
                    logger.automation.error(`[${portal}] Error applying to "${job.title}": ${applyErr.message}`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason, job_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'FAILED', ?, ?)",
                        [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url, applyErr.message, job.job_description || ""]
                    ).catch(async () => {
                        await db.run(
                            "UPDATE jobs SET status = 'FAILED', reason = ?, ignored = 1, job_description = ? WHERE portal = ? AND job_id = ?",
                            [applyErr.message, job.job_description || "", portal, job.job_id]
                        );
                    });
                }
                jobIndex++;
            }

            portalStats[portal].successState = "PASS";

            // Concise Run Summary for the portal
            logger.automation.info(`\n[${portal.toUpperCase()}] Run Summary:`);
            console.log(`Found: ${portalStats[portal].found}`);
            console.log(`Rejected`);
            console.log(`Experience: ${portalStats[portal].experienceMismatch}`);
            console.log(`Keyword: ${portalStats[portal].keywordMismatch}`);
            console.log(`Already Applied: ${portalStats[portal].alreadyApplied}`);
            console.log(`External: ${portalStats[portal].externalSkip}`);
            console.log(`Questionnaire: ${portalStats[portal].questionnaireSkip}`);
            console.log(`Eligible: ${portalStats[portal].matchingFilters}`);
            console.log(`Applied: ${portalStats[portal].applied}\n`);

        } catch (portalErr) {
            logger.automation.error(`❌ Portal [${portal}] failed: ${portalErr.message}`);
            portalStats[portal].failed++;
            if (browserInstance && page) {
                const sp = await browserInstance.takeScreenshot(page, `${portal}_failed`).catch(() => null);
                if (sp) {
                    logger.automation.info(`Saved error screenshot to: ${sp}`);
                }
            }
        } finally {
            // Close active browser instance context to clean memory
            if (browserInstance) {
                logger.automation.info(`[${portal}] Closing browser instance...`);
                await browserPool.closeAll().catch(() => {});
            }
        }
    }

    // Calculative Summary Format
    const runDuration = ((Date.now() - runStart) / 1000).toFixed(1);

    // Build the overall summary table
    let summaryTable = "Portal              Found   Eligible   Applied   Failed\n";
    summaryTable += "-------------------------------------------------------\n";
    for (const p of enabledPortals) {
        const name = (p.charAt(0).toUpperCase() + p.slice(1)).padEnd(20);
        const found = String(portalStats[p].found).padEnd(8);
        const eligible = String(portalStats[p].matchingFilters || 0).padEnd(11);
        const applied = String(portalStats[p].applied).padEnd(10);
        const failed = String(portalStats[p].failed);
        summaryTable += `${name}${found}${eligible}${applied}${failed}\n`;
    }

    let statusSummaryTable = "Portal             Status\n\n";
    const allPortals = ["foundit", "hirist", "instahyre", "wellfound", "remoteok", "weworkremotely", "naukri"];
    for (const p of allPortals) {
        const displayName = p === "weworkremotely" ? "WeWorkRemotely" : (p.charAt(0).toUpperCase() + p.slice(1));
        const nameCol = displayName.padEnd(19);
        let status = portalStatuses[p] || "SKIPPED";
        if (enabledPortals.includes(p)) {
            status = portalStats[p].successState === "PASS" ? "PASS" : "FAIL";
        }
        statusSummaryTable += `${nameCol}${status}\n`;
    }

    const hasConfigRequired = Object.values(portalStatuses).some(s => s === "CONFIG_REQUIRED");
    const isProductionReady = hasConfigRequired ? "NO" : "YES";

    console.log("\n=======================================================");
    console.log("            PRODUCTION AUTOMATION SUMMARY              ");
    console.log("=======================================================");
    console.log(summaryTable);
    console.log(statusSummaryTable);
    console.log(`Production Ready: ${isProductionReady}`);
    console.log(`Total Runtime: ${runDuration} seconds`);
    console.log("=======================================================\n");

    // Telegram daily notification transmission
    const tgMsg = `🏁 *PRODUCTION AUTOMATION RUN COMPLETE*\n\n` +
                  `\`\`\`\n` +
                  `${statusSummaryTable}` +
                  `\`\`\`\n` +
                  `*Production Ready*: ${isProductionReady}\n` +
                  `• *Runtime*: ${runDuration} seconds`;
    
    await telegramService.sendMessage(tgMsg).catch(() => {});
    process.exit(0);
})();
