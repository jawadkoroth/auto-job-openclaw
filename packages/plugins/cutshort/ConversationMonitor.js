const conversationEngine = require("../../automation/ConversationEngine");
const questionnaireEngine = require("./QuestionnaireEngine");
const telegramService = require("../../../apps/telegram");
const db = require("../../database");
const logger = require("../../logger").automation;

class ConversationMonitor {
    /**
     * Check active conversations on Cutshort (Phase 3 Optimization)
     * @param {import("playwright").Page} page 
     * @returns {Promise<{ scanned: number, updated: number, pendingInput: number }>}
     */
    async scanConversations(page) {
        // Fetch active conversations only from normalized table (Phase 3)
        const activeConversations = await conversationEngine.getActiveConversations("cutshort");
        logger.info(`[ConversationMonitor] Active conversations pending scan: ${activeConversations.length}`);

        logger.info("[ConversationMonitor] Navigating to Cutshort Messages (https://cutshort.io/messages)...");
        await page.goto("https://cutshort.io/messages", { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => {});
        await page.waitForTimeout(3000);

        const results = { scanned: 0, updated: 0, pendingInput: 0 };

        // Check if messages page loaded
        const currentUrl = page.url();
        if (!currentUrl.includes("/messages") && !currentUrl.includes("/conversations")) {
            logger.warn(`[ConversationMonitor] Page redirected to ${currentUrl}. User may need to log in.`);
            return results;
        }

        // Extract conversation threads
        const threadSelectors = [
            "[class*='conversation' i]",
            "[class*='thread' i]",
            "[class*='message-item' i]",
            "a[href*='/messages/']",
            ".chat-thread-item"
        ];

        let threads = [];
        for (const sel of threadSelectors) {
            const locs = page.locator(sel);
            const cnt = await locs.count().catch(() => 0);
            if (cnt > 0) {
                for (let i = 0; i < cnt; i++) {
                    threads.push(locs.nth(i));
                }
                break;
            }
        }

        logger.info(`[ConversationMonitor] Found ${threads.length} total conversation threads on page.`);
        results.scanned = threads.length;

        for (let idx = 0; idx < Math.min(threads.length, 10); idx++) {
            try {
                const thread = threads[idx];
                await thread.click().catch(() => {});
                await page.waitForTimeout(2000);

                // Extract conversation company / title
                const headerText = await page.locator("header, [class*='header' i], [class*='chat-title' i]").first().innerText().catch(() => "");
                const lastMsgText = await page.locator("[class*='message' i], [class*='chat-bubble' i]").last().innerText().catch(() => "");
                const convId = `cutshort_thread_${idx + 1}`;

                // Touch last_checked_at timestamp (Phase 3)
                await conversationEngine.touchLastChecked(convId);

                logger.info(`[ConversationMonitor] Thread #${idx + 1} Last Message: "${lastMsgText.slice(0, 80)}..."`);

                // Check for closed conversation indicator
                const isClosed = await page.locator("text=/closed/i, text=/rejected/i, text=/position filled/i").count().catch(() => 0);
                if (isClosed > 0) {
                    logger.info(`[ConversationMonitor] Conversation #${idx + 1} marked CLOSED/REJECTED.`);
                    await conversationEngine.getOrCreateConversation({
                        conversationId: convId,
                        portal: "cutshort",
                        jobId: `job_${idx + 1}`,
                        company: headerText
                    });
                    await conversationEngine.updateConversation(convId, {
                        conversation_status: "CLOSED",
                        closed: 1,
                        last_message: lastMsgText
                    });
                    results.updated++;
                    continue;
                }

                // Check for interview invitations or coding tests
                const isInterview = /interview|schedule|call|meeting|calendar/i.test(lastMsgText);
                const isCodingTest = /test|assessment|hackerrank|codebyte|codility/i.test(lastMsgText);

                if (isInterview || isCodingTest) {
                    const eventType = isInterview ? "INTERVIEW_REQUESTED" : "CODING_TEST_RECEIVED";
                    logger.info(`[ConversationMonitor] Detected event: ${eventType}`);

                    await conversationEngine.getOrCreateConversation({
                        conversationId: convId,
                        portal: "cutshort",
                        jobId: `job_${idx + 1}`,
                        company: headerText
                    });

                    await conversationEngine.updateConversation(convId, {
                        conversation_status: eventType,
                        last_message: lastMsgText,
                        interview_requested: isInterview ? 1 : 0,
                        coding_test_requested: isCodingTest ? 1 : 0
                    });

                    await telegramService.sendNotification({
                        title: `Cutshort Event: ${eventType}`,
                        message: `Employer Message from ${headerText}:\n"${lastMsgText.slice(0, 300)}"`
                    }).catch(() => {});

                    results.updated++;
                    continue;
                }

                // Check for questionnaires inside the conversation
                const hasQuestionnaire = await page.locator("form, [class*='question' i], [class*='FormGroup' i]").count().catch(() => 0);
                if (hasQuestionnaire > 0) {
                    logger.info(`[ConversationMonitor] Detected questionnaire in conversation thread #${idx + 1}`);
                    const mockJob = { portal: "cutshort", job_id: `conv_${idx}`, company: headerText || "Cutshort Employer", title: "Cutshort Application" };
                    const qRes = await questionnaireEngine.processQuestionnaire(page, mockJob);
                    if (!qRes.success && qRes.status === "WAITING_FOR_INPUT") {
                        results.pendingInput++;
                    }
                    results.updated++;
                }

            } catch (e) {
                logger.warn(`[ConversationMonitor] Error scanning thread #${idx + 1}: ${e.message}`);
            }
        }

        return results;
    }
}

module.exports = new ConversationMonitor();
