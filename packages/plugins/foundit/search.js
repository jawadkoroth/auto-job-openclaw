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
                logger.info(`Search page landed URL: "${page.url()}", Page Title: "${await page.title().catch(() => 'N/A')}"`);
            } catch (e) {
                logger.error(`Navigation failed for: ${searchUrl}. Error: ${e.message}`);
                continue;
            }

            const cardSelectors = [
                ".cardContainer",
                "div[class*='cardContainer']",
                "div[class*='srpResult']",
                "div[class*='jobCard']",
                "div[class*='srp-card']",
                "div[data-job-id]",
                "div.card-head",
                "div.srp-tuple-container"
            ];

            let jobCards = null;
            let count = 0;

            for (const sel of cardSelectors) {
                const locator = page.locator(sel);
                const c = await locator.count();
                if (c > 0) {
                    jobCards = locator;
                    count = c;
                    logger.info(`Found ${count} job cards using selector "${sel}" on Foundit.`);
                    break;
                }
            }

            // Fallback: If no cards found, inspect direct job links on the page
            if (count === 0) {
                logger.info("Card selectors yielded 0 results. Checking direct job link anchors...");
                const linkLocator = page.locator("a[href*='job-detail'], a[href*='/job/'], a[href*='/seeker/job']");
                const linkCount = await linkLocator.count();
                logger.info(`Found ${linkCount} direct job link anchors on Foundit.`);

                for (let i = 0; i < Math.min(linkCount, 15); i++) {
                    try {
                        const linkEl = linkLocator.nth(i);
                        const href = await linkEl.getAttribute("href");
                        const titleText = await linkEl.textContent();

                        if (href && titleText && titleText.trim().length > 3) {
                            const fullUrl = href.startsWith("http") ? href : `https://www.foundit.in${href}`;
                            const jobId = href.match(/\d+/)?.[0] || `foundit-link-${i}-${Date.now()}`;

                            if (!seenJobIds.has(jobId)) {
                                seenJobIds.add(jobId);
                                allDiscoveredJobs.push({
                                    portal: "foundit",
                                    job_id: jobId,
                                    title: titleText.trim(),
                                    company: "Company on Foundit",
                                    location: location,
                                    experience: "2-5 Yrs",
                                    salary: "Not Disclosed",
                                    url: fullUrl
                                });
                            }
                        }
                    } catch (e) {}
                }
            } else {
                for (let i = 0; i < count; i++) {
                    try {
                        const card = jobCards.nth(i);
                        const titleLoc = card.locator(".jobTitle, .title, a[href*='job'], h2, h3").first();
                        const title = await titleLoc.textContent();
                        if (!title || title.trim().length < 3) continue;

                        const companyLoc = card.locator(".companyName, .company, [class*='company']").first();
                        const company = (await companyLoc.count() > 0) ? (await companyLoc.textContent()) : "Foundit Employer";

                        // Get direct link or construct
                        let linkHref = "";
                        const linkEl = card.locator("a[href*='job'], a[href*='detail']").first();
                        if (await linkEl.count() > 0) {
                            linkHref = await linkEl.getAttribute("href");
                        }

                        let jobId = await card.getAttribute("id") || await card.getAttribute("data-job-id");
                        if (!jobId && linkHref) {
                            jobId = linkHref.match(/\d+/)?.[0];
                        }
                        if (!jobId) {
                            jobId = `foundit-${i}-${Date.now()}`;
                        }

                        let url = linkHref ? (linkHref.startsWith("http") ? linkHref : `https://www.foundit.in${linkHref}`) : `https://www.foundit.in/job-detail/${jobId}`;

                        if (seenJobIds.has(jobId)) continue;
                        seenJobIds.add(jobId);

                        const expLoc = card.locator(".experienceSalary, .details, [class*='exp']").first();
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
            }
            await page.waitForTimeout(2000);
        }
    }

    return allDiscoveredJobs;
};
