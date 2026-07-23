const path = require("path");
require("dotenv").config({
    path: path.join(__dirname, "../../.env")
});

const getEnvBool = (key, fallback) => {
    if (process.env[key] === undefined) return fallback;
    return process.env[key].toLowerCase() === "true";
};

const getEnvInt = (key, fallback) => {
    if (process.env[key] === undefined) return fallback;
    const parsed = parseInt(process.env[key], 10);
    return isNaN(parsed) ? fallback : parsed;
};

module.exports = {
    env: process.env.NODE_ENV || "development",
    
    browser: {
        headless: getEnvBool("BROWSER_HEADLESS", true),
        timeout: getEnvInt("BROWSER_TIMEOUT", 60000),
        viewport: {
            width: 1440,
            height: 900
        },
        args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--no-sandbox"
        ]
    },

    retries: getEnvInt("RETRIES", 3),
    screenshotsEnabled: getEnvBool("SCREENSHOTS_ENABLED", true),

    telegram: {
        botToken: process.env.TELEGRAM_BOT_TOKEN || "",
        chatId: process.env.TELEGRAM_CHAT_ID || ""
    },

    ai: {
        openRouterKey: process.env.OPENROUTER_API_KEY || "",
        model: process.env.OPENROUTER_MODEL || "google/gemini-2.5-flash" // Recommended fast default model
    },

    search: {
        keywords: (process.env.SEARCH_KEYWORDS || "DevOps Engineer, Cloud Engineer, Platform Engineer, Site Reliability Engineer, Infrastructure Engineer").split(",").map(s => s.trim()),
        locations: (process.env.SEARCH_LOCATIONS || "Bangalore, Hyderabad, Chennai, Kochi, Trivandrum, Remote").split(",").map(s => s.trim()),
        minExperience: getEnvInt("MIN_EXPERIENCE", 2),
        maxExperience: getEnvInt("MAX_EXPERIENCE", 5),
        maxJobAgeDays: getEnvInt("MAX_JOB_AGE_DAYS", 7),
        maxApplicationsPerRun: getEnvInt("MAX_APPLICATIONS_PER_RUN", 5),
        maxApplicationsPerPortal: getEnvInt("MAX_APPLICATIONS_PER_PORTAL", 5),
        dryRun: getEnvBool("DRY_RUN", true),
        allowLiveApplications: getEnvBool("ALLOW_LIVE_APPLICATIONS", false)
    },

    portals: {
        naukri: {
            url: "https://www.naukri.com",
            email: process.env.NAUKRI_EMAIL || "",
            password: process.env.NAUKRI_PASSWORD || "",
            scheduleUpdate: "0 9,14 * * *", // 9:00 AM and 2:00 PM
            scheduleApply: "5 9,14 * * *"   // 9:05 AM and 2:05 PM
        },
        linkedin: {
            url: "https://www.linkedin.com",
            email: process.env.LINKEDIN_EMAIL || "",
            password: process.env.LINKEDIN_PASSWORD || "",
            scheduleApply: "30 10 * * *"   // 10:30 AM
        },
        foundit: {
            url: "https://www.foundit.in",
            email: process.env.FOUNDIT_EMAIL || process.env.NAUKRI_EMAIL || "",
            password: process.env.FOUNDIT_PASSWORD || process.env.NAUKRI_PASSWORD || ""
        },
        hirist: {
            url: "https://www.hirist.tech",
            email: process.env.HIRIST_EMAIL || process.env.NAUKRI_EMAIL || "",
            password: process.env.HIRIST_PASSWORD || process.env.NAUKRI_PASSWORD || ""
        },
        instahyre: {
            url: "https://www.instahyre.com",
            email: process.env.INSTAHYRE_EMAIL || process.env.NAUKRI_EMAIL || "",
            password: process.env.INSTAHYRE_PASSWORD || process.env.NAUKRI_PASSWORD || ""
        },
        wellfound: {
            url: "https://wellfound.com",
            email: process.env.WELLFOUND_EMAIL || process.env.NAUKRI_EMAIL || "",
            password: process.env.WELLFOUND_PASSWORD || process.env.NAUKRI_PASSWORD || ""
        },
        remoteok: {
            url: "https://remoteok.com"
        },
        weworkremotely: {
            url: "https://weworkremotely.com"
        }
    }
};
