const profileManager = require("../../profile/ProfileManager");
const resumeManager = require("../../resume/ResumeManager");

module.exports = async function updateProfile(plugin, page) {
    const { logger } = plugin;
    logger.info("Hirist profile update sequence initiated.");

    const isLoggedIn = await plugin.health(page);
    if (!isLoggedIn) {
        const loginSuccess = await plugin.login(page);
        if (!loginSuccess) {
            throw new Error("Cannot execute profile update without valid authentication.");
        }
    }

    logger.info("Navigating to profile edit page...");
    await page.goto("https://www.hirist.tech/profile.html", { waitUntil: "networkidle", timeout: 30000 }).catch(() => {});

    const resumePath = await resumeManager.getResumePath(plugin.name).catch(() => null);
    if (resumePath) {
        logger.info(`Uploading resume file to Hirist from: ${resumePath}`);
        try {
            const fileInputSelector = "input[type='file']";
            await page.waitForSelector(fileInputSelector, { timeout: 15000 });
            await page.setInputFiles(fileInputSelector, resumePath);
            logger.info("Resume file submitted.");
            await page.waitForTimeout(4000);
            logger.info("Resume upload succeeded.");
        } catch (uploadErr) {
            logger.warn(`Resume upload failed: ${uploadErr.message}. Continuing execution.`);
        }
    }

    return true;
};
