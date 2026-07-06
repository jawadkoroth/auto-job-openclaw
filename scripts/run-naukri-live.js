const browserPool = require("../packages/browser/BrowserPool");
const pluginManager = require("../packages/plugins/PluginManager");
const db = require("../packages/database");
const logger = require("../packages/logger");

(async () => {
    logger.automation.info("=== Starting Live Naukri Automation verification run ===");
    try {
        // Initialize DB schema
        await db.init();
        
        // Load plugin registrations
        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin("naukri");
        if (!plugin) {
            throw new Error("Naukri plugin failed to load from manager.");
        }
        
        // 1. Launch Browser context
        logger.automation.info("Requesting active Browser context from pool...");
        const instance = await browserPool.getInstance("naukri");
        const page = await instance.newPage();
        
        // 2. Perform Login Flow
        logger.automation.info("Step 1: Commencing Login Verification...");
        const loginOk = await plugin.login(page);
        if (!loginOk) {
            throw new Error("Naukri login failed or could not be verified.");
        }
        logger.automation.info("Naukri Login verified successfully!");
        
        // 3. Perform Profile & Resume Upload
        logger.automation.info("Step 2: Commencing Profile and Resume upload updates...");
        const profileOk = await plugin.updateProfile(page);
        logger.automation.info(`Profile Update sequence completed with status: ${profileOk}`);
        
        // 4. Perform Job Search matching
        logger.automation.info("Step 3: Commencing Job Search query...");
        const jobs = await plugin.search(page, { keywords: "Software Engineer", location: "Bangalore" });
        logger.automation.info(`Discovered ${jobs.length} jobs.`);
        
        // Push discovered jobs to SQLite Job DB (deduplicate automatically)
        let insertedCount = 0;
        for (const job of jobs) {
            try {
                const insertSql = `
                    INSERT INTO jobs (portal, job_id, company, title, location, salary, applied, ignored)
                    VALUES (?, ?, ?, ?, ?, ?, 0, 0)
                `;
                await db.run(insertSql, [
                    job.portal, 
                    job.job_id, 
                    job.company, 
                    job.title, 
                    job.location, 
                    job.salary
                ]);
                insertedCount++;
                logger.automation.info(`[DISCOVERED] ${job.title} at ${job.company}`);
            } catch (dbErr) {
                // Ignore UNIQUE constraint failures (skip duplicates)
            }
        }
        logger.automation.info(`SQLite Job DB updated: ${insertedCount} new jobs saved.`);
        
        // 5. Perform Job Apply matching
        logger.automation.info("Step 4: Commencing Job Apply test...");
        const pendingJobs = await db.all(
            "SELECT * FROM jobs WHERE portal = 'naukri' AND applied = 0 AND ignored = 0 LIMIT 1"
        );
        
        if (pendingJobs.length > 0) {
            const targetJob = pendingJobs[0];
            logger.automation.info(`Attempting apply target: "${targetJob.title}" at "${targetJob.company}" (${targetJob.url})`);
            const applyOk = await plugin.apply(page, targetJob);
            if (applyOk) {
                await db.run("UPDATE jobs SET applied = 1, timestamp = CURRENT_TIMESTAMP WHERE id = ?", [targetJob.id]);
                logger.automation.info("Application submission completed successfully.");
            } else {
                await db.run("UPDATE jobs SET ignored = 1, reason = 'Unsupported or external' WHERE id = ?", [targetJob.id]);
                logger.automation.info("Application skipped/unsupported (e.g. redirected or questionnaire required).");
            }
        } else {
            logger.automation.warn("No pending unapplied jobs found in SQLite to test applying.");
        }
        
        // Shutdown browser pool
        await browserPool.closeAll();
        logger.automation.info("=== Live Naukri Automation verification run completed successfully ===");
        process.exit(0);
    } catch (err) {
        logger.automation.error(`Live verification run failed: ${err.message}`);
        await browserPool.closeAll().catch(() => {});
        process.exit(1);
    }
})();
