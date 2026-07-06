const BaseProvider = require("./BaseProvider");
const axios = require("axios");
const logger = require("../../logger");

class ClaudeProvider extends BaseProvider {
    /**
     * @param {string} apiKey 
     * @param {string} model 
     */
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey;
        this.model = model || "claude-3-5-sonnet-20241022";
    }

    async parseCommand(commandText, systemPrompt) {
        logger.automation.info(`Executing AI completion via Anthropic Claude API (${this.model}).`);
        const response = await axios.post(
            "https://api.anthropic.com/v1/messages",
            {
                model: this.model,
                system: systemPrompt,
                messages: [
                    { role: "user", content: commandText }
                ],
                max_tokens: 1000,
                temperature: 0.1
            },
            {
                headers: {
                    "x-api-key": this.apiKey,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json"
                },
                timeout: 15000
            }
        );

        let content = response.data.content[0].text.trim();
        if (content.startsWith("```")) {
            content = content.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }
        return JSON.parse(content);
    }
}

module.exports = ClaudeProvider;
