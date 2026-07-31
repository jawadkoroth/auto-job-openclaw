const logger = require("../logger").plugin("naukri");

class ATSClassifier {
    /**
     * Classify destination URL and page DOM into known ATS categories
     * @param {import('playwright').Page} page Playwright page instance (or null)
     * @param {string} targetUrl Destination URL string
     * @returns {Promise<{ ats: string, confidence: number, isExternalDomain: boolean, url: string, domain: string }>}
     */
    async classify(page, targetUrl = "") {
        const urlStr = (targetUrl || (page ? page.url() : "") || "").toLowerCase();
        let domain = "";
        try {
            const parsed = new URL(urlStr);
            domain = parsed.hostname;
        } catch (e) {
            domain = urlStr;
        }

        // HARD DOMAIN INVARIANT: Reject any URL on naukri.com domain
        if (domain.endsWith("naukri.com") || domain.endsWith("naukrigulf.com") || domain === "naukri.com") {
            return { ats: "NAUKRI_INTERNAL", confidence: 1.0, isExternalDomain: false, url: urlStr, domain };
        }

        // 1. Direct URL Pattern Matching
        if (domain.includes("greenhouse.io") || urlStr.includes("boards.greenhouse.io") || urlStr.includes("gh_src=")) {
            return { ats: "GREENHOUSE", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }
        if (domain.includes("lever.co") || urlStr.includes("jobs.lever.co")) {
            return { ats: "LEVER", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }
        if (domain.includes("smartrecruiters.com") || urlStr.includes("jobs.smartrecruiters.com")) {
            return { ats: "SMARTRECRUITERS", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }
        if (domain.includes("myworkdayjobs.com") || domain.includes("workday.com") || urlStr.includes("myworkdayjobs.com")) {
            return { ats: "WORKDAY", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }
        if (domain.includes("ashbyhq.com") || urlStr.includes("jobs.ashbyhq.com")) {
            return { ats: "ASHBY", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }
        if (domain.includes("successfactors.com") || domain.includes("successfactors.eu") || urlStr.includes("career.successfactors")) {
            return { ats: "SUCCESSFACTORS", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }
        if (domain.includes("oraclecloud.com") || domain.includes("oracle.com") || urlStr.includes("hrc.oraclecloud.com")) {
            return { ats: "ORACLE_RECRUITING", confidence: 0.95, isExternalDomain: true, url: urlStr, domain };
        }

        // 2. DOM Evidence Inspection if page object is available
        if (page) {
            try {
                const pageEvidence = await page.evaluate(() => {
                    const html = document.documentElement ? document.documentElement.innerHTML.toLowerCase() : "";
                    const text = document.body ? document.body.innerText.toLowerCase() : "";
                    const metaAuthor = document.querySelector('meta[name="author"]')?.getAttribute('content')?.toLowerCase() || "";

                    const hasGreenhouse = !!document.querySelector('#grnhse_app, form#application_form, [data-mapped-from="greenhouse"]') ||
                        html.includes("powered by greenhouse") || metaAuthor.includes("greenhouse");

                    const hasLever = !!document.querySelector('.lever-job, form#application-form, .application-field') ||
                        html.includes("powered by lever") || text.includes("lever.co");

                    const hasSmartRecruiters = !!document.querySelector('oc-job-layout, .st-apply, .js-job-application') ||
                        html.includes("smartrecruiters");

                    const hasWorkday = !!document.querySelector('[data-automation-id], [data-metadata-id]') ||
                        html.includes("workday") || html.includes("myworkdayjobs");

                    const hasAshby = !!document.querySelector('[data-ashby-id]') ||
                        html.includes("ashbyhq") || html.includes("ashby");

                    const hasSuccessFactors = html.includes("successfactors") || html.includes("sf-rcm");

                    const hasOracleRecruiting = html.includes("oraclecloud") || html.includes("oracle recruiting") ||
                        !!document.querySelector('cx-job-details, oracle-careers');

                    const hasForm = document.querySelectorAll('form, input[type="text"], input[type="email"], input[type="file"]').length > 0;

                    return {
                        hasGreenhouse,
                        hasLever,
                        hasSmartRecruiters,
                        hasWorkday,
                        hasAshby,
                        hasSuccessFactors,
                        hasOracleRecruiting,
                        hasForm
                    };
                }).catch(() => null);

                if (pageEvidence) {
                    if (pageEvidence.hasGreenhouse) return { ats: "GREENHOUSE", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };
                    if (pageEvidence.hasLever) return { ats: "LEVER", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };
                    if (pageEvidence.hasSmartRecruiters) return { ats: "SMARTRECRUITERS", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };
                    if (pageEvidence.hasWorkday) return { ats: "WORKDAY", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };
                    if (pageEvidence.hasAshby) return { ats: "ASHBY", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };
                    if (pageEvidence.hasSuccessFactors) return { ats: "SUCCESSFACTORS", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };
                    if (pageEvidence.hasOracleRecruiting) return { ats: "ORACLE_RECRUITING", confidence: 0.9, isExternalDomain: true, url: urlStr, domain };

                    if (pageEvidence.hasForm) {
                        return { ats: "COMPANY_SITE", confidence: 0.7, isExternalDomain: true, url: urlStr, domain };
                    }
                }
            } catch (err) {
                logger.warn(`DOM classification warning: ${err.message}`);
            }
        }

        // Fallback
        if (urlStr.startsWith("http://") || urlStr.startsWith("https://")) {
            return { ats: "COMPANY_SITE", confidence: 0.5, isExternalDomain: true, url: urlStr, domain };
        }

        return { ats: "UNKNOWN_EXTERNAL", confidence: 0.1, isExternalDomain: true, url: urlStr, domain };
    }
}

module.exports = new ATSClassifier();
