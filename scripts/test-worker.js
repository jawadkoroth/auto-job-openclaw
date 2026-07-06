const { runJob } = require("../apps/worker");
const logger = require("../packages/logger");

(async () => {
    logger.info("Starting Worker engine verification run...");
    
    // Test a basic login workflow against one of our skeleton plugins (e.g. LinkedIn login)
    const result = await runJob("linkedin", "login");
    logger.info(`Verification execution result: ${JSON.stringify(result, null, 2)}`);
    
    process.exit(0);
})();
