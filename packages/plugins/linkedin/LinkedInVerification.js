const logger = require("../../logger").plugin("linkedin");

class LinkedInVerification {
    /**
     * Verify post-application success status on LinkedIn portal
     * @param {Page} page Playwright Page
     * @param {Object} job Target Job Card
     * @returns {Promise<Object>} { verified: boolean, status: string, reason: string }
     */
    async verifyApplication(page, job) {
        try {
            const pageText = await page.evaluate(() => document.body ? document.body.innerText.toLowerCase() : "").catch(() => "");

            const isVerified = (
                pageText.includes("application submitted") ||
                pageText.includes("your application was sent") ||
                pageText.includes("applied on") ||
                pageText.includes("already applied") ||
                pageText.includes("applied")
            );

            if (isVerified) {
                logger.info(`[Verification] ✓ Verified successful application for Job ${job.id || job.job_id} on LinkedIn portal.`);
                return { verified: true, status: "APPLIED", reason: "Portal confirmation banner verified" };
            } else {
                logger.warn(`[Verification] ⚠️ Could not verify application banner for Job ${job.id || job.job_id}.`);
                return { verified: false, status: "UNVERIFIED", reason: "Missing confirmation banner" };
            }
        } catch (err) {
            logger.error(`[Verification] Verification error for Job ${job.id || job.job_id}: ${err.message}`);
            return { verified: false, status: "VERIFICATION_FAILED", reason: err.message };
        }
    }
}

module.exports = new LinkedInVerification();
