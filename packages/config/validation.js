const config = require("./index");
const contextManager = require("../browser/ContextManager");
const logger = require("../logger");

/**
 * Validate configuration and session status for a single portal.
 * @param {string} portalName 
 * @returns {Promise<{ status: string, missingVars?: string[], requiredMessage?: string, reason?: string }>}
 */
async function validatePortalConfig(portalName) {
    const portal = portalName.toLowerCase();
    
    // Naukri must remain completely disabled.
    if (portal === "naukri") {
        return { status: "SKIPPED", reason: "Naukri is disabled." };
    }
    
    // Check if portal is enabled via environment variables
    const envKey = `ENABLE_${portal.toUpperCase()}`;
    let envVal = process.env[envKey];
    if (portal === "weworkremotely" && envVal === undefined) {
        envVal = process.env.ENABLE_WWR;
    }
    
    // Naukri is hard disabled, others default to enabled unless explicitly false
    if (envVal !== undefined && envVal.toLowerCase() !== "true") {
        return { status: "SKIPPED", reason: `${portalName} is disabled by configuration.` };
    }
    
    const authRequiredPortals = ["naukri", "linkedin", "foundit", "hirist", "instahyre", "wellfound"];
    const requiresAuth = authRequiredPortals.includes(portal);
    
    if (!requiresAuth) {
        return { status: "PASS" };
    }
    
    let email = "";
    let password = "";
    
    if (portal === "wellfound") {
        email = process.env.WELLFOUND_EMAIL || "";
        password = process.env.WELLFOUND_PASSWORD || "";
    } else if (portal === "foundit") {
        email = process.env.FOUNDIT_EMAIL || "";
        password = process.env.FOUNDIT_PASSWORD || "";
    } else if (portal === "instahyre") {
        email = process.env.INSTAHYRE_EMAIL || "";
        password = process.env.INSTAHYRE_PASSWORD || "";
    } else if (portal === "hirist") {
        email = process.env.HIRIST_EMAIL || process.env.NAUKRI_EMAIL || "";
        password = process.env.HIRIST_PASSWORD || process.env.NAUKRI_PASSWORD || "";
    } else if (portal === "linkedin") {
        email = process.env.LINKEDIN_EMAIL || "";
        password = process.env.LINKEDIN_PASSWORD || "";
    }
    
    const missingVars = [];
    if (!email) missingVars.push(`${portal.toUpperCase()}_EMAIL`);
    if (!password) missingVars.push(`${portal.toUpperCase()}_PASSWORD`);
    
    // For Wellfound, persistent session can bypass missing credentials
    if (portal === "wellfound" && missingVars.length > 0) {
        const metadata = await contextManager.getMetadata("wellfound");
        if (metadata && metadata.sessionHealth === "healthy") {
            return { status: "PASS" };
        }
    }
    
    if (missingVars.length > 0) {
        let requiredMsg = missingVars.join(" / ");
        if (portal === "wellfound") {
            requiredMsg += " or persistent authenticated session";
        }
        return {
            status: "CONFIG_REQUIRED",
            missingVars,
            requiredMessage: requiredMsg
        };
    }
    
    // Check if session is marked as auth_required (expired/failed login)
    const metadata = await contextManager.getMetadata(portal);
    if (metadata && metadata.sessionHealth === "auth_required") {
        return { 
            status: "AUTH_REQUIRED", 
            reason: "Persistent authenticated session has expired and requires manual re-login." 
        };
    }
    
    return { status: "PASS" };
}

/**
 * Validate all portals and log warnings/statuses.
 * @returns {Promise<Record<string, { status: string, reason?: string, requiredMessage?: string }>>}
 */
async function validateAllPortals() {
    const results = {};
    const allPortals = ["naukri", "linkedin", "foundit", "hirist", "instahyre", "wellfound", "remoteok", "weworkremotely", "cutshort"];
    
    for (const portal of allPortals) {
        const res = await validatePortalConfig(portal);
        results[portal] = res;
        
        if (res.status === "CONFIG_REQUIRED") {
            logger.automation.info(`[${portal}] CONFIG_REQUIRED: Missing authentication configuration.`);
            logger.automation.info(`Required: ${res.requiredMessage}`);
        } else if (res.status === "AUTH_REQUIRED") {
            logger.automation.info(`[${portal}] AUTH_REQUIRED: Session expired or invalid.`);
        }
    }
    
    return results;
}

module.exports = {
    validatePortalConfig,
    validateAllPortals
};
