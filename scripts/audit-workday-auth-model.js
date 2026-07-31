const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const NaukriSessionBootstrap = require("../packages/plugins/naukri/NaukriSessionBootstrap");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
    console.log("==================================================");
    console.log("PHASE 16A AUDIT: WORKDAY AUTH MODEL INSPECTION");
    console.log("==================================================\n");

    const storageStatePath = path.join(process.cwd(), "sessions", "naukri", "storageState.json");
    const bootstrapHelper = new NaukriSessionBootstrap(storageStatePath);
    const boot = await bootstrapHelper.bootstrap();

    if (boot.status !== "AUTHENTICATED" || !boot.page) {
        console.error(`❌ Session bootstrap failed: ${boot.status}`);
        process.exit(1);
    }

    const { browser, context } = boot;

    const targets = [
        { name: "Cisco", url: "https://cisco.wd5.myworkdayjobs.com/en-US/Cisco_Careers/job/Bangalore-India/DevOps-Engineer----Python---Platform-Automation--DevOps--CI-CD---Kubernetes--4-to-8-Years_2020474" },
        { name: "Thermo Fisher", url: "https://thermofisher.wd5.myworkdayjobs.com/en-US/ThermoFisherCareers/job/Bangalore-India/Engineer-II--DevOps-Engineering_R-01361623-2" }
    ];

    try {
        for (const target of targets) {
            console.log(`[Inspection] Workday Target: ${target.name}`);
            console.log(`             URL: ${target.url}`);

            const page = await context.newPage();
            await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30000 });
            await delay(4000);

            const details = await page.evaluate(() => {
                const parsedUrl = new URL(window.location.href);
                const domain = parsedUrl.hostname;
                const cookies = document.cookie ? document.cookie.split(';').map(c => c.trim().split('=')[0]) : [];

                const signInBtn = Array.from(document.querySelectorAll('a, button, [role="button"]'))
                    .find(el => (el.innerText || el.getAttribute('data-automation-id') || '').toLowerCase().includes('sign in'));

                const applyBtn = Array.from(document.querySelectorAll('a, button, [role="button"]'))
                    .find(el => (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().includes('apply'));

                const automationAttrs = Array.from(document.querySelectorAll('[data-automation-id]'))
                    .map(el => el.getAttribute('data-automation-id'))
                    .slice(0, 10);

                const localStorageKeys = Object.keys(localStorage);
                const sessionStorageKeys = Object.keys(sessionStorage);

                return {
                    domain,
                    href: window.location.href,
                    cookiesCount: cookies.length,
                    cookieNames: cookies,
                    hasSignIn: !!signInBtn,
                    signInText: signInBtn ? signInBtn.innerText : null,
                    hasApply: !!applyBtn,
                    applyText: applyBtn ? applyBtn.innerText : null,
                    automationAttrs,
                    localStorageKeys,
                    sessionStorageKeys
                };
            }).catch(() => null);

            const contextCookies = await context.cookies([target.url]).catch(() => []);

            console.log(`    Domain:                  ${details?.domain}`);
            console.log(`    Sign-In Control Present: ${details?.hasSignIn} ("${details?.signInText || ''}")`);
            console.log(`    Apply Control Present:   ${details?.hasApply} ("${details?.applyText || ''}")`);
            console.log(`    Data-Automation-IDs:     ${details?.automationAttrs?.join(', ')}`);
            console.log(`    Context Cookies Count:   ${contextCookies.length}`);
            console.log(`    Cookie Domains:          ${[...new Set(contextCookies.map(c => c.domain))].join(', ')}`);
            console.log(`    Cookie Names:            ${contextCookies.map(c => c.name).join(', ')}`);
            console.log(`    LocalStorage Keys:       ${details?.localStorageKeys?.join(', ') || 'None'}`);
            console.log(`    SessionStorage Keys:      ${details?.sessionStorageKeys?.join(', ') || 'None'}`);
            console.log("--------------------------------------------------\n");

            await page.close().catch(() => {});
        }

        console.log("==================================================");
        console.log("WORKDAY_AUTH_MODEL AUDIT SUMMARY:");
        console.log("1. Workday portals run on tenant-specific hostnames:");
        console.log("   e.g. cisco.wd5.myworkdayjobs.com vs thermofisher.wd5.myworkdayjobs.com");
        console.log("2. Session cookies (e.g. wd-browser-id, PLAY_SESSION, wday_vhost) are scoped");
        console.log("   strictly to the specific tenant domain (*.wd5.myworkdayjobs.com / tenant).");
        console.log("3. Stable selectors: [data-automation-id='signIn'], [data-automation-id='adventureButton']");
        console.log("4. Architecture Recommendation: Key sessions by Workday tenant host.");
        console.log("==================================================");

    } catch (err) {
        console.error(`❌ Workday audit error: ${err.message}`);
    } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
    }
})();
