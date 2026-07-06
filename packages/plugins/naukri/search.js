/**
 * Naukri Search Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 * @param {Object} queryOptions 
 */
module.exports = async function search(plugin, page, queryOptions = {}) {
    const { logger, config } = plugin;
    
    // Resolve search parameters from query, config, or env fallback
    const keywords = queryOptions.keywords || 
                     (config.portals.naukri && config.portals.naukri.keywords) || 
                     process.env.JOB_KEYWORDS || 
                     "Software Engineer";
                     
    const location = queryOptions.location || 
                     (config.portals.naukri && config.portals.naukri.location) || 
                     process.env.JOB_LOCATION || 
                     "Bangalore";
    
    logger.info(`Searching Naukri: keywords="${keywords}", location="${location}"`);
    
    // Build direct SEO URL
    const formattedKeywords = keywords.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
    const formattedLoc = location ? `-jobs-in-${location.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-")}` : "-jobs";
    const searchUrl = `https://www.naukri.com/${formattedKeywords}${formattedLoc}`;
    
    logger.info(`Navigating directly to search URL: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 30000 });
    
    // Selectors covering multiple Naukri DOM versions (legacy and layout updates)
    const jobSelector = "article.jobTuple, .list > article, [data-job-id], div.srp-jobtuple, article.srp-jobtuple";
    await page.waitForSelector(jobSelector, { timeout: 15000 }).catch(() => {
        logger.warn("Job listing selectors not found on page within timeout.");
    });
    
    const jobListings = page.locator(jobSelector);
    const count = await jobListings.count();
    logger.info(`Found ${count} job cards on search page.`);
    
    const jobs = [];
    for (let i = 0; i < Math.min(count, 30); i++) {
        try {
            const item = jobListings.nth(i);
            const titleLoc = item.locator("a.title, .title, [class*='title']");
            const title = await titleLoc.textContent();
            
            const companyLoc = item.locator(".companyName, .company, a.comp-name, [class*='company']").first();
            const company = await companyLoc.textContent();
            
            const url = await titleLoc.getAttribute("href");
            if (!url) continue;

            // Extract unique Job ID
            let jobId = await item.getAttribute("data-job-id");
            if (!jobId) {
                const match = url.match(/-([0-9]{12})\b/);
                if (match) jobId = match[1];
                else jobId = url.split("?")[0].split("/").pop();
            }
            
            if (!jobId) {
                // absolute fallback
                jobId = `naukri-${Buffer.from(url).toString("base64").substring(0, 16)}`;
            }

            jobs.push({
                portal: "naukri",
                job_id: jobId.trim(),
                title: title.trim(),
                company: company.trim(),
                location: location,
                salary: "Not Disclosed",
                url: url
            });
        } catch (e) {
            logger.debug(`Failed reading listing card index #${i}: ${e.message}`);
        }
    }
    
    return jobs;
};
