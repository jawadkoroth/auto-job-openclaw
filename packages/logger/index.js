const winston = require("winston");
const path = require("path");
const fs = require("fs-extra");

const logDir = path.join(process.cwd(), "logs");
fs.ensureDirSync(logDir);
fs.ensureDirSync(path.join(logDir, "plugins"));

// Standard printf format
const formatTemplate = winston.format.printf(({ timestamp, level, message, metadata }) => {
    let metaStr = "";
    if (metadata && Object.keys(metadata).length) {
        metaStr = ` | metadata=${JSON.stringify(metadata)}`;
    }
    return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
});

const commonFormat = winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.metadata({ fillExcept: ["message", "level", "timestamp"] }),
    formatTemplate
);

/**
 * Helper to build custom category loggers
 * @param {string} fileName 
 */
function createCategoryLogger(fileName) {
    return winston.createLogger({
        level: process.env.LOG_LEVEL || "info",
        format: commonFormat,
        transports: [
            new winston.transports.Console({
                format: winston.format.combine(
                    winston.format.colorize(),
                    formatTemplate
                )
            }),
            new winston.transports.File({
                filename: path.join(logDir, fileName)
            })
        ]
    });
}

// Instantiate specific service channels
const loggers = {
    automation: createCategoryLogger("automation.log"),
    browser: createCategoryLogger("browser.log"),
    scheduler: createCategoryLogger("scheduler.log"),
    telegram: createCategoryLogger("telegram.log"),
    worker: createCategoryLogger("worker.log")
};

// Dynamic caching for plugin-level category logs
const pluginLoggers = new Map();

module.exports = {
    automation: loggers.automation,
    browser: loggers.browser,
    scheduler: loggers.scheduler,
    telegram: loggers.telegram,
    worker: loggers.worker,

    /**
     * Get or create a portal plugin specific logger
     * @param {string} portal 
     */
    plugin(portal) {
        const norm = portal.toLowerCase();
        if (!pluginLoggers.has(norm)) {
            pluginLoggers.set(norm, createCategoryLogger(`plugins/${norm}.log`));
        }
        return pluginLoggers.get(norm);
    },

    /**
     * Write an update to the system metrics JSON log
     * @param {Object} metric 
     */
    async logMetric(metric) {
        const metricsPath = path.join(logDir, "metrics.json");
        const record = {
            timestamp: new Date().toISOString(),
            ...metric
        };
        try {
            let data = [];
            if (fs.existsSync(metricsPath)) {
                const content = await fs.readFile(metricsPath, "utf-8");
                try {
                    data = JSON.parse(content);
                } catch (e) {
                    data = [];
                }
            }
            data.push(record);
            // Limit JSON log size to last 500 records
            if (data.length > 500) data.shift();
            await fs.writeJson(metricsPath, data, { spaces: 2 });
        } catch (e) {
            loggers.automation.error(`Failed logging system metric: ${e.message}`);
        }
    }
};
