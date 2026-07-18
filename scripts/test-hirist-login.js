const BrowserInstance = require("../packages/browser/BrowserInstance");
const pluginManager = require("../packages/plugins/PluginManager");
const fs = require("fs-extra");
const path = require("path");

(async () => {
    const portal = "hirist";
    console.log(`Starting ${portal} login test...`);
    const browserInstance = new BrowserInstance(portal);
    
    let isAuthed = false;
    let isExported = "NO";
    let cookiesCount = 0;
    let originsCount = 0;

    try {
        await browserInstance.launch();
        const page = await browserInstance.newPage();

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            // Install network debug listeners (Requirement 1)
            page.on("requestfailed", (request) => {
                const url = request.url();
                let safeUrl = url.replace(/(password|token|email|auth|key|secret)=[^&]+/gi, "$1=[REDACTED]");
                
                console.log("\n[HIRIST AUTH DEBUG - REQUEST FAILED]");
                console.log(`Request URL: ${safeUrl}`);
                console.log(`Method: ${request.method()}`);
                console.log(`Resource Type: ${request.resourceType()}`);
                console.log(`Failure Reason: ${request.failure() ? request.failure().errorText : "Unknown"}`);
                console.log("=====================================\n");
            });

            page.on("response", async (response) => {
                const status = response.status();
                if (status >= 400) {
                    const url = response.url();
                    let safeUrl = url.replace(/(password|token|email|auth|key|secret)=[^&]+/gi, "$1=[REDACTED]");
                    const request = response.request();
                    
                    console.log("\n[HIRIST AUTH DEBUG - RESPONSE ERROR]");
                    console.log(`Request URL: ${safeUrl}`);
                    console.log(`Method: ${request.method()}`);
                    console.log(`Resource Type: ${request.resourceType()}`);
                    console.log(`HTTP Status: ${status}`);
                    
                    try {
                        const text = await response.text();
                        let safeBody = text;
                        // Redact any possible passwords or tokens in response
                        safeBody = safeBody.replace(/"(password|token|email|auth|key|secret)":\s*"[^"]+"/gi, '"$1": "[REDACTED]"');
                        console.log(`Response Body: ${safeBody.substring(0, 1000)}`);
                    } catch (e) {
                        console.log(`Response Body: (Not readable: ${e.message})`);
                    }
                    console.log("=====================================\n");
                }
            });

            // Log XHR/Fetch requests to identify login endpoint (Requirement 2)
            page.on("request", (request) => {
                const url = request.url();
                const type = request.resourceType();
                if (type === "fetch" || type === "xhr") {
                    let safeUrl = url.replace(/(password|token|email|auth|key|secret)=[^&]+/gi, "$1=[REDACTED]");
                    console.log(`[HIRIST API REQUEST] ${request.method()} -> ${safeUrl} (${type})`);
                }
            });

            page.on("response", (response) => {
                const request = response.request();
                const type = request.resourceType();
                if (type === "fetch" || type === "xhr") {
                    const url = response.url();
                    let safeUrl = url.replace(/(password|token|email|auth|key|secret)=[^&]+/gi, "$1=[REDACTED]");
                    console.log(`[HIRIST API RESPONSE] ${response.status()} -> ${safeUrl}`);
                }
            });
        }

        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);
        const success = await plugin.login(page);
        
        if (success) {
            isAuthed = true;
            
            // Explicitly export storageState.json
            const storageStatePath = path.join(process.cwd(), "sessions", portal, "storageState.json");
            await page.context().storageState({ path: storageStatePath });
            
            if (fs.existsSync(storageStatePath)) {
                isExported = "YES";
                const state = fs.readJsonSync(storageStatePath);
                cookiesCount = state.cookies ? state.cookies.length : 0;
                originsCount = state.origins ? state.origins.length : 0;
            }
        }
    } catch (e) {
        console.error("FAILED:", e.message);
        if (e.message === "LOGIN_TIMEOUT") {
            isAuthed = "LOGIN_TIMEOUT";
        }
    } finally {
        await browserInstance.close();
    }

    console.log("\n==================================================");
    console.log("HIRIST LOCAL AUTH BOOTSTRAP");
    console.log("==================================================");
    console.log(`Authentication: ${isAuthed === true ? "AUTHENTICATED" : (isAuthed === "LOGIN_TIMEOUT" ? "LOGIN_TIMEOUT" : "FAILED")}`);
    console.log(`StorageState Exported: ${isExported}`);
    console.log(`Cookies Exported: ${cookiesCount}`);
    console.log(`Origins Exported: ${originsCount}`);
    console.log("==================================================\n");
})();
