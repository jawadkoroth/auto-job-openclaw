const logger = require("../packages/logger");

logger.info("Verifying standard text logger output.");
logger.warn("Warning level test log.");
logger.error("Error level test log.");

// Test structured logging fields
logger.info("Executing mock application cycle.", {
    plugin: "naukri",
    action: "apply",
    duration: 1250,
    success: true
});

logger.info("Structured Logger check complete.");
process.exit(0);
