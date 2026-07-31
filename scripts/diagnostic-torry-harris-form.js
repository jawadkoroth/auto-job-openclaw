const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 1 DEEP DIAGNOSTIC: TORRY HARRIS APPLY ACTION");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    const { browser, context } = boot;
    const directExternalUrl = "https://careers.torryharris.com/torryharris/jobview/aws-cloud-and-devops-engineer-bangalore-karnataka-india-2026072314545284?source=naukri";

    try {
        const extPage = await context.newPage();

        // Listen for popup event or network requests
        const popups = [];
        context.on('page', p => popups.push(p));

        const apiRequests = [];
        extPage.on('request', req => {
            if (req.resourceType() === 'xhr' || req.resourceType() === 'fetch') {
                apiRequests.push(req.url());
            }
        });

        await extPage.goto(directExternalUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await delay(5000);

        const applyBtn = extPage.locator('button:has-text("Apply"), a:has-text("Apply")').first();
        console.log("[1] Clicking Apply button on Torry Harris job page...");

        const [popup] = await Promise.all([
            context.waitForEvent('page', { timeout: 8000 }).catch(() => null),
            applyBtn.click().catch(() => {})
        ]);

        await delay(5000);

        if (popup) {
            console.log(`✓ POPUP TRIGGERED on Apply click!`);
            console.log(`  Popup URL: ${popup.url()}`);
            await popup.waitForLoadState('domcontentloaded').catch(() => {});
            const popupInputs = await popup.evaluate(() => {
                return Array.from(document.querySelectorAll('input, select, textarea')).map(i => ({
                    id: i.id, name: i.name, type: i.type, placeholder: i.placeholder, label: i.innerText || i.placeholder
                }));
            }).catch(() => []);
            console.log(`  Popup Inputs Count: ${popupInputs.length}`);
            popupInputs.forEach(i => console.log(`    • Input: type=${i.type}, name="${i.name}", id="${i.id}", placeholder="${i.placeholder}"`));
            await popup.close().catch(() => {});
        } else {
            console.log("No popup triggered. Inspecting main page DOM changes & iframes...");

            const modalOrIframe = await extPage.evaluate(() => {
                const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id, className: f.className }));
                const modals = Array.from(document.querySelectorAll('.modal, .dialog, [role="dialog"], [class*="modal"], [class*="popup"], [class*="form"]'))
                    .filter(m => m.offsetWidth > 0 && m.offsetHeight > 0)
                    .map(m => ({ className: m.className, text: m.innerText.substring(0, 200) }));
                const allInputs = Array.from(document.querySelectorAll('input, select, textarea')).map(i => ({
                    id: i.id, name: i.name, type: i.type, placeholder: i.placeholder || '', required: i.required
                }));

                return { iframes, modals, allInputs };
            }).catch(() => ({ iframes: [], modals: [], allInputs: [] }));

            console.log("  Visible Modals Count: ", modalOrIframe.modals.length);
            modalOrIframe.modals.forEach(m => console.log(`    • Modal: class="${m.className}", text="${m.text}"`));

            console.log("  iFrames Count:        ", modalOrIframe.iframes.length);
            modalOrIframe.iframes.forEach(f => console.log(`    • iFrame: src="${f.src}", id="${f.id}", class="${f.className}"`));

            console.log("  All Inputs Count:     ", modalOrIframe.allInputs.length);
            modalOrIframe.allInputs.forEach(i => console.log(`    • Input: type=${i.type}, name="${i.name}", id="${i.id}", placeholder="${i.placeholder}"`));

            // Check if frame exists
            const frames = extPage.frames();
            console.log(`  Total Page Frames: ${frames.length}`);
            for (let fIdx = 0; fIdx < frames.length; fIdx++) {
                const f = frames[fIdx];
                const frameInputs = await f.evaluate(() => Array.from(document.querySelectorAll('input, select, textarea')).map(i => ({
                    id: i.id, name: i.name, type: i.type, placeholder: i.placeholder || ''
                }))).catch(() => []);
                console.log(`    Frame #${fIdx + 1} (${f.url()}): ${frameInputs.length} input(s)`);
                frameInputs.forEach(i => console.log(`      • Frame Input: type=${i.type}, name="${i.name}", id="${i.id}"`));
            }
        }

        console.log("\n==================================================");
        console.log("DEEP DIAGNOSTIC COMPLETE");
        console.log("==================================================");

        await extPage.close().catch(() => {});
    } catch (err) {
        console.error(`❌ Diagnostic exception: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
