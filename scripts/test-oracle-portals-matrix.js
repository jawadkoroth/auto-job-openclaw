const { chromium } = require("playwright");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const portalsToTest = [
    { name: "Hirist", url: "https://www.hirist.tech", category: "India Tech", target: "DevOps/Cloud" },
    { name: "Foundit", url: "https://www.foundit.in", category: "India General", target: "DevOps/Cloud" },
    { name: "LinkedIn Jobs", url: "https://www.linkedin.com/jobs", category: "Global / India", target: "DevOps/Cloud" },
    { name: "Instahyre", url: "https://www.instahyre.com", category: "India Tech", target: "DevOps/Cloud" },
    { name: "Cutshort", url: "https://cutshort.io", category: "India Tech", target: "DevOps/Cloud" },
    { name: "Wellfound", url: "https://wellfound.com", category: "Global Startup/Remote", target: "DevOps/Cloud" },
    { name: "We Work Remotely", url: "https://weworkremotely.com", category: "Global Remote", target: "DevOps/Cloud" },
    { name: "Remotive", url: "https://remotive.com", category: "Global Remote", target: "DevOps/Cloud" },
    { name: "Remote OK", url: "https://remoteok.com", category: "Global Remote", target: "DevOps/Cloud" },
    { name: "Himalayas", url: "https://himalayas.app", category: "Global Remote", target: "DevOps/Cloud" },
    { name: "NoDesk", url: "https://nodesk.co", category: "Global Remote", target: "DevOps/Cloud" },
    { name: "Working Nomads", url: "https://www.workingnomads.com/jobs", category: "Global Remote", target: "DevOps/Cloud" },
    { name: "Shine", url: "https://www.shine.com", category: "India General", target: "DevOps/Cloud" },
    { name: "TimesJobs", url: "https://www.timesjobs.com", category: "India General", target: "DevOps/Cloud" },
    { name: "Indeed India", url: "https://in.indeed.com", category: "Global / India", target: "DevOps/Cloud" },
    { name: "Glassdoor", url: "https://www.glassdoor.co.in", category: "Global / India", target: "DevOps/Cloud" }
];

function checkHttp(targetUrl) {
    return new Promise((resolve) => {
        try {
            const u = new URL(targetUrl);
            const client = u.protocol === "https:" ? https : http;
            const req = client.request(targetUrl, {
                method: "GET",
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                    "Accept-Language": "en-US,en;q=0.9"
                },
                timeout: 10000
            }, (res) => {
                resolve({ status: res.statusCode, headers: res.headers });
            });
            req.on("error", (err) => resolve({ status: "ERR", error: err.message }));
            req.on("timeout", () => { req.destroy(); resolve({ status: "TIMEOUT" }); });
            req.end();
        } catch (e) {
            resolve({ status: "INVALID_URL", error: e.message });
        }
    });
}

async function runMatrixTest() {
    console.log("==================================================");
    console.log("ORACLE VM MULTI-PORTAL COMPATIBILITY MATRIX TEST");
    console.log("==================================================\n");

    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
    });

    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        viewport: { width: 1440, height: 900 }
    });

    const results = [];

    for (const p of portalsToTest) {
        console.log(`[Testing Portal] ${p.name} (${p.url})...`);
        const httpRes = await checkHttp(p.url);
        
        let browserNav = "FAIL";
        let title = "";
        let captcha = false;
        let cloudflare = false;

        const page = await context.newPage();
        try {
            const navRes = await page.goto(p.url, { waitUntil: "domcontentloaded", timeout: 25000 });
            if (navRes) {
                browserNav = `HTTP ${navRes.status()}`;
                title = await page.title().catch(() => "");
                const content = await page.content().catch(() => "");
                
                if (content.includes("cf-challenge") || content.includes("Cloudflare") || title.includes("Just a moment...")) {
                    cloudflare = true;
                }
                if (content.includes("g-recaptcha") || content.includes("hcaptcha") || content.includes("cf-turnstile")) {
                    captcha = true;
                }
            }
        } catch (err) {
            browserNav = `ERR: ${err.message.slice(0, 40)}`;
        } finally {
            await page.close().catch(() => {});
        }

        results.push({
            name: p.name,
            url: p.url,
            category: p.category,
            httpStatus: httpRes.status,
            browserNav,
            title: title.slice(0, 40),
            cloudflare,
            captcha
        });

        console.log(`  -> HTTP: ${httpRes.status} | Browser: ${browserNav} | Title: "${title.slice(0, 30)}" | Cloudflare: ${cloudflare} | Captcha: ${captcha}\n`);
    }

    await browser.close();

    console.log("==================================================");
    console.log("COMPATIBILITY TEST RESULTS SUMMARY");
    console.log("==================================================");
    console.table(results);
}

runMatrixTest().catch(console.error);
