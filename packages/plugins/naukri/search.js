/**
 * Naukri Search Automation script
 * @param {import("./index")} plugin 
 * @param {Object} queryOptions 
 * @param {string} queryOptions.keywords
 * @param {string} queryOptions.location
 */
module.exports = async function search(plugin, queryOptions = {}) {
    const { browserManager, logger, config } = plugin;
    const keywords = queryOptions.keywords || "Software Engineer";
    const location = queryOptions.location || "";
    
    logger.info(`Searching Naukri: keywords="${keywords}", location="${location}"`, { plugin: "naukri", action: "search" });
    const page = await browserManager.newPage();
    
    // Build direct Naukri search SEO URLs: /keywords-jobs-in-location
    const formattedKeywords = keywords.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    const formattedLoc = location ? `-jobs-in-${location.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-")}` : "-jobs";
    const searchUrl = `https://www.naukri.com/${formattedKeywords}${formattedLoc}`;
    
    logger.info(`Navigating to search URL: ${searchUrl}`, { plugin: "naukri", action: "search" });
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    const jobSelector = "article.jobTuple, .list > article, [data-job-id]";
    await page.waitForSelector(jobSelector, { timeout: 15000 }).catch(() => {
        logger.warn("Job listing selectors not found within timeout limit.", { plugin: "naukri", action: "search" });
    });
    
    const jobListings = page.locator(jobSelector);
    const count = await jobListings.count();
    logger.info(`Found ${count} job listings on search results page.`, { plugin: "naukri", action: "search" });
    
    const jobs = [];
    for (let i = 0; i < Math.min(count, 20); i++) {
        try {
            const item = jobListings.nth(i);
            const titleLoc = item.locator("a.title, .title");
            const title = await titleLoc.textContent();
            const company = await item.locator(".companyName, .company, a.comp-name").first().textContent();
            const url = await titleLoc.getAttribute("href");
            
            jobs.push({
                title: title.trim(),
                company: company.trim(),
                url,
                index: i
            });
        } catch (e) {
            // Log individually but do not break entire scraping loop
            logger.debug(`Error reading search item #${i}: ${e.message}`, { plugin: "naukri", action: "search" });
        }
    }
    
    return jobs;
};
