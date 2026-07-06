/**
 * Naukri Profile Update Automation script
 * @param {import("./index")} plugin 
 */
module.exports = async function updateProfile(plugin) {
    const { browserManager, logger, config } = plugin;
    logger.info("Naukri profile update sequence initiated.", { plugin: "naukri", action: "update_profile" });
    
    const page = await browserManager.newPage();
    
    // Ensure we are logged in
    const isLoggedIn = await plugin.login();
    if (!isLoggedIn) {
        throw new Error("Cannot execute profile update without valid authentication.");
    }
    
    await page.goto("https://www.naukri.com/mnj/profile", { waitUntil: "networkidle", timeout: 30000 });
    
    logger.info("Accessing Naukri profile details page.", { plugin: "naukri", action: "update_profile" });
    
    // Edit the Resume Headline to trigger a profile timestamp refresh
    const headlineEditBtn = ".resumeHeadlineVal .icon, .resumeHeadlineVal + span.edit, div:has-text('Resume Headline') + span.edit";
    
    const count = await page.locator(headlineEditBtn).count();
    if (count > 0) {
        await page.click(headlineEditBtn);
        
        const headlineField = "#resumeHeadlineTxt";
        await page.waitForSelector(headlineField, { timeout: 10000 });
        let text = await page.inputValue(headlineField);
        
        // Minor change to force update detection (toggle dot)
        if (text.endsWith(".")) {
            text = text.substring(0, text.length - 1);
        } else {
            text = text + ".";
        }
        
        await page.fill(headlineField, text);
        
        // Save changes
        const saveBtn = "button.btn-light-blue, button:has-text('Save')";
        await page.click(saveBtn);
        
        logger.info("Resume headline modified and saved.", { plugin: "naukri", action: "update_profile", success: true });
        
        // Brief timeout to ensure API persistence settles
        await page.waitForTimeout(3000);
        return true;
    } else {
        logger.warn("Resume Headline edit control not found. Attempting fallback dashboard check...", { plugin: "naukri", action: "update_profile" });
        await browserManager.takeScreenshot(page, "naukri_profile_edit_not_found");
        return false;
    }
};
