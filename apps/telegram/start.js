const telegramService = require("./index");
const aiOrchestrator = require("../../packages/ai");
const { runJob } = require("../worker");
const logger = require("../../packages/logger");

logger.info("Initializing Telegram Bot daemon...", { action: "bot_init" });

telegramService.startPolling(async (message) => {
    const text = message.text.trim();

    // Standard slash controls
    if (text.startsWith("/")) {
        if (text === "/start") {
            await telegramService.sendMessage(
                `👋 *Job Automation Platform Active!*\n\n` +
                `Send natural language requests to control your agents:\n` +
                `• _"Update my Naukri profile"_\n` +
                `• _"Apply to React Developer jobs in Bangalore"_\n` +
                `• _"Log in to LinkedIn"_\n\n` +
                `Use /status to inspect platform health.`
            );
        } else if (text === "/status") {
            await telegramService.sendMessage(`🟢 *Status*: System online. Polling active. Scheduler active.`);
        } else {
            await telegramService.sendMessage(`❓ Unknown command. Try sending /start.`);
        }
        return;
    }

    // Pass message text to OpenClaw AI translation layer
    await telegramService.sendMessage(`🤖 *OpenClaw AI* is parsing: "${text}"...`);
    
    try {
        const parsedTask = await aiOrchestrator.parseCommand(text);
        
        await telegramService.sendMessage(
            `🎯 *Command Translated*:\n` +
            `• *Portal*: \`${parsedTask.plugin}\`\n` +
            `• *Action*: \`${parsedTask.action}\`\n` +
            `• *Params*: \`${JSON.stringify(parsedTask.args)}\`\n\n` +
            `Starting background execution...`
        );

        // Run worker task (returns async to maintain telegram listener responsiveness)
        runJob(parsedTask.plugin, parsedTask.action, parsedTask.args)
            .then((res) => {
                logger.info(`Executed async command task successfully.`, { plugin: parsedTask.plugin, action: parsedTask.action });
            })
            .catch((err) => {
                logger.error(`Exception during async execution: ${err.message}`);
            });

    } catch (err) {
        logger.error(`Failed parsing user telegram query: ${err.message}`);
        await telegramService.sendMessage(`❌ *Error*: Failed to execute: \`${err.message}\``);
    }
});
