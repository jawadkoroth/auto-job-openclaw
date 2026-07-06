const path = require("path");
const fs = require("fs");

const SCREENSHOT_DIR = path.join(__dirname, "../../screenshots");

if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function capture(page, name) {

    const filename = `${Date.now()}-${name}.png`;

    const fullPath = path.join(SCREENSHOT_DIR, filename);

    await page.screenshot({
        path: fullPath,
        fullPage: true
    });

    return fullPath;
}

module.exports = {
    capture
};
