const OpenRouterProvider = require("./providers/OpenRouterProvider");
const GeminiProvider = require("./providers/GeminiProvider");
const ClaudeProvider = require("./providers/ClaudeProvider");
const OpenAIProvider = require("./providers/OpenAIProvider");
const config = require("../config");
const logger = require("../logger");

class AiService {
    constructor() {
        this.provider = this.resolveProvider();
    }

    /**
     * Resolve active AI provider class based on configured keys
     */
    resolveProvider() {
        if (config.ai.openRouterKey) {
            return new OpenRouterProvider(config.ai.openRouterKey);
        }
        if (process.env.GEMINI_API_KEY) {
            return new GeminiProvider(process.env.GEMINI_API_KEY);
        }
        if (process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY) {
            return new ClaudeProvider(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY);
        }
        if (process.env.OPENAI_API_KEY) {
            return new OpenAIProvider(process.env.OPENAI_API_KEY);
        }
        return null;
    }

    /**
     * Parse natural language command into structured action payload
     * @param {string} commandText 
     */
    async parseCommand(commandText) {
        logger.automation.info(`Parsing command: "${commandText}"`);
        
        const systemPrompt = `
You are the orchestration AI for an autonomous job application automation platform. 
Your task is to parse a natural language command into a structured action object.

Available plugins/portals:
- naukri
- linkedin
- foundit
- hirist
- instahyre

Available actions:
- login: Navigates to page and authenticates.
- updateProfile: Triggers profile update tasks (e.g. edits resume headline).
- apply: Searches for jobs and automatically runs application routines.

Format your output as a single valid JSON object. DO NOT wrap it in markdown code blocks like \`\`\`json. Return only the JSON string.
Structure:
{
  "plugin": "naukri" | "linkedin" | "foundit" | "hirist" | "instahyre",
  "action": "login" | "updateProfile" | "apply",
  "args": {
    "keywords": "job search keywords (default 'Software Engineer')",
    "location": "location filter (default '')"
  }
}
`;

        if (!this.provider) {
            logger.automation.warn("No active AI Provider credentials found. Invoking fallback regex rules parser.");
            return this.ruleBasedFallback(commandText);
        }

        try {
            const result = await this.provider.parseCommand(commandText, systemPrompt);
            logger.automation.info(`Prompt parsed successfully by AI vendor: ${JSON.stringify(result)}`);
            return result;
        } catch (error) {
            logger.automation.error(`AI Vendor failed (${error.message}). Triggering fallback rules parser.`);
            return this.ruleBasedFallback(commandText);
        }
    }

    /**
     * Regex fallback rules command translator
     * @param {string} commandText 
     */
    ruleBasedFallback(commandText) {
        const text = commandText.toLowerCase();
        
        let plugin = "naukri";
        if (text.includes("linkedin")) plugin = "linkedin";
        else if (text.includes("foundit")) plugin = "foundit";
        else if (text.includes("hirist")) plugin = "hirist";
        else if (text.includes("instahyre")) plugin = "instahyre";

        let action = "apply";
        if (text.includes("login") || text.includes("log in") || text.includes("signin") || text.includes("sign in")) {
            action = "login";
        } else if (text.includes("update") || text.includes("profile") || text.includes("refresh")) {
            action = "updateProfile";
        }

        let keywords = "Software Engineer";
        let location = "";

        // Keywords extraction
        const kwMatch = text.match(/(?:apply|search|find)\s+(?:only\s+)?(.*?)(?:\s+jobs)?(?:\s+in\s+|\s+at\s+|$)/i);
        if (kwMatch && kwMatch[1]) {
            let val = kwMatch[1].trim();
            val = val.replace(/\b(?:only|for|to|on)\b/g, "").replace(/\s+/g, " ").trim();
            if (val && !["devops jobs", "developer jobs", "engineer jobs", "jobs"].includes(val)) {
                keywords = val;
            }
        }
        
        // Location extraction
        const locMatch = text.match(/(?:in|at|location)\s+([a-zA-Z\s]+)/i);
        if (locMatch && locMatch[1]) {
            let val = locMatch[1].trim();
            val = val.replace(/\s+on\s+(?:naukri|linkedin|foundit|hirist|instahyre)\s*$/gi, "");
            location = val.trim();
        }

        return {
            plugin,
            action,
            args: { keywords, location }
        };
    }

    async generateText(promptText, systemPrompt) {
        if (!this.provider) {
            throw new Error("No active AI Provider credentials found.");
        }
        if (typeof this.provider.generateText === "function") {
            return this.provider.generateText(promptText, systemPrompt);
        }
        
        logger.automation.warn("generateText not implemented on active provider. Attempting parseCommand format fallback.");
        const resObj = await this.provider.parseCommand(promptText, systemPrompt);
        return typeof resObj === "string" ? resObj : JSON.stringify(resObj);
    }
}

module.exports = new AiService();
