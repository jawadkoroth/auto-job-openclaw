const https = require("https");
const ExternalApplicationRouter = require("../packages/router/ExternalApplicationRouter");

function fetchHtml(url) {
    return new Promise((resolve) => {
        https.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9"
            }
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => resolve({ status: res.statusCode, data }));
        }).on("error", (err) => resolve({ status: "ERR", data: "" }));
    });
}

function followRedirects(initialUrl, maxRedirects = 5) {
    return new Promise((resolve) => {
        let currentUrl = initialUrl;
        let count = 0;

        function step(targetUrl) {
            if (count >= maxRedirects) return resolve(currentUrl);
            count++;
            try {
                const u = new URL(targetUrl);
                const client = u.protocol === "https:" ? https : http;
                const req = client.request(targetUrl, {
                    method: "GET",
                    headers: {
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    },
                    timeout: 8000
                }, (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        let nextUrl = res.headers.location;
                        if (!nextUrl.startsWith("http")) {
                            nextUrl = new URL(nextUrl, targetUrl).href;
                        }
                        currentUrl = nextUrl;
                        step(nextUrl);
                    } else {
                        resolve(targetUrl);
                    }
                });
                req.on("error", () => resolve(currentUrl));
                req.on("timeout", () => { req.destroy(); resolve(currentUrl); });
                req.end();
            } catch (e) {
                resolve(currentUrl);
            }
        }

        step(initialUrl);
    });
}

async function runRawHtmlTest() {
    console.log("Testing raw HTTP HTML fetching for WWR job detail pages...");

    const sampleUrls = [
        "https://weworkremotely.com/remote-jobs/brightorder-full-stack-developer-devops-cloud-systems",
        "https://weworkremotely.com/remote-jobs/sailpoint-manager-devops",
        "https://weworkremotely.com/remote-jobs/ppg-it-team-manager-devops-m-f-x",
        "https://weworkremotely.com/remote-jobs/qualifyze-senior-devops-engineer",
        "https://weworkremotely.com/remote-jobs/io-global-devops-engineer-midnight-foundation"
    ];

    for (const url of sampleUrls) {
        console.log(`\nFetching: ${url}`);
        const res = await fetchHtml(url);
        console.log(`  -> Status: ${res.status} | HTML length: ${res.data.length}`);

        // Search for apply CTA links
        const ctaMatches = res.data.match(/<a[^>]*href=["']([^"']*?)["'][^>]*>(?:Apply|Apply for this position|Apply Now)[\s\S]*?<\/a>/gi) || [];
        const allHrefMatches = res.data.match(/href=["'](\/job-apply\/[^"']*?|https?:\/\/[^"']*?apply[^"']*?)["']/gi) || [];

        console.log(`  -> CTA regex matches: ${ctaMatches.length}`);
        console.log(`  -> Href regex matches: ${allHrefMatches.length}`);

        if (allHrefMatches.length > 0) {
            const rawHref = allHrefMatches[0].replace(/href=["']/i, "").replace(/["']$/, "");
            let applyUrl = rawHref.startsWith("/") ? "https://weworkremotely.com" + rawHref : rawHref;
            console.log(`  -> Found Apply URL: ${applyUrl}`);

            const finalDestination = await followRedirects(applyUrl);
            const atsClass = ExternalApplicationRouter.classifyATS(finalDestination);
            console.log(`  -> Final Destination: ${finalDestination}`);
            console.log(`  -> Classified ATS: ${atsClass}`);
        }
    }
}

runRawHtmlTest().catch(console.error);
