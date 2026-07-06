const winston = require("winston");
const path = require("path");
const fs = require("fs");

const logDir = path.join(process.cwd(), "logs");
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
}

// Structured custom logger format
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || "info",
    format: winston.format.combine(
        winston.format.timestamp({
            format: "YYYY-MM-DD HH:mm:ss"
        }),
        winston.format.metadata({ fillExcept: ["message", "level", "timestamp"] })
    ),
    transports: [
        // 1. Console Transport (Colored and human readable)
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.printf((info) => {
                    const { timestamp, level, message, metadata } = info;
                    const { plugin, action, duration, success } = metadata || {};
                    let prefix = `[${timestamp}] ${level}`;
                    if (plugin) prefix += ` [${plugin}]`;
                    if (action) prefix += ` [${action}]`;
                    
                    let suffix = "";
                    if (duration !== undefined) suffix += ` (${duration}ms)`;
                    if (success !== undefined) suffix += ` [Success: ${success}]`;
                    
                    return `${prefix}: ${message}${suffix}`;
                })
            )
        }),
        // 2. File Transport (Plain text structured log for diagnostics)
        new winston.transports.File({
            filename: path.join(logDir, "automation.log"),
            format: winston.format.combine(
                winston.format.printf((info) => {
                    const { timestamp, level, message, metadata } = info;
                    const { plugin, action, duration, success } = metadata || {};
                    let prefix = `[${timestamp}] ${level.toUpperCase()}`;
                    if (plugin) prefix += ` [${plugin}]`;
                    if (action) prefix += ` [${action}]`;
                    
                    let suffix = "";
                    if (duration !== undefined) suffix += ` | duration=${duration}ms`;
                    if (success !== undefined) suffix += ` | success=${success}`;
                    
                    return `${prefix} : ${message}${suffix}`;
                })
            )
        }),
        // 3. File Transport (JSON structured log for analytics or log forwarding)
        new winston.transports.File({
            filename: path.join(logDir, "automation.json"),
            format: winston.format.json()
        })
    ]
});

module.exports = logger;
