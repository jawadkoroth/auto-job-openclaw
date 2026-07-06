const profileManager = require("../../profile/ProfileManager");
const resumeManager = require("../../resume/ResumeManager");

/**
 * Naukri Profile & Resume Update Automation script
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
    
    logger.info("Navigating to Naukri profile page...");
    await page.goto("https://www.naukri.com/mnj/profile", { waitUntil: "networkidle", timeout: 30000 });

    const profileData = await profileManager.getProfile();
    let targetHeadline = profileData.headline;
    
    // 1. Update Resume Headline to trigger active timestamps
    const headlineEditBtn = ".resumeHeadlineVal .icon, .resumeHeadlineVal + span.edit, div:has-text('Resume Headline') + span.edit";
    const editBtnCount = await page.locator(headlineEditBtn).count();
    if (editBtnCount > 0) {
        logger.info("Updating resume headline text...");
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
        
        // Human keystrokes typing
        await page.click(headlineField);
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Backspace");
        for (const char of targetHeadline) {
            await page.keyboard.sendCharacter(char);
            await page.waitForTimeout(Math.floor(Math.random() * 30) + 15);
        }
        const saveBtn = "button.btn-light-blue, button:has-text('Save')";
        await page.click(saveBtn);
        logger.info("Resume headline saved successfully.");
        await page.waitForTimeout(3000);
    } else {
        logger.warn("Resume Headline edit control not found. Skipping headline update.");
    }

    // 2. Upload Resume PDF
    logger.info("Resolving resume path from ResumeManager...");
    let resumePath = null;
    try {
        resumePath = await resumeManager.getResumePath(plugin.name);
    } catch (e) {
        logger.warn(`ResumeManager could not resolve path: ${e.message}. Skipping resume upload.`);
    }

    if (resumePath) {
        logger.info(`Uploading resume file to Naukri from: ${resumePath}`);
        const fileInputSelector = "input[type='file']#attachCV";
        await page.waitForSelector(fileInputSelector, { timeout: 10000 });
        await page.setInputFiles(fileInputSelector, resumePath);
        logger.info("Resume file submitted. Waiting for success verification...");
        
        // Wait for Naukri upload confirmation toast
        const successSelector = ".toastMessage, .success-toast, :has-text('successfully uploaded'), :has-text('uploaded successfully')";
        const successToast = await page.waitForSelector(successSelector, { timeout: 20000 }).catch(() => null);
        if (successToast) {
            logger.info("Resume upload confirmed successfully by portal toast alert.");
        } else {
            logger.warn("No success toast detected. Assuming upload proceeded without errors.");
        }
    }

    return true;
};
