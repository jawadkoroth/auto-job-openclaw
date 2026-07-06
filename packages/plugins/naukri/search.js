/**
 * Naukri Search Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 * @param {Object} queryOptions 
 */
module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    const keywords = queryOptions.keywords || "Software Engineer";
    const location = queryOptions.location || "";
    
    logger.info(`Searching Naukri: keywords="${keywords}", location="${location}"`);
    
    // Build direct Naukri search SEO URLs: /keywords-jobs-in-location
    const formattedKeywords = keywords.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    const formattedLoc = location ? `-jobs-in-${location.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-")}` : "-jobs";
    const searchUrl = `https://www.naukri.com/${formattedKeywords}${formattedLoc}`;
    
    logger.info(`Navigating to search URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    const jobSelector = "article.jobTuple, .list > article, [data-job-id]";
    await page.waitForSelector(jobSelector, { timeout: 15000 }).catch(() => {
        logger.warn("Job listing selectors not found within timeout limit.");
    });
    
    const jobListings = page.locator(jobSelector);
    const count = await jobListings.count();
    logger.info(`Found ${count} job listings on search page.`);
    
    const jobs = [];
    for (let i = 0; i < Math.min(count, 20); i++) {
        try {
            const item = jobListings.nth(i);
            const titleLoc = item.locator("a.title, .title");
            const title = await titleLoc.textContent();
            const company = await item.locator(".companyName, .company, a.comp-name").first().textContent();
            const url = await titleLoc.getAttribute("href");
            
            // Extract unique Job ID from DOM attributes or target URL
            let jobId = await item.getAttribute("data-job-id");
            if (!jobId && url) {
                const match = url.match(/-([0-9]{12})\b/);
                if (match) jobId = match[1];
                else jobId = url.split("?")[0].split("/").pop();
            }
            
            if (!jobId) {
                jobId = `naukri-${Date.now()}-${i}`;
            }

            jobs.push({
                portal: "naukri",
                job_id: jobId.trim(),
                title: title.trim(),
                company: company.trim(),
                location: location || "India",
                salary: "Not Disclosed",
                url
            });
        } catch (e) {
            logger.debug(`Failed reading item index #${i}: ${e.message}`);
        }
    }
    
    return jobs;
};
