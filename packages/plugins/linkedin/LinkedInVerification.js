const path = require("path");
const fs = require("fs-extra");
const logger = require("../../logger").plugin("linkedin");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class LinkedInVerification {
    /**
     * Production-Grade 4-Stage Verification Engine for LinkedIn Applications
     * @param {Page} page Playwright Page
     * @param {Object} job Target Job Card
     * @param {Object} context Context { networkLogs, beforeSubmitScreenshot, transitions }
     * @returns {Promise<Object>} Detailed Verification Report
     */
    async verifyApplication(page, job, context = {}) {
        const jobId = job.id || job.job_id;
        const evidenceDir = path.join(process.cwd(), "logs", "linkedin", String(jobId));
        await fs.mkdirp(evidenceDir);

        const report = {
            jobId,
            jobTitle: job.title,
            company: job.company,
            timestamp: new Date().toISOString(),
            submissionNetworkStatus: { capturedRequests: (context.networkLogs || []).length, logs: context.networkLogs || [] },
            domVerification: { passed: false, details: null },
            modalClosedVerification: { passed: false, details: null },
            immediateButtonVerification: { passed: false, details: null },
            reloadVerification: { passed: false, details: null },
            finalVerdict: "UNVERIFIED",
            verified: false,
            rootCause: null,
            evidenceDir
        };

        try {
            logger.info(`[Verification] Starting 4-stage production verification for Job ${jobId}...`);

            // Stage 1: Success Banner & Post-Submit Modal Verification
            const stage1Result = await page.evaluate(() => {
                const modal = document.querySelector(".jobs-easy-apply-modal, div[role='dialog'], .jobs-post-apply-modal");
                const modalText = modal ? modal.innerText.toLowerCase() : "";
                const bodyText = document.body ? document.body.innerText.toLowerCase() : "";

                const successBannerEl = document.querySelector([
                    ".artdeco-inline-feedback--success",
                    ".jobs-post-apply-modal",
                    ".artdeco-toast-item--success",
                    ".jobs-easy-apply-content:has-text('Application submitted')"
                ].join(", "));

                const hasSuccessText = (
                    bodyText.includes("application submitted") ||
                    bodyText.includes("your application was sent") ||
                    modalText.includes("application submitted") ||
                    modalText.includes("your application was sent")
                );

                return {
                    hasSuccessBanner: Boolean(successBannerEl || hasSuccessText),
                    bannerText: successBannerEl ? successBannerEl.innerText.trim() : (hasSuccessText ? "Text match: application submitted" : "")
                };
            }).catch(() => ({ hasSuccessBanner: false, bannerText: "" }));

            report.domVerification = {
                passed: stage1Result.hasSuccessBanner,
                details: stage1Result.bannerText || "No post-submit success banner detected"
            };

            // Stage 2: Check Modal Closed
            const isModalClosed = await page.evaluate(() => {
                const modal = document.querySelector(".jobs-easy-apply-modal");
                if (!modal) return true;
                const rect = modal.getBoundingClientRect();
                return rect.width === 0 || rect.height === 0 || window.getComputedStyle(modal).display === "none";
            }).catch(() => true);

            report.modalClosedVerification = {
                passed: isModalClosed,
                details: isModalClosed ? "Modal successfully closed/detached" : "Modal remained visible after submit"
            };

            // Stage 3: Immediate Job Page Apply Button Check
            const stage3Result = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll("button, a"));
                const appliedBtn = buttons.find(b => {
                    const txt = (b.innerText || "").trim().toLowerCase();
                    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
                    return txt === "applied" || txt.includes("applied ") || aria.includes("applied");
                });
                return {
                    hasAppliedButton: Boolean(appliedBtn),
                    buttonText: appliedBtn ? appliedBtn.innerText.trim() : ""
                };
            }).catch(() => ({ hasAppliedButton: false, buttonText: "" }));

            report.immediateButtonVerification = {
                passed: stage3Result.hasAppliedButton,
                details: stage3Result.hasAppliedButton ? `Button text: '${stage3Result.buttonText}'` : "Apply button did not transition to Applied"
            };

            // Take after_submit screenshot
            const afterSubmitScreenshotPath = path.join(evidenceDir, "after_submit.png");
            await page.screenshot({ path: afterSubmitScreenshotPath, fullPage: false }).catch(() => {});

            // Stage 4: Page Reload Re-verification
            logger.info(`[Verification] Stage 4: Reloading job page (${job.url || `https://www.linkedin.com/jobs/view/${jobId}/`}) for authoritative confirmation...`);
            await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            await delay(3500);

            const afterReloadScreenshotPath = path.join(evidenceDir, "after_reload.png");
            await page.screenshot({ path: afterReloadScreenshotPath, fullPage: false }).catch(() => {});

            const htmlContent = await page.content().catch(() => "");
            await fs.writeFile(path.join(evidenceDir, "page_after_reload.html"), htmlContent, "utf8").catch(() => {});

            const stage4Result = await page.evaluate(() => {
                const bodyText = document.body ? document.body.innerText.toLowerCase() : "";
                const buttons = Array.from(document.querySelectorAll("button, a"));
                const appliedBtn = buttons.find(b => {
                    const txt = (b.innerText || "").trim().toLowerCase();
                    const aria = (b.getAttribute("aria-label") || "").toLowerCase();
                    return txt === "applied" || txt.includes("applied ") || aria.includes("applied");
                });

                const isReloadVerified = (
                    Boolean(appliedBtn) ||
                    bodyText.includes("application submitted") ||
                    bodyText.includes("already applied") ||
                    bodyText.includes("applied on")
                );

                return {
                    passed: isReloadVerified,
                    buttonText: appliedBtn ? appliedBtn.innerText.trim() : "",
                    bodySnippet: bodyText.substring(0, 300)
                };
            }).catch(() => ({ passed: false, buttonText: "", bodySnippet: "" }));

            report.reloadVerification = {
                passed: stage4Result.passed,
                details: stage4Result.passed ? `Reload verified (Button: '${stage4Result.buttonText || "Applied"}')` : "Reloaded page missing Applied status"
            };

            // Evaluate Final Verdict
            // Authoritative Rule: Must pass Stage 1 (Success Banner) OR Stage 4 (Page Reload Verification)
            if (report.domVerification.passed || report.reloadVerification.passed) {
                report.finalVerdict = "VERIFIED_APPLIED";
                report.verified = true;
                logger.info(`[Verification] ✅ VERIFIED_APPLIED: Job ${jobId} passed authoritative verification.`);
            } else {
                report.finalVerdict = "UNVERIFIED";
                report.verified = false;

                if (!report.domVerification.passed) report.rootCause = "FAILED_STAGE_1_SUCCESS_BANNER";
                else if (!report.modalClosedVerification.passed) report.rootCause = "FAILED_STAGE_2_MODAL_CLOSED";
                else if (!report.immediateButtonVerification.passed) report.rootCause = "FAILED_STAGE_3_APPLY_BUTTON_TEXT";
                else report.rootCause = "FAILED_STAGE_4_PAGE_RELOAD";

                logger.warn(`[Verification] ⚠️ UNVERIFIED: Job ${jobId} failed verification at stage: ${report.rootCause}`);
            }

            // Save evidence.json
            await fs.writeJson(path.join(evidenceDir, "evidence.json"), report, { spaces: 2 });

            return {
                verified: report.verified,
                status: report.finalVerdict,
                reason: report.rootCause || "Authoritative verification passed",
                report
            };

        } catch (err) {
            logger.error(`[Verification] Critical verification error for Job ${jobId}: ${err.message}`);
            report.finalVerdict = "UNVERIFIED";
            report.verified = false;
            report.rootCause = `VERIFICATION_EXCEPTION: ${err.message}`;
            await fs.writeJson(path.join(evidenceDir, "evidence.json"), report, { spaces: 2 }).catch(() => {});
            return { verified: false, status: "UNVERIFIED", reason: err.message, report };
        }
    }
}

module.exports = new LinkedInVerification();
