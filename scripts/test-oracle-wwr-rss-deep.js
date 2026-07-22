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

async function runDeepRssDiagnostic() {
    const xml = await fetchRss();
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];

    console.log(`Processing ${itemMatches.length} RSS items...\n`);

    for (let i = 0; i < itemMatches.length; i++) {
        const item = itemMatches[i];
        const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || item.match(/<title>(.*?)<\/title>/i);
        const linkMatch = item.match(/<link>(.*?)<\/link>/i);
        const descMatch = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || item.match(/<description>([\s\S]*?)<\/description>/i);

        const title = titleMatch ? titleMatch[1] : "Unknown Title";
        const wwrUrl = linkMatch ? linkMatch[1] : "";
        const descHtml = descMatch ? descMatch[1] : "";

        // Extract all URLs inside CDATA description
        const urls = (descHtml.match(/href=["'](https?:\/\/.*?)["']/gi) || [])
            .map(h => h.replace(/href=["']/i, "").replace(/["']$/, ""))
            .filter(u => !u.includes("weworkremotely.com"));

        const atsClasses = urls.map(u => ({ url: u, ats: ExternalApplicationRouter.classifyATS(u) }));

        console.log(`[#${i + 1}] "${title}"`);
        console.log(`  WWR URL: ${wwrUrl}`);
        console.log(`  External Links (${urls.length}):`, atsClasses);
        console.log("");
    }
}

runDeepRssDiagnostic().catch(console.error);
