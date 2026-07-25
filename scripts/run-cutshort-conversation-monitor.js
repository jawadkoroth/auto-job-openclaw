const path = require("path");
const fs = require("fs-extra");
const { chromium } = require("playwright");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const db = require("../packages/database");
const logger = require("../packages/logger").cutshort;
const eventBus = require("../packages/events/EventBus");
const conversationEngine = require("../packages/automation/ConversationEngine");
const telegramService = require("../apps/telegram");

(async () => {
    console.log("==================================================");
    console.log("CUTSHORT CONVERSATION MONITOR");
    console.log(`Execution Time: ${new Date().toISOString()}`);
    console.log("==================================================\n");

    await db.init();

    const activeConversations = await conversationEngine.getActiveConversations("cutshort");
    console.log(`Active Cutshort Conversations to Monitor: ${activeConversations.length}`);

    const sessionPath = path.join(process.cwd(), "sessions", "cutshort");
    const storageStatePath = path.join(sessionPath, "storageState.json");

    if (!fs.existsSync(storageStatePath)) {
        console.error("❌ Session expired or missing: sessions/cutshort/storageState.json not found.");
        eventBus.publish("CUTSHORT_SESSION_EXPIRED", { portal: "cutshort", timestamp: new Date().toISOString() });
        process.exit(1);
    }

    let browser = null;
    let context = null;

    try {
        browser = await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
        });

        context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport: { width: 1440, height: 900 },
            storageState: storageStatePath
        });

        const page = await context.newPage();

        // 1. Session Health Check
        console.log("[1/2] Verifying Cutshort Session & Navigating to Messages...");
        await page.goto("https://cutshort.io/profile/candidate-dashboard", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(2000);

        const currentUrl = page.url();
        const loginBtns = await page.locator("a:has-text('Login'), button:has-text('Login'), input[type='email']").count().catch(() => 0);

        if (loginBtns > 0 || (!currentUrl.includes("/profile") && !currentUrl.includes("/dashboard"))) {
            console.error("❌ Cutshort session expired during conversation monitoring.");
            eventBus.publish("CUTSHORT_SESSION_EXPIRED", { portal: "cutshort", url: currentUrl });
            process.exit(1);
        }

        // Navigate to candidate conversations
        const messagesUrl = "https://cutshort.io/profile/candidate-conversations?stage=unread";
        console.log(` -> Navigating to Cutshort Candidate Conversations: ${messagesUrl}`);
        await page.goto(messagesUrl, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // 2. Scan active conversations on portal
        console.log("\n[2/2] Scanning Candidate Messages Drawer & Unread Messages...");
        const convCards = page.locator("[class*='conversation'], [class*='chat-item'], [class*='thread']");
        const convCardCount = await convCards.count().catch(() => 0);

        console.log(` -> Found ${convCardCount} active message cards on Cutshort UI.`);

        let newMessagesDetected = 0;
        let questionnairesDetected = 0;
        let interviewsDetected = 0;
        let offersDetected = 0;

        for (let i = 0; i < Math.min(convCardCount, 15); i++) {
            try {
                const card = convCards.nth(i);
                const text = await card.innerText().catch(() => "");
                const tLower = text.toLowerCase();

                if (!text) continue;

                // Extract company / recruiter
                const companyName = text.split("\n")[0] || "Cutshort Employer";

                // Check for specific events
                if (tLower.includes("interview") || tLower.includes("schedule") || tLower.includes("call")) {
                    interviewsDetected++;
                    eventBus.publish(eventBus.EVENTS.INTERVIEW_REQUESTED, {
                        portal: "cutshort",
                        company: companyName,
                        textSnippet: text.substring(0, 100)
                    });
                } else if (tLower.includes("offer") || tLower.includes("congratulations")) {
                    offersDetected++;
                    eventBus.publish(eventBus.EVENTS.OFFER_RECEIVED, {
                        portal: "cutshort",
                        company: companyName,
                        textSnippet: text.substring(0, 100)
                    });
                } else if (tLower.includes("question") || tLower.includes("fill") || tLower.includes("form")) {
                    questionnairesDetected++;
                    eventBus.publish(eventBus.EVENTS.QUESTIONNAIRE_FOUND, {
                        portal: "cutshort",
                        company: companyName,
                        textSnippet: text.substring(0, 100)
                    });
                } else {
                    newMessagesDetected++;
                    eventBus.publish("EMPLOYER_MESSAGE_RECEIVED", {
                        portal: "cutshort",
                        company: companyName,
                        textSnippet: text.substring(0, 100)
                    });
                }

            } catch (e) {}
        }

        // Touch last checked timestamp for tracked active conversations
        for (const conv of activeConversations) {
            await conversationEngine.touchLastChecked(conv.conversation_id);
        }

        console.log("\n==================================================");
        console.log("CUTSHORT CONVERSATION MONITOR SUMMARY");
        console.log("==================================================");
        console.log(`Active Conversations Tracked: ${activeConversations.length}`);
        console.log(`UI Message Cards Found:       ${convCardCount}`);
        console.log(`New Employer Messages:        ${newMessagesDetected}`);
        console.log(`Questionnaires Detected:      ${questionnairesDetected}`);
        console.log(`Interview Requests Detected:  ${interviewsDetected}`);
        console.log(`Offers Detected:              ${offersDetected}`);
        console.log("==================================================\n");

    } catch (err) {
        console.error("❌ Conversation Monitor Error:", err);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
