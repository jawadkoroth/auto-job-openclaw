/**
 * Naukri Apply Automation script
 * @param {import("./index")} plugin 
 * @param {any[]} jobs 
 * @param {Object} options 
 */
module.exports = async function apply(plugin, jobs, options = {}) {
    const { browserManager, logger } = plugin;
    logger.info(`Starting job application flow on Naukri for ${jobs.length} jobs.`, { plugin: "naukri", action: "apply" });
    
    const page = await browserManager.newPage();
    let appliedCount = 0;
    
    for (const job of jobs) {
        if (!job.url) {
            logger.warn(`Skipping job (missing URL): ${job.title}`, { plugin: "naukri", action: "apply" });
            continue;
        }
        
        try {
            logger.info(`Navigating to job: "${job.title}" at "${job.company}"`, { plugin: "naukri", action: "apply" });
            await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            
            const applyBtnSelector = "button.apply-button, button.applyBtn, #apply-button, button:has-text('Apply')";
            const alreadyAppliedSelector = ".already-applied, button:has-text('Applied'), span:has-text('Applied')";
            
            if (await page.locator(alreadyAppliedSelector).count() > 0) {
                logger.info(`Already applied to "${job.title}" at "${job.company}"`, { plugin: "naukri", action: "apply" });
                continue;
            }
            
            if (await page.locator(applyBtnSelector).count() > 0) {
                await page.click(applyBtnSelector);
                // Allow network transition
                await page.waitForTimeout(3000); 
                logger.info(`Successfully submitted application for: "${job.title}"`, { plugin: "naukri", action: "apply" });
                appliedCount++;
            } else {
                logger.warn(`No standard apply buttons found for "${job.title}". Might be an external link.`, { plugin: "naukri", action: "apply" });
            }
        } catch (err) {
            logger.error(`Failed to apply to "${job.title}": ${err.message}`, { plugin: "naukri", action: "apply", success: false });
            await browserManager.takeScreenshot(page, `naukri_apply_failed_${job.index}`);
        }
    }
    
    return appliedCount;
};
