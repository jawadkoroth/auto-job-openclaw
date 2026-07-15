module.exports = async function apply(plugin, page, job) {
    const { logger } = plugin;
    logger.info(`Processing application for WeWorkRemotely job: "${job.title}" at "${job.company}"`);

    if (!job.url) {
        throw new Error("Target job model does not contain a valid URL.");
    }

    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    // Scrape description
    const descSelector = "#job-details, .job-description, #job-description, .description";
    const descText = await page.locator(descSelector).first().innerText().catch(() => "");
    if (descText) {
        job.job_description = descText;
        const db = require("../../database");
        await db.run("UPDATE jobs SET job_description = ? WHERE id = ?", [descText, job.id]).catch(() => {});
    }

    const applyBtnSelector = "a#job-cta-button, .apply, button:has-text('Apply')";
    const hasApplyBtn = await page.locator(applyBtnSelector).count() > 0;

    if (hasApplyBtn) {
        const ctaHref = await page.locator(applyBtnSelector).first().getAttribute("href");
        if (ctaHref && (ctaHref.startsWith("http") && !ctaHref.includes("weworkremotely.com"))) {
            logger.warn(`Job application redirects to external site: ${ctaHref}. Skipping.`);
            job.statusReason = "external";
            return false;
        }

        logger.info("Clicking WeWorkRemotely Apply CTA...");
        await page.click(applyBtnSelector);
        await page.waitForTimeout(3000);

        const emailInput = "input[type='email'], input[name='email']";
        const hasForm = await page.locator(emailInput).count() > 0;
        if (hasForm) {
            logger.info("Direct apply form found. Proceeding with details...");
            await page.click(emailInput);
            await page.keyboard.type("test-applicant@example.com");
            const submitBtn = "button[type='submit'], input[type='submit']";
            if (await page.locator(submitBtn).count() > 0) {
                await page.click(submitBtn);
                await page.waitForTimeout(3000);
                logger.info(`Applied successfully via direct form on WeWorkRemotely`);
                job.statusReason = "applied";
                return true;
            }
        }

        logger.warn(`No internal apply form found. External redirection required. Skipping.`);
        job.statusReason = "external";
        return false;
    } else {
        logger.warn(`No standard apply CTA found. Skipping.`);
        job.statusReason = "external";
        return false;
    }
};
