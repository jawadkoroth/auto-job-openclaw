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
    
    // Determine enabled portals from config and env flags
    const portals = Object.keys(config.portals);
    const enabledPortals = portals.filter(portal => {
        const envKey = `ENABLE_${portal.toUpperCase()}`;
        const envVal = process.env[envKey];
        if (envVal !== undefined) {
            return envVal.toLowerCase() === "true";
        }
        // Defaults if not specified
        if (portal === "linkedin") return false;
        if (portal === "naukri") return false;
        return true;
    });

    logger.automation.info(`Active portals for this run: ${enabledPortals.join(", ")}`);

    const portalStats = {};
    for (const portal of enabledPortals) {
        portalStats[portal] = {
            found: 0,
            matchingFilters: 0,
            applied: 0,
            failed: 0,
            skipped: 0,
            alreadyApplied: 0
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

    const maxApplicationsLimit = parseInt(process.env.LIVE_MAX_APPLICATIONS || "5", 10);

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
                    logger.automation.info(`[${portal}] [SKIP] Duplicate in DB: "${job.title}" at "${job.company}"`);
                    continue;
                }

                // Title Keyword Match
                const matchesKeyword = config.search.keywords.some(kw => 
                    job.title.toLowerCase().includes(kw.toLowerCase())
                );
                if (!matchesKeyword) {
                    portalStats[portal].skipped++;
                    logger.automation.info(`[${portal}] [SKIP] Keyword mismatch: "${job.title}"`);
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
                    logger.automation.info(`[${portal}] [SKIP] Location mismatch: "${job.location}"`);
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
                    logger.automation.info(`[${portal}] [SKIP] Experience mismatch: ${job.experience}`);
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
                    
                    const applyOk = await plugin.apply(page, job);
                    if (applyOk) {
                        appliedCount++;
                        portalStats[portal].applied++;

                        // Update DB
                        await db.run(
                            "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 'Applied')",
                            [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                        ).catch(async () => {
                            await db.run(
                                "UPDATE jobs SET applied = 1, status = 'Applied', timestamp = CURRENT_TIMESTAMP WHERE portal = ? AND job_id = ?",
                                [portal, job.job_id]
                            );
                        });

                        logger.automation.info(`[${portal}] Successfully applied to: "${job.title}"`);

                        // Telegram notification
                        const successMsg = `✅ *Applied Successfully via ${portal.toUpperCase()}*\n\n` +
                                           `• *Company*: ${job.company}\n` +
                                           `• *Role*: ${job.title}\n` +
                                           `• *Location*: ${job.location}\n` +
                                           `• *URL*: ${job.url}`;
                        await telegramService.sendMessage(successMsg).catch(() => {});
                    } else {
                        portalStats[portal].skipped++;
                        logger.automation.info(`[${portal}] Application skipped (redirection/questionnaire) for: "${job.title}"`);
                        await db.run(
                            "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Skipped', 'Filtered/External/Questionnaire')",
                            [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url]
                        ).catch(() => {});
                    }
                } catch (applyErr) {
                    portalStats[portal].failed++;
                    logger.automation.error(`[${portal}] Error applying to "${job.title}": ${applyErr.message}`);
                    await db.run(
                        "INSERT INTO jobs (portal, job_id, company, title, location, experience, salary, url, applied, ignored, status, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 'Failed', ?)",
                        [portal, job.job_id, job.company, job.title, job.location, job.experience, job.salary, job.url, applyErr.message]
                    ).catch(() => {});
                }
                jobIndex++;
            }

        } catch (portalErr) {
            logger.automation.error(`❌ Portal [${portal}] failed: ${portalErr.message}`);
            portalStats[portal].failed++;
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

    console.log("\n=======================================================");
    console.log("            PRODUCTION AUTOMATION SUMMARY              ");
    console.log("=======================================================");
    console.log(summaryTable);
    console.log(`Total Runtime: ${runDuration} seconds`);
    console.log("=======================================================\n");

    // Telegram daily notification transmission
    const tgMsg = `🏁 *PRODUCTION AUTOMATION RUN COMPLETE*\n\n` +
                  `\`\`\`\n` +
                  `${summaryTable}` +
                  `\`\`\`\n` +
                  `• *Runtime*: ${runDuration} seconds`;
    
    await telegramService.sendMessage(tgMsg).catch(() => {});
    process.exit(0);
})();
