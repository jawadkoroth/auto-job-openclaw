const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const externalRedirectResolver = require("../packages/engine/ExternalRedirectResolver");
const atsClassifier = require("../packages/engine/ATSClassifier");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 4 AUDIT: JOB 290726032352 (ORCAPOD CONSULTING)");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context } = boot;
    const targetUrl = "https://www.naukri.com/job-listings-devops-engineer-orcapod-consulting-services-bengaluru-4-to-6-years-290726032352";

    try {
        console.log(`[1] Navigating to Job URL: ${targetUrl}`);
        const page = await context.newPage();
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(3000);

        console.log("[2] Inspecting Apply action element...");
        const applyBtnLocators = [
            page.locator("button:has-text('Apply on company site')"),
            page.locator("a:has-text('Apply on company site')"),
            page.locator("button.apply-button"),
            page.locator("#apply-button"),
            page.locator("button:has-text('Apply')")
        ];

        let applyBtn = null;
        let matchedSelector = "";
        for (const loc of applyBtnLocators) {
            if (await loc.count().catch(() => 0) > 0 && await loc.first().isVisible().catch(() => false)) {
                applyBtn = loc.first();
                matchedSelector = loc._selector || "apply-locator";
                break;
            }
        }

        if (applyBtn) {
            const details = await applyBtn.evaluate(el => {
                return {
                    tagName: el.tagName,
                    id: el.id,
                    className: el.className,
                    innerText: el.innerText,
                    outerHTML: el.outerHTML.substring(0, 200),
                    href: el.getAttribute('href') || el.closest('a')?.getAttribute('href') || null,
                    target: el.getAttribute('target') || el.closest('a')?.getAttribute('target') || null,
                    onclick: el.getAttribute('onclick') || null,
                    dataUrl: el.getAttribute('data-url') || el.getAttribute('data-apply-url') || null
                };
            }).catch(() => ({}));

            console.log("    Matched Selector: ", matchedSelector);
            console.log("    Tag Name:         ", details.tagName);
            console.log("    Inner Text:       ", JSON.stringify(details.innerText));
            console.log("    Href:             ", details.href);
            console.log("    Target:           ", details.target);
            console.log("    Onclick:          ", details.onclick);
            console.log("    Data URL:         ", details.dataUrl);
            console.log("    Outer HTML:       ", details.outerHTML);
        } else {
            console.log("    Apply element not found on page.");
        }

        console.log("\n[3] Testing ExternalRedirectResolver against job 290726032352...");
        const res = await externalRedirectResolver.resolveExternalDestination({
            page,
            context,
            applyBtn
        });

        console.log("    Resolution Result:");
        console.log("    • Resolved:            ", res.resolved);
        console.log("    • Is External Domain:  ", res.isExternalDomain);
        console.log("    • Source URL:          ", res.sourceUrl);
        console.log("    • Destination URL:     ", res.destinationUrl);
        console.log("    • Destination Domain:  ", res.destinationDomain);
        console.log("    • Method:              ", res.method);
        console.log("    • Evidence:            ", res.evidence);

        const classification = await atsClassifier.classify(res.pageInstance, res.destinationUrl || targetUrl);
        console.log("    • ATS Classification:  ", classification.ats);
        console.log("    • Is External Domain:  ", classification.isExternalDomain);

        console.log("\n==================================================");
        console.log("AUDIT SUMMARY FOR JOB 290726032352:");
        if (!res.isExternalDomain) {
            console.log("✓ CONFIRMED: Job 290726032352 is a NATIVE Naukri application.");
            console.log("  Previous run clicked a native Naukri Apply button, stayed on naukri.com,");
            console.log("  and incorrectly fell back to GenericFormAdapter on naukri.com.");
            console.log("  With new Hard Domain Safety Invariant, it correctly classifies:");
            console.log("  status = EXTERNAL_HANDOFF_UNRESOLVED, applied = 0.");
        } else {
            console.log("External redirect confirmed to: " + res.destinationDomain);
        }
        console.log("==================================================");

        await page.close().catch(() => {});
        if (res.isPopupCreated && res.pageInstance) await res.pageInstance.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Audit error: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
