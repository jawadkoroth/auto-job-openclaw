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
    let page;

    try {
        await browserInstance.launch();
        page = await browserInstance.newPage();

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            const isRelevantUrl = (url) => {
                try {
                    const host = new URL(url).hostname;
                    return host.includes("hirist.com") || host.includes("hirist.tech");
                } catch (e) {
                    return false;
                }
            };

            const sanitizeHeaders = (headers) => {
                const sanitized = {};
                for (const [key, value] of Object.entries(headers)) {
                    if (/auth|cookie|token|password|credential|secret|key/i.test(key)) {
                        sanitized[key] = "[REDACTED]";
                    } else {
                        sanitized[key] = value;
                    }
                }
                return sanitized;
            };

            const redactBody = (bodyText) => {
                if (!bodyText) return "";
                let result = bodyText.replace(/"(password|token|email|auth|key|secret)":\s*"[^"]+"/gi, '"$1": "[REDACTED]"');
                result = result.replace(/(password|token|email|auth|key|secret)=[^&]+/gi, "$1=[REDACTED]");
                return result;
            };

            // Track whether the login request has been sent and responded
            let loginRequestSent = false;
            let loginResponseReceived = false;

            page.on("request", (request) => {
                const url = request.url();
                if (!isRelevantUrl(url)) return;

                const isLogin = url.includes("user-api.hirist.com/v2/auth/login") && request.method() === "POST";
                if (isLogin) {
                    loginRequestSent = true;
                    console.log("\n==================================================");
                    console.log("[HIRIST LOGIN REQUEST DETECTED]");
                    console.log(`1. Request Sent: YES`);
                    console.log(`2. Method: ${request.method()}`);
                    console.log(`3. Sanitized Request Headers:`, JSON.stringify(sanitizeHeaders(request.headers()), null, 2));
                    console.log("==================================================\n");
                } else {
                    console.log(`[HIRIST REQUEST] ${request.method()} -> ${url}`);
                }
            });

            page.on("response", async (response) => {
                const url = response.url();
                if (!isRelevantUrl(url)) return;

                const request = response.request();
                const isLogin = url.includes("user-api.hirist.com/v2/auth/login") && request.method() === "POST";

                if (isLogin) {
                    loginResponseReceived = true;
                    const status = response.status();
                    console.log("\n==================================================");
                    console.log("[HIRIST LOGIN RESPONSE RECEIVED]");
                    console.log(`4. Response Received: YES`);
                    console.log(`5. HTTP Status: ${status}`);
                    console.log(`6. Sanitized Response Headers:`, JSON.stringify(sanitizeHeaders(response.headers()), null, 2));
                    
                    try {
                        const body = await response.text();
                        console.log(`7. Sanitized Response Body: ${redactBody(body)}`);
                    } catch (e) {
                        console.log(`7. Sanitized Response Body: (Could not read: ${e.message})`);
                    }
                    console.log("==================================================\n");
                } else {
                    const status = response.status();
                    if (status >= 400) {
                        console.log(`[HIRIST RESPONSE ERROR] ${status} -> ${url}`);
                        try {
                            const body = await response.text();
                            console.log(`   Response Body: ${redactBody(body).substring(0, 500)}`);
                        } catch (e) {}
                    } else {
                        console.log(`[HIRIST RESPONSE] ${status} -> ${url}`);
                    }
                }
            });

            page.on("requestfailed", (request) => {
                const url = request.url();
                if (!isRelevantUrl(url)) return;

                const isLogin = url.includes("user-api.hirist.com/v2/auth/login") && request.method() === "POST";
                const failureReason = request.failure() ? request.failure().errorText : "Unknown";

                if (isLogin) {
                    console.log("\n==================================================");
                    console.log("[HIRIST LOGIN REQUEST FAILED]");
                    console.log(`8. Playwright Failure Reason: ${failureReason}`);
                    console.log("==================================================\n");
                } else {
                    console.log(`[HIRIST REQUEST FAILED] ${request.method()} -> ${url} | Reason: ${failureReason}`);
                }
            });

            page.on("console", (msg) => {
                const text = msg.text();
                // Check if message is an error or contains relevant terms
                if (msg.type() === "error" || /CORS|CSP|SSL|TLS|DNS|blocked|failed/i.test(text)) {
                    console.log(`[BROWSER CONSOLE ${msg.type().toUpperCase()}] ${text}`);
                }
            });

            page.on("pageerror", (err) => {
                console.log(`[PAGE UNCAUGHT ERROR] ${err.stack || err.message}`);
            });
        }

        pluginManager.loadPlugins();
        const plugin = pluginManager.getPlugin(portal);
        let success = false;

        if (process.env.HEADFUL_AUTH_SETUP === "true") {
            console.log("HEADFUL_AUTH_SETUP is true. Performing clean homepage setup to prevent React-crash/CORS block on profile.html...");
            console.log("Navigating to homepage: https://www.hirist.tech/");
            await page.goto("https://www.hirist.tech/", { waitUntil: "domcontentloaded", timeout: 45000 });
            await page.waitForTimeout(5000);

            if (await plugin.health(page)) {
                console.log("Existing authenticated session detected successfully!");
                success = true;
            } else {
                // Accept cookie consent if visible
                try {
                    const gotItCookieBtn = page.locator("button:has-text('Got it')").first();
                    if (await gotItCookieBtn.count() > 0 && await gotItCookieBtn.isVisible()) {
                        await gotItCookieBtn.click();
                        await page.waitForTimeout(1000);
                    }
                } catch (e) {
                    console.log(`Could not click cookie consent: ${e.message}`);
                }

                console.log("Opening login dropdown on homepage...");
                const loginBtn = page.locator('button:has-text("Login")').filter({ visible: true }).first();
                try {
                    await loginBtn.waitFor({ state: "visible", timeout: 25000 });
                    await loginBtn.click({ force: true });
                    await page.waitForTimeout(2000);
                } catch (e) {
                    console.log("Could not find or click Login button:", e.message);
                }

                console.log("Entering credentials into the login dialog...");
                try {
                    const emailInput = page.locator('input[placeholder="Enter your registered email id"]').first();
                    await emailInput.waitFor({ state: "visible", timeout: 15000 });
                    await emailInput.fill(plugin.config.portals.hirist.email);

                    const passwordInput = page.locator('input[placeholder="Enter your password"]').first();
                    await passwordInput.fill(plugin.config.portals.hirist.password);
                    console.log("Credentials prefilled successfully!");
                } catch (e) {
                    console.log("Failed to locate or fill email/password inputs:", e.message);
                }

                console.log("Login form setup completed. Please click the 'Login' button manually in the open headed browser window.");
                console.log("Waiting for manual login success (up to 10 minutes)...");
                for (let i = 0; i < 300; i++) {
                    await page.waitForTimeout(2000);
                    if (await plugin.health(page)) {
                        console.log("Manual Hirist login detected successfully!");
                        success = true;
                        break;
                    }
                }
            }
            if (!success) {
                throw new Error("LOGIN_TIMEOUT");
            }
        } else {
            success = await plugin.login(page);
        }

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
        if (process.env.HEADFUL_AUTH_SETUP === "true" && page) {
            try {
                console.log("\n==================================================");
                console.log("FINAL DIAGNOSTICS:");
                console.log(`11. Final Page URL: ${page.url()}`);
                
                // Attempt to extract any visible error message on the page
                const visibleErrors = await page.evaluate(() => {
                    const elements = Array.from(document.querySelectorAll("div, p, span, h1, h2, h3, h4, h5, h6, label"));
                    const errMsgs = [];
                    for (const el of elements) {
                        const text = el.innerText ? el.innerText.trim() : "";
                        if (text.length > 0 && text.length < 200) {
                            const lower = text.toLowerCase();
                            if (lower.includes("error") || lower.includes("invalid") || lower.includes("failed") || lower.includes("incorrect") || lower.includes("wrong")) {
                                const style = window.getComputedStyle(el);
                                if (style && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0") {
                                    errMsgs.push(text);
                                }
                            }
                        }
                    }
                    return Array.from(new Set(errMsgs));
                }).catch(() => []);
                
                console.log("Visible Error Messages on Page:", visibleErrors.length > 0 ? visibleErrors : "None detected");
                console.log("==================================================\n");
            } catch (diagErr) {
                console.error("Failed to extract final page diagnostics:", diagErr.message);
            }
        }
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
