module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["DevOps Engineer"];
    const locationsList = queryOptions.locationsList || config.search.locations || ["Remote"];

    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    logger.info("Navigating to Instahyre Opportunities page...");
    try {
        await page.goto("https://www.instahyre.com/candidate/opportunities/", { waitUntil: "networkidle", timeout: 30000 });
    } catch (e) {
        logger.error(`Navigation failed: ${e.message}`);
        return [];
    }

    const cardSelector = ".opportunity-card, [id^='job-'], .job-opportunity, .job-card";
    await page.waitForSelector(cardSelector, { timeout: 15000 }).catch(() => {
        logger.warn("No opportunity cards found within timeout.");
    });

    const opportunityCards = page.locator(cardSelector);
    const count = await opportunityCards.count();
    logger.info(`Found ${count} opportunity cards on Instahyre.`);

    for (let i = 0; i < count; i++) {
        try {
            const card = opportunityCards.nth(i);
            
            const titleLoc = card.locator(".job-title, .title, h3, h4").first();
            const title = await titleLoc.textContent();

            const companyLoc = card.locator(".company-name, .company, .employer").first();
            const company = await companyLoc.textContent();

            const locLoc = card.locator(".location, .job-location").first();
            const jobLocation = (await locLoc.count() > 0) ? (await locLoc.textContent()) : "Remote";

            const expLoc = card.locator(".experience, .job-experience").first();
            const experience = (await expLoc.count() > 0) ? (await expLoc.textContent()) : "2-5 Years";

            const salLoc = card.locator(".salary, .job-salary").first();
            const salary = (await salLoc.count() > 0) ? (await salLoc.textContent()) : "Not Disclosed";

            const linkLoc = card.locator("a[href*='/jobs/'], a[href*='/opportunities/'], a:has-text('View')").first();
            let url = "";
            let jobId = "";

            if (await linkLoc.count() > 0) {
                url = await linkLoc.getAttribute("href");
                if (url && !url.startsWith("http")) {
                    url = "https://www.instahyre.com" + url;
                }
                const match = url.match(/\/jobs\/(\d+)\b/);
                if (match) jobId = match[1];
            }

            if (!jobId && url) {
                jobId = url.split("/").filter(Boolean).pop();
            }

            if (!jobId) {
                jobId = `instahyre-${i}-${Buffer.from(title + company).toString("base64").substring(0, 8)}`;
            }

            if (!url) {
                url = `https://www.instahyre.com/candidate/opportunities/`;
            }

            jobId = jobId.trim();
            if (seenJobIds.has(jobId)) continue;
            seenJobIds.add(jobId);

            allDiscoveredJobs.push({
                portal: "instahyre",
                job_id: jobId,
                title: title.trim(),
                company: company.trim(),
                location: jobLocation.trim(),
                experience: experience.trim(),
                salary: salary.trim(),
                url: url
            });
        } catch (e) {
            logger.debug(`Failed reading opportunity card index #${i}: ${e.message}`);
        }
    }

    return allDiscoveredJobs;
};
