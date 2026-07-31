const atsClassifier = require("./ATSClassifier");
const questionnaireEngine = require("./QuestionnaireEngine");
const externalApplicationRouter = require("./ExternalApplicationRouter");
const externalRedirectResolver = require("./ExternalRedirectResolver");
const candidateKnowledgeService = require("../knowledge/CandidateKnowledgeService");
const oraclePersistence = require("../persistence/NaukriOraclePersistence");
const eventBus = require("../events/EventBus");
const telegramService = require("../../apps/telegram");
const db = require("../database");
const logger = require("../logger").plugin("naukri");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ExternalApplicationEngine {
    /**
     * Process an EXTERNAL_REQUIRED Naukri job through redirect capture, ATS classification, questionnaire engine, form execution, and verification.
     * @param {Object} params
     * @param {import('playwright').Page} params.naukriPage Open Naukri job page
     * @param {import('playwright').BrowserContext} params.context Playwright context for popup handling
     * @param {Object} params.job Job metadata object
     * @param {Object} params.candidateProfile CandidateProfile object
     * @param {boolean} params.isDryRun Dry run flag
     * @returns {Promise<{ status: string, applied: number, ats: string, externalUrl: string, reason?: string }>}
     */
    async processExternalJob({ naukriPage, context, job, candidateProfile = {}, isDryRun = false }) {
        logger.info(`\n==================================================`);
        logger.info(`[ExternalApplicationEngine] Processing Job ID: ${job.id} | ${job.title} at ${job.company}`);
        logger.info(`==================================================`);

        let externalPage = null;
        let isPopupCreated = false;

        try {
            // 1. Locate External Action Button on Naukri Job Page (Prefer explicit "Apply on company site")
            const applyBtnLocators = [
                naukriPage.locator("button:has-text('Apply on company site')"),
                naukriPage.locator("a:has-text('Apply on company site')"),
                naukriPage.locator("[class*='apply']:has-text('company site')"),
                naukriPage.locator("button.apply-button"),
                naukriPage.locator("#apply-button"),
                naukriPage.locator("button:has-text('Apply')")
            ];

            let applyBtn = null;
            for (const loc of applyBtnLocators) {
                if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                    applyBtn = loc.first();
                    break;
                }
            }

            if (!applyBtn) {
                logger.warn(`[ExternalEngine] Could not locate apply button for Job ID ${job.id}`);
                await oraclePersistence.updateJobStatus(job.id, 'APPLY_BUTTON_NOT_FOUND');
                return { status: 'APPLY_BUTTON_NOT_FOUND', applied: 0, ats: 'UNKNOWN', externalUrl: job.url };
            }

            // 2. Multi-Channel External Redirect Resolution
            const resolution = await externalRedirectResolver.resolveExternalDestination({
                page: naukriPage,
                context,
                applyBtn
            });

            // HARD DOMAIN INVARIANT CHECK
            if (!resolution.resolved || !resolution.isExternalDomain) {
                logger.warn(`⚠️ [ExternalEngine] HARD DOMAIN INVARIANT TRIGGERED: Destination URL (${resolution.destinationUrl || job.url}) remains on naukri.com.`);
                logger.warn(`   Flagging EXTERNAL_HANDOFF_UNRESOLVED. Consuming 0 verified application slots.`);

                await oraclePersistence.updateJobStatus(job.id, 'EXTERNAL_HANDOFF_UNRESOLVED');
                await db.run("UPDATE jobs SET status = 'EXTERNAL_HANDOFF_UNRESOLVED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [job.id]).catch(() => {});

                if (resolution.isPopupCreated && resolution.pageInstance) {
                    await resolution.pageInstance.close().catch(() => {});
                }

                return {
                    status: 'EXTERNAL_HANDOFF_UNRESOLVED',
                    applied: 0,
                    ats: 'NAUKRI_INTERNAL',
                    externalUrl: resolution.destinationUrl || job.url,
                    reason: 'Destination domain is naukri.com (external redirect did not occur)'
                };
            }

            externalPage = resolution.pageInstance;
            isPopupCreated = resolution.isPopupCreated;
            const externalUrl = resolution.destinationUrl;

            logger.info(`✓ [ExternalEngine] External Destination Confirmed: ${externalUrl} (Domain: ${resolution.destinationDomain}, Method: ${resolution.method})`);

            // 3. ATS Classification on External Page & URL
            const classification = await atsClassifier.classify(externalPage, externalUrl);
            logger.info(`[ExternalEngine] Classified ATS: ${classification.ats} (Confidence: ${classification.confidence}, Domain: ${classification.domain})`);

            if (classification.ats === "NAUKRI_INTERNAL") {
                logger.warn(`[ExternalEngine] ATS classifier rejected naukri.com domain. Flagging EXTERNAL_HANDOFF_UNRESOLVED.`);
                await oraclePersistence.updateJobStatus(job.id, 'EXTERNAL_HANDOFF_UNRESOLVED');
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'EXTERNAL_HANDOFF_UNRESOLVED', applied: 0, ats: 'NAUKRI_INTERNAL', externalUrl };
            }

            // Persist discovery of external redirect details into Oracle & DB
            const extPayload = {
                sourcePortal: "Naukri",
                applicationPortal: classification.ats,
                ats: classification.ats,
                originalUrl: job.url,
                externalUrl,
                company: job.company,
                role: job.title,
                job_id: job.id,
                handoffMethod: resolution.method
            };

            await oraclePersistence.recordJob({
                ...job,
                url: externalUrl,
                ats: classification.ats,
                applicationPortal: classification.ats
            }).catch(() => {});

            await db.run(
                "UPDATE jobs SET url = ?, status = 'EXTERNAL_REDIRECTED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?",
                [externalUrl, job.id]
            ).catch(() => {});

            if (isDryRun) {
                logger.info(`[ExternalEngine] DRY RUN mode active. External redirect confirmed & ATS classified as ${classification.ats}. Aborting submission.`);
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'EXTERNAL_REQUIRED', applied: 0, ats: classification.ats, externalUrl };
            }

            // 3. Select Adapter & Check Auth/MFA/Captcha Security Constraints
            const adapter = externalApplicationRouter.getAdapter(classification.ats);
            const authCheck = await adapter.detectAuthOrCaptcha(externalPage);

            if (authCheck.blocked) {
                const blockedStatus = authCheck.reason || 'WAITING_FOR_INPUT';
                logger.warn(`⚠️ [ExternalEngine] Application halted on ${classification.ats}: ${blockedStatus} (${authCheck.details})`);

                await oraclePersistence.updateJobStatus(job.id, blockedStatus);
                await db.run("UPDATE jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [blockedStatus, job.id]).catch(() => {});

                await telegramService.sendExternalActionRequiredNotification({
                    portal: "Naukri",
                    ats: classification.ats,
                    company: job.company,
                    role: job.title,
                    status: blockedStatus,
                    reason: authCheck.details,
                    url: externalUrl,
                    jobId: job.id
                }).catch(e => logger.error(`Telegram notification error: ${e.message}`));

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: blockedStatus, applied: 0, ats: classification.ats, externalUrl, reason: authCheck.details };
            }

            // 4. Attach Candidate Resume
            const resumePath = await candidateKnowledgeService.getResumePath().catch(() => null);
            if (resumePath) {
                await adapter.uploadResume(externalPage, resumePath);
            }

            // 5. Questionnaire Engine & Required Field Validation
            const fillResult = await adapter.fillForm(externalPage, candidateProfile, questionnaireEngine);

            if (!fillResult.success || fillResult.status === "WAITING_FOR_INPUT") {
                const missingField = fillResult.unresolvedRequired?.[0]?.label || "Required form question unresolved";
                logger.warn(`⚠️ [ExternalEngine] Unresolved required question on ${classification.ats}: "${missingField}". Marking WAITING_FOR_INPUT.`);

                await oraclePersistence.updateJobStatus(job.id, 'WAITING_FOR_INPUT');
                await db.run("UPDATE jobs SET status = 'WAITING_FOR_INPUT', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [job.id]).catch(() => {});

                await telegramService.sendExternalActionRequiredNotification({
                    portal: "Naukri",
                    ats: classification.ats,
                    company: job.company,
                    role: job.title,
                    status: "WAITING_FOR_INPUT",
                    reason: `Unresolved required field: "${missingField}"`,
                    url: externalUrl,
                    jobId: job.id
                }).catch(e => logger.error(`Telegram notification error: ${e.message}`));

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'WAITING_FOR_INPUT', applied: 0, ats: classification.ats, externalUrl, reason: missingField };
            }

            // 6. Submit Application
            logger.info(`[ExternalEngine] Executing Submit on ${classification.ats}...`);
            const submitClicked = await adapter.submit(externalPage);
            if (!submitClicked) {
                logger.warn(`[ExternalEngine] Submit action button could not be clicked on ${classification.ats}.`);
                await oraclePersistence.updateJobStatus(job.id, 'SUBMIT_FAILED');
                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'SUBMIT_FAILED', applied: 0, ats: classification.ats, externalUrl };
            }

            // 7. Layered Independent Submission Verification
            const verifyResult = await adapter.verifySubmission(externalPage);

            if (verifyResult.verified) {
                logger.info(`✓ [ExternalEngine] VERIFIED EXTERNAL APPLICATION SUBMITTED! (${classification.ats})`);
                await oraclePersistence.updateJobStatus(job.id, 'EMPLOYER_PENDING', 1);
                await oraclePersistence.recordEvent(`evt_${Date.now()}_${job.id}`, job.id, 'naukri', 'EXTERNAL_APPLICATION_SUBMITTED', extPayload);
                await db.run("UPDATE jobs SET applied = 1, status = 'EMPLOYER_PENDING', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [job.id]).catch(() => {});
                eventBus.publish("APPLICATION_SUBMITTED", { portal: "Naukri", ats: classification.ats, jobId: job.id, title: job.title, company: job.company });

                await telegramService.sendExternalApplicationSubmittedNotification({
                    portal: "Naukri",
                    ats: classification.ats,
                    company: job.company,
                    role: job.title,
                    status: "EMPLOYER_PENDING",
                    url: externalUrl,
                    jobId: job.id
                }).catch(e => logger.error(`Telegram send error: ${e.message}`));

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'EMPLOYER_PENDING', applied: 1, ats: classification.ats, externalUrl };
            } else {
                logger.warn(`⚠️ [ExternalEngine] Unverified submission state on ${classification.ats}. Flagging CLICKED_UNVERIFIED.`);
                await oraclePersistence.updateJobStatus(job.id, 'CLICKED_UNVERIFIED');
                await db.run("UPDATE jobs SET status = 'CLICKED_UNVERIFIED', updated_at = CURRENT_TIMESTAMP WHERE LOWER(portal) = 'naukri' AND job_id = ?", [job.id]).catch(() => {});

                if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
                return { status: 'CLICKED_UNVERIFIED', applied: 0, ats: classification.ats, externalUrl };
            }

        } catch (err) {
            logger.error(`❌ [ExternalEngine] Exception handling external job ${job.id}: ${err.message}`);
            await oraclePersistence.updateJobStatus(job.id, 'EXTERNAL_FAILED');
            if (isPopupCreated && externalPage) await externalPage.close().catch(() => {});
            return { status: 'EXTERNAL_FAILED', applied: 0, ats: 'UNKNOWN', externalUrl: job.url, reason: err.message };
        }
    }
}

module.exports = new ExternalApplicationEngine();
