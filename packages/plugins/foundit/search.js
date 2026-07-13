module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    const keywordsList = queryOptions.keywordsList || config.search.keywords || ["DevOps Engineer"];
    const locationsList = queryOptions.locationsList || config.search.locations || ["Bangalore"];

    const allDiscoveredJobs = [];
    const seenJobIds = new Set();

    for (const keywords of keywordsList) {
        for (const location of locationsList) {
            logger.info(`Searching Foundit: keywords="${keywords}", location="${location}"`);
            
            const searchUrl = `https://www.foundit.in/srp/results?query=${encodeURIComponent(keywords)}&locations=${encodeURIComponent(location)}`;
            logger.info(`Navigating directly to search URL: ${searchUrl}`);
            try {
                await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 35000 });
                await page.waitForTimeout(4000);
            } catch (e) {
                logger.error(`Navigation failed for: ${searchUrl}. Error: ${e.message}`);
                continue;
            }

            const cardSelector = ".cardContainer";
            await page.waitForSelector(cardSelector, { timeout: 15000 }).catch(() => {
                logger.warn("No job cards found on Foundit search results page.");
            });

            const jobCards = page.locator(cardSelector);
            const count = await jobCards.count();
            logger.info(`Found ${count} job cards on Foundit.`);

            for (let i = 0; i < count; i++) {
                try {
                    const card = jobCards.nth(i);
                    const titleLoc = card.locator(".jobTitle, .title").first();
                    const title = await titleLoc.textContent();
                    if (!title) continue;

                    const companyLoc = card.locator(".companyName, .company").first();
                    const company = (await companyLoc.count() > 0) ? (await companyLoc.textContent()) : "Unknown Company";

                    let jobId = await card.getAttribute("id");
                    if (!jobId) {
                        jobId = `foundit-${i}-${Date.now()}`;
                    }

                    const url = `https://www.foundit.in/job-detail/${jobId}`;

                    if (seenJobIds.has(jobId)) continue;
                    seenJobIds.add(jobId);

                    const expLoc = card.locator(".experienceSalary, .details").first();
                    const experience = (await expLoc.count() > 0) ? (await expLoc.textContent()) : "2-5 Yrs";

                    const locLoc = card.locator(".location, [class*='location']").first();
                    const jobLocation = (await locLoc.count() > 0) ? (await locLoc.textContent()) : location;

                    allDiscoveredJobs.push({
                        portal: "foundit",
                        job_id: jobId,
                        title: title.trim(),
                        company: company.trim(),
                        location: jobLocation.trim(),
                        experience: experience.trim(),
                        salary: "Not Disclosed",
                        url: url
                    });
                } catch (err) {
                    logger.debug(`Failed reading Foundit job card: ${err.message}`);
                }
            }
            await page.waitForTimeout(2000);
        }
    }

    return allDiscoveredJobs;
};
