/**
 * Conversational Natural Language Command Parser for OpenClaw Telegram Control
 */

const KNOWN_PORTALS = ["naukri", "linkedin", "hirist", "cutshort", "foundit", "instahyre", "wellfound", "remoteok", "weworkremotely"];

class CommandParser {
    /**
     * Parse incoming natural language text message into structured intent and parameters
     * @param {string} text 
     * @returns {Object} { intent, portal, action, targetWorker, isDeterministicCommand, prompt, rawText }
     */
    parse(text) {
        if (!text || typeof text !== "string") {
            return { intent: "UNRECOGNIZED", isDeterministicCommand: false, rawText: text };
        }

        const trimmed = text.trim();
        const normalized = trimmed.toLowerCase();

        // 1. Explicit AI Activation (/ai <question>)
        if (normalized.startsWith("/ai ") || normalized === "/ai") {
            const prompt = trimmed.substring(3).trim();
            return {
                intent: "AI",
                prompt,
                isDeterministicCommand: true,
                rawText: text
            };
        }

        // 2. Help Commands (help, commands, /help)
        if (normalized === "help" || normalized === "commands" || normalized === "/help" || normalized === "/start") {
            return { intent: "HELP", isDeterministicCommand: true, rawText: text };
        }

        // 3. System Commands
        if (normalized === "status" || normalized.includes("show status") || normalized.includes("system status")) {
            return { intent: "STATUS", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "health" || normalized.includes("check health") || normalized.includes("worker health")) {
            return { intent: "HEALTH", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "workers" || normalized.includes("list workers") || normalized.includes("active workers")) {
            return { intent: "WORKERS", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "logs" || normalized.includes("show logs") || normalized.includes("recent logs")) {
            return { intent: "LOGS", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "screenshot" || normalized.includes("take screenshot") || normalized.includes("get screenshot")) {
            return { intent: "SCREENSHOT", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "heartbeat" || normalized.includes("ping worker") || normalized.includes("send heartbeat")) {
            return { intent: "HEARTBEAT", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "restart worker" || normalized.includes("restart android worker") || normalized.includes("reboot worker")) {
            return { intent: "RESTART_WORKER", targetWorker: "android", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "pause" || normalized.includes("pause worker") || normalized.includes("pause automation")) {
            return { intent: "PAUSE", isDeterministicCommand: true, rawText: text };
        }

        if (normalized === "resume" || normalized.includes("resume worker") || normalized.includes("resume automation")) {
            return { intent: "RESUME", isDeterministicCommand: true, rawText: text };
        }

        // 4. Profile Refresh Intent (e.g. "refresh naukri profile", "refresh naukri profile mobile", "refresh naukri profile oracle")
        if (
            (normalized.includes("start") && normalized.includes("profile") && (normalized.includes("refresh") || normalized.includes("update"))) ||
            normalized.includes("refresh") || 
            normalized.includes("update profile")
        ) {
            const portal = this.extractPortal(normalized);
            const targetWorker = this.extractWorker(normalized);
            return {
                intent: "REFRESH_PROFILE",
                portal: portal || "naukri",
                action: "updateProfile",
                targetWorker,
                isDeterministicCommand: true,
                rawText: text
            };
        }

        // 5. Stop Intent (e.g. "stop naukri", "stop all", "stop")
        if (normalized === "stop" || normalized.startsWith("stop") || normalized.includes("cancel job")) {
            const portal = this.extractPortal(normalized);
            return {
                intent: "STOP",
                portal: portal || "all",
                isDeterministicCommand: true,
                rawText: text
            };
        }

        // 6. Start Automation Intent (e.g. "start naukri", "start naukri mobile", "start naukri oracle", "start naukri pc", "start hirist")
        if (normalized.startsWith("start") || normalized.startsWith("run") || normalized.includes("apply on")) {
            const portal = this.extractPortal(normalized);
            if (portal) {
                const targetWorker = this.extractWorker(normalized);
                return {
                    intent: "START",
                    portal,
                    action: "apply",
                    targetWorker,
                    isDeterministicCommand: true,
                    rawText: text
                };
            }
        }

        // 7. Single Known Portal Keyword (e.g. "naukri", "hirist", "cutshort", "linkedin")
        const extractedPortal = this.extractPortal(normalized);
        if (extractedPortal && normalized.split(/\s+/).length <= 3 && !this.isConversationalPhrase(normalized)) {
            const targetWorker = this.extractWorker(normalized);
            return {
                intent: "START",
                portal: extractedPortal,
                action: "apply",
                targetWorker,
                isDeterministicCommand: true,
                rawText: text
            };
        }

        // Non-deterministic -> Unrecognized command (AI must be triggered via /ai)
        return { intent: "UNRECOGNIZED", isDeterministicCommand: false, rawText: text };
    }

    extractPortal(text) {
        for (const portal of KNOWN_PORTALS) {
            if (text.includes(portal)) return portal;
        }
        return null;
    }

    extractWorker(text) {
        if (text.includes("mobile") || text.includes("android")) return "android";
        if (text.includes("pc") || text.includes("windows") || text.includes("desktop")) return "windows";
        if (text.includes("oracle") || text.includes("cloud")) return "oracle";
        return null;
    }

    isConversationalPhrase(text) {
        return text.includes("explain") || text.includes("how") || text.includes("what") || text.includes("why") || text.includes("summary") || text.includes("write");
    }
}

module.exports = new CommandParser();
