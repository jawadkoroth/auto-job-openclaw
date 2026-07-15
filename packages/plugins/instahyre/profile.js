const profileManager = require("../../profile/ProfileManager");
const resumeManager = require("../../resume/ResumeManager");

module.exports = async function updateProfile(plugin, page) {
    const { logger } = plugin;
    logger.info("Instahyre profile update sequence initiated.");

    const isLoggedIn = await plugin.health(page);
    if (!isLoggedIn) {
        const loginSuccess = await plugin.login(page);
        if (!loginSuccess) {
            throw new Error("Cannot execute profile update without valid authentication.");
        }
    }

    logger.info("Navigating to profile edit page...");
    await page.goto("https://www.instahyre.com/candidate/profile/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2000);

    const resumePath = await resumeManager.getResumePath(plugin.name).catch(() => null);
    if (resumePath) {
        logger.info(`Uploading resume file to Instahyre from: ${resumePath}`);
        const fileInputSelector = "input[type='file']";
        await page.waitForSelector(fileInputSelector, { timeout: 15000 });
        await page.setInputFiles(fileInputSelector, resumePath);
        logger.info("Resume file submitted.");
        await page.waitForTimeout(4000);
    }

    return true;
};
