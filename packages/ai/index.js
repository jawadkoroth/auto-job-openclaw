const OpenRouterProvider = require("./providers/OpenRouterProvider");
const GeminiProvider = require("./providers/GeminiProvider");
const ClaudeProvider = require("./providers/ClaudeProvider");
const OpenAIProvider = require("./providers/OpenAIProvider");
const config = require("../config");
const logger = require("../logger");

class AiService {
    constructor() {
        this.provider = this.resolveProvider();
        this.circuitTripped = false;
        this.circuitTrippedReason = "";
    }

    isQuotaOrAuthError(error) {
        const msg = String(error.message || "").toLowerCase();
        return msg.includes("401") || msg.includes("402") || msg.includes("403") || msg.includes("429") || msg.includes("payment") || msg.includes("quota");
    }

    /**
     * Resolve active AI provider class based on configured keys
     */
    resolveProvider() {
        if (config.ai.openRouterKey) {
            return new OpenRouterProvider(config.ai.openRouterKey, config.ai.model);
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
     * Classify incoming user message intent into AUTOMATION, STATUS_QUERY, AMBIGUOUS, or CONVERSATION.
     * FAILS CLOSED: Defaults to CONVERSATION if uncertain.
     * @param {string} text 
     * @returns {Promise<{ intent: "AUTOMATION" | "STATUS_QUERY" | "AMBIGUOUS" | "CONVERSATION" }>}
     */
    async classifyIntent(text) {
        if (!text || typeof text !== "string") {
            return { intent: "CONVERSATION" };
        }
        const trimmed = text.trim();
        const lower = trimmed.toLowerCase();

        // 1. Fast Heuristics
        // Single vague words
        if (["jobs", "job", "apply", "search"].includes(lower)) {
            return { intent: "AMBIGUOUS" };
        }

        // Status queries
        if (
            lower.includes("how many") ||
            lower.includes("applied today") ||
            lower.includes("application summary") ||
            lower.includes("status of") ||
            lower.includes("show status") ||
            lower.includes("daily summary")
        ) {
            return { intent: "STATUS_QUERY" };
        }

        // Conversational greetings & common non-automation queries
        const isGreeting = /^(hi|hello|hey|greetings|good morning|good afternoon|good evening|thanks|thank you|sup|yo)[\s.!]*$/i.test(trimmed);
        if (isGreeting) {
            return { intent: "CONVERSATION" };
        }

        // Common technical question indicators
        if (
            /^(explain|what is|how to|why does|compare|tell me about|describe|can you|could you|who is)/i.test(trimmed) &&
            !trimmed.toLowerCase().includes("apply") &&
            !trimmed.toLowerCase().includes("search for jobs")
        ) {
            return { intent: "CONVERSATION" };
        }

        // Positive explicit automation indicators
        const hasPortalName = /(naukri|hirist|instahyre|foundit|linkedin|wellfound|remoteok|weworkremotely)/i.test(trimmed);
        const hasExplicitAction = /(apply|search|find|update profile|login)\b/i.test(trimmed);

        if (hasPortalName && hasExplicitAction) {
            return { intent: "AUTOMATION" };
        }

        if (/(apply for|find|search for)\s+([a-z0-9\s]+)\s+(jobs|roles|positions)/i.test(trimmed)) {
            return { intent: "AUTOMATION" };
        }

        // 2. AI Provider classification (if available and not circuit-tripped)
        if (this.provider && !this.circuitTripped) {
            const systemPrompt = `
You are an intent classifier for OpenClaw. Classify the user's message into EXACTLY one of four categories:
1. "AUTOMATION": The user gives an EXPLICIT command to search jobs, apply to jobs, update profile, or log in on a portal (e.g. "Apply for DevOps jobs on Hirist", "Find Cloud Engineer jobs", "Update profile").
2. "STATUS_QUERY": The user asks about job application statistics, status, or database counts (e.g. "How many jobs did Hirist apply today?").
3. "AMBIGUOUS": The user provided a single vague word or incomplete phrase (e.g. "jobs", "apply", "search").
4. "CONVERSATION": Normal greetings, technical questions, or general conversation (e.g. "hi", "hello", "explain Kubernetes ingress", "what is AWS VPC").

CRITICAL RULE: If you are uncertain or the text is normal conversation, classify as "CONVERSATION". NEVER classify greetings or questions as "AUTOMATION".

Respond with a JSON object: {"intent": "AUTOMATION" | "STATUS_QUERY" | "AMBIGUOUS" | "CONVERSATION"}
`;
            try {
                const resObj = await this.provider.parseCommand(trimmed, systemPrompt);
                if (resObj && resObj.intent && ["AUTOMATION", "STATUS_QUERY", "AMBIGUOUS", "CONVERSATION"].includes(resObj.intent)) {
                    return { intent: resObj.intent };
                }
            } catch (err) {
                logger.automation.warn(`AI intent classification failed: ${err.message}. Falling back to conversational routing.`);
            }
        }

        // Fail-closed default: CONVERSATION
        return { intent: "CONVERSATION" };
    }

    /**
     * Parse natural language command into structured action payload.
     * FAILS CLOSED: Returns null if automation intent is missing or invalid.
     * @param {string} commandText 
     */
    async parseCommand(commandText) {
        logger.automation.info(`Parsing automation command: "${commandText}"`);
        
        if (this.circuitTripped) {
            logger.automation.warn(`[AI Circuit Breaker] Skipping AI request due to previous error: ${this.circuitTrippedReason}. Using rule-based parsing.`);
            return this.ruleBasedFallback(commandText);
        }

        const systemPrompt = `
You are the orchestration AI for an autonomous job application platform. 
Parse an EXPLICIT natural language job automation command into a structured action object.

Available portals: naukri, linkedin, foundit, hirist, instahyre, wellfound, remoteok, weworkremotely
Available actions: login, updateProfile, apply, search

Format output as a single JSON object (no markdown formatting):
{
  "plugin": "hirist",
  "action": "apply",
  "args": {
    "keywords": "DevOps Engineer",
    "location": ""
  }
}
`;

        if (!this.provider) {
            logger.automation.warn("No active AI Provider credentials found. Using strict rule-based parser.");
            return this.ruleBasedFallback(commandText);
        }

        try {
            const result = await this.provider.parseCommand(commandText, systemPrompt);
            if (result && result.plugin && result.action) {
                logger.automation.info(`Prompt parsed successfully: ${JSON.stringify(result)}`);
                return result;
            }
            return this.ruleBasedFallback(commandText);
        } catch (error) {
            if (this.isQuotaOrAuthError(error)) {
                this.circuitTripped = true;
                this.circuitTrippedReason = error.message;
                logger.automation.error(`[AI Circuit Breaker TRIPPED] ${error.message}.`);
            } else {
                logger.automation.error(`AI Vendor failed (${error.message}). Using strict rule-based fallback.`);
            }
            return this.ruleBasedFallback(commandText);
        }
    }

    /**
     * Strict Rule-based fallback parser.
     * FAILS CLOSED: Returns null if explicit automation intent is NOT found.
     * NEVER returns a default task for greetings ("hi", "hello") or unrelated conversation.
     * @param {string} commandText 
     */
    ruleBasedFallback(commandText) {
        const text = (commandText || "").toLowerCase().trim();

        // Strict check: Must have explicit portal or explicit action + job target
        let plugin = null;
        if (text.includes("hirist")) plugin = "hirist";
        else if (text.includes("foundit")) plugin = "foundit";
        else if (text.includes("instahyre")) plugin = "instahyre";
        else if (text.includes("linkedin")) plugin = "linkedin";
        else if (text.includes("naukri")) plugin = "naukri";
        else if (text.includes("wellfound")) plugin = "wellfound";
        else if (text.includes("remoteok")) plugin = "remoteok";
        else if (text.includes("weworkremotely") || text.includes("wwr")) plugin = "weworkremotely";

        let action = "apply";
        if (text.includes("login") || text.includes("log in") || text.includes("signin")) {
            action = "login";
        } else if (text.includes("update") || text.includes("profile") || text.includes("refresh")) {
            action = "updateProfile";
        } else if (text.includes("search") || text.includes("find")) {
            action = "search";
        }

        // Keywords extraction
        let keywords = "";
        const kwMatch = text.match(/(?:apply|search|find)\s+(?:only\s+)?(.*?)(?:\s+jobs)?(?:\s+in\s+|\s+at\s+|\s+on\s+|$)/i);
        if (kwMatch && kwMatch[1]) {
            let val = kwMatch[1].trim();
            val = val.replace(/\b(?:only|for|to|on)\b/g, "").replace(/\s+/g, " ").trim();
            if (val && !["jobs", "job", "devops jobs", "cloud jobs"].includes(val)) {
                keywords = val;
            }
        }
        if (!keywords && (text.includes("devops") || text.includes("cloud") || text.includes("platform") || text.includes("sre"))) {
            keywords = "DevOps Engineer";
        }

        // Location extraction
        let location = "";
        const locMatch = text.match(/(?:in|at|location)\s+([a-zA-Z\s]+)/i);
        if (locMatch && locMatch[1]) {
            let val = locMatch[1].trim();
            val = val.replace(/\s+on\s+(?:naukri|linkedin|foundit|hirist|instahyre|wellfound|remoteok|weworkremotely)\s*$/gi, "");
            location = val.trim();
        }

        // FAIL CLOSED: If no explicit portal and no explicit action with keyword was found, return null (DO NOT CREATE TASK)
        if (!plugin && !keywords && action === "apply") {
            logger.automation.warn(`[Fail-Closed Parser] Could not determine explicit automation intent from "${commandText}". No task created.`);
            return null;
        }

        return {
            plugin: plugin || "hirist", // default portal if action/keyword was explicit
            action,
            args: { keywords: keywords || "DevOps Engineer", location }
        };
    }

    /**
     * Generate conversational text response via active AI provider (OpenRouter).
     * @param {string} promptText 
     * @param {string} [systemPrompt] 
     */
    async generateText(promptText, systemPrompt) {
        const sys = systemPrompt || "You are OpenClaw AI, a helpful, intelligent assistant for software engineering, DevOps, cloud infrastructure, and career automation. Respond naturally, clearly, and concisely to user queries.";
        
        if (!this.provider) {
            throw new Error("No active AI Provider credentials configured.");
        }
        
        if (typeof this.provider.generateText === "function") {
            return await this.provider.generateText(promptText, sys);
        }
        
        logger.automation.warn("generateText not direct method on provider. Attempting fallback text completion.");
        const resObj = await this.provider.parseCommand(promptText, sys);
        return typeof resObj === "string" ? resObj : JSON.stringify(resObj);
    }
}

module.exports = new AiService();
