const fs = require("fs-extra");
const path = require("path");
const logger = require("../../logger").plugin("naukri");

class NaukriDiagnostics {
    static async persist(page, res, label = "FAILURE", classificationOverride = null) {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const finalUrl = page ? page.url() : "N/A";
            const title = page ? await page.title().catch(() => "N/A") : "N/A";
            const httpStatus = (res && typeof res.status === "function") ? res.status() : "N/A";
            const readyState = page ? await page.evaluate(() => document.readyState).catch(() => "N/A") : "N/A";
            const bodyText = page ? await page.evaluate(() => document.body ? document.body.innerText.slice(0, 1000) : "").catch(() => "") : "";
            const fullHtml = page ? await page.content().catch(() => "") : "";

            let classification = classificationOverride;
            if (!classification) {
                const isAkamaiBlocked = httpStatus === 403 || title.toLowerCase().includes("access denied") || bodyText.toLowerCase().includes("access denied");
                const isLoginPage = finalUrl.includes("/nlogin/") || finalUrl.includes("/login") || bodyText.toLowerCase().includes("login to your account");
                const isAuthenticated = finalUrl.includes("/mnjuser/") || bodyText.toLowerCase().includes("user dashboard") || bodyText.toLowerCase().includes("resume headline");

                if (isAkamaiBlocked) classification = "AKAMAI_TEMPORARY_BLOCK";
                else if (isLoginPage) classification = "SESSION_EXPIRED";
                else if (!isAuthenticated) classification = "WRONG_PAGE";
                else classification = "UNKNOWN_FAILURE";
            }

            const diagDir = path.join(process.cwd(), "logs", "naukri", `${timestamp}_${classification}`);
            fs.mkdirpSync(diagDir);

            if (page) {
                await page.screenshot({ path: path.join(diagDir, "screenshot.png"), fullPage: true }).catch(() => {});
            }
            if (fullHtml) {
                // Redact sensitive patterns from HTML snapshot
                const sanitizedHtml = fullHtml
                    .replace(/("authorization"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"')
                    .replace(/("bearer\s+)[^"]+"/gi, '$1[REDACTED]"');
                fs.writeFileSync(path.join(diagDir, "snapshot.html"), sanitizedHtml);
            }

            const summaryText = `
==================================================
NAUKRI HARDENED DIAGNOSTIC REPORT
Timestamp:      ${timestamp}
Label:          ${label}
Classification: ${classification}
==================================================
Final URL:             ${finalUrl}
Page Title:            ${title}
HTTP Response Status:  ${httpStatus}
document.readyState:   ${readyState}

Body Text (First 1000 Chars Sanitized):
--------------------------------------------------
${bodyText.replace(/\r\n|\r/g, "\n")}
`;
            fs.writeFileSync(path.join(diagDir, "summary.txt"), summaryText.trim());

            logger.info(`[Diagnostics] Persisted under: logs/naukri/${timestamp}_${classification}`);

            // Bound retention: keep last 30 diagnostic folders
            this.pruneOldLogs();

            return classification;
        } catch (err) {
            logger.error(`[Diagnostics] Error persisting diagnostics: ${err.message}`);
            return "UNKNOWN_FAILURE";
        }
    }

    static pruneOldLogs() {
        try {
            const logsBase = path.join(process.cwd(), "logs", "naukri");
            if (!fs.existsSync(logsBase)) return;

            const entries = fs.readdirSync(logsBase, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => ({ name: d.name, path: path.join(logsBase, d.name), mtime: fs.statSync(path.join(logsBase, d.name)).mtimeMs }))
                .sort((a, b) => b.mtime - a.mtime);

            if (entries.length > 30) {
                const toRemove = entries.slice(30);
                for (const item of toRemove) {
                    fs.removeSync(item.path);
                }
            }
        } catch (err) {}
    }
}

module.exports = NaukriDiagnostics;
