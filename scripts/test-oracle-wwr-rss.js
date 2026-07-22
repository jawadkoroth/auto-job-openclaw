const https = require("https");
const ExternalApplicationRouter = require("../packages/router/ExternalApplicationRouter");

function fetchRss() {
    return new Promise((resolve, reject) => {
        https.get("https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss", {
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
        }, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

async function runRssTest() {
    console.log("Fetching WWR RSS Feed directly...");
    const xml = await fetchRss();
    console.log(`Received ${xml.length} bytes of RSS XML.`);

    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
    console.log(`Found ${itemMatches.length} RSS items.\n`);

    for (const item of itemMatches.slice(0, 10)) {
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || item.match(/<title>(.*?)<\/title>/i);
        const linkMatch = item.match(/<link>(.*?)<\/link>/i);
        const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || item.match(/<description>([\s\S]*?)<\/description>/i);

        const title = titleMatch ? titleMatch[1] : "Unknown Title";
        const url = linkMatch ? linkMatch[1] : "";
        const descHtml = descMatch ? descMatch[1] : "";

        // Extract any external ATS links from description HTML
        const hrefMatches = descHtml.match(/href=["'](https?:\/\/.*?)["']/gi) || [];
        const externalLinks = hrefMatches.map(h => h.replace(/href=["']/i, "").replace(/["']$/, "")).filter(l => !l.includes("weworkremotely.com"));

        let ats = "GENERIC_EXTERNAL";
        let bestUrl = url;

        for (const extUrl of externalLinks) {
            const detected = ExternalApplicationRouter.classifyATS(extUrl);
            if (detected !== "Unknown" && detected !== "Generic Company Career Page") {
                ats = detected;
                bestUrl = extUrl;
                break;
            }
        }

        console.log(`[RSS JOB] "${title}"`);
        console.log(`  -> WWR Link: ${url}`);
        console.log(`  -> External Links Found: ${externalLinks.length} (${externalLinks.slice(0, 2).join(", ")})`);
        console.log(`  -> Classified ATS: ${ats} (Best URL: ${bestUrl})\n`);
    }
}

runRssTest().catch(console.error);
