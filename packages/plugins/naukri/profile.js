const profileManager = require("../../profile/ProfileManager");

/**
 * Naukri Profile Update Automation script
 * @param {import("./index")} plugin 
 * @param {import("playwright").Page} page 
 */
module.exports = async function updateProfile(plugin, page) {
    const { logger } = plugin;
    logger.info("Naukri profile update sequence initiated.");
    
    // Ensure we are logged in
    const isLoggedIn = await plugin.login(page);
    if (!isLoggedIn) {
        throw new Error("Cannot execute profile update without valid authentication.");
    }
    
    await page.goto("https://www.naukri.com/mnj/profile", { waitUntil: "networkidle", timeout: 30000 });
    
    logger.info("Accessing Naukri profile details page.");
    
    // Retrieve single-source-of-truth profile data
    const profileData = await profileManager.getProfile();
    let targetHeadline = profileData.headline;
    
    const headlineEditBtn = ".resumeHeadlineVal .icon, .resumeHeadlineVal + span.edit, div:has-text('Resume Headline') + span.edit";
    
    const count = await page.locator(headlineEditBtn).count();
    if (count > 0) {
        await page.click(headlineEditBtn);
        
        const headlineField = "#resumeHeadlineTxt";
        await page.waitForSelector(headlineField, { timeout: 10000 });
        let currentText = await page.inputValue(headlineField);
        
        // Toggle terminal dot to force portal state updates if identical
        if (currentText.trim() === targetHeadline.trim()) {
            if (targetHeadline.endsWith(".")) {
                targetHeadline = targetHeadline.substring(0, targetHeadline.length - 1);
            } else {
                targetHeadline = targetHeadline + ".";
            }
        }
        
        await page.fill(headlineField, targetHeadline);
        
        // Save changes
        const saveBtn = "button.btn-light-blue, button:has-text('Save')";
        await page.click(saveBtn);
        
        logger.info("Resume headline updated successfully via ProfileManager.");
        await page.waitForTimeout(3000);
        return true;
    } else {
        logger.warn("Resume Headline edit control not found.");
        return false;
    }
};
