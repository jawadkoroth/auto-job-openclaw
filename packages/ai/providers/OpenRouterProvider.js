const BaseProvider = require("./BaseProvider");
const axios = require("axios");
const logger = require("../../logger");

class OpenRouterProvider extends BaseProvider {
    /**
     * @param {string} apiKey 
     * @param {string} model 
     */
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey;
        this.model = model || "google/gemini-2.5-flash";
    }

    async parseCommand(commandText, systemPrompt) {
        logger.automation.info(`Executing AI completion via OpenRouter (${this.model}).`);
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: commandText }
                ],
                temperature: 0.1
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                timeout: 15000
            }
        );

        let content = response.data.choices[0].message.content.trim();
        if (content.startsWith("```")) {
            content = content.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
        }
        return JSON.parse(content);
    }

    async generateText(promptText, systemPrompt) {
        logger.automation.info(`Executing AI completion via OpenRouter (${this.model}).`);
        const response = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: promptText }
                ],
                temperature: 0.3
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    "Content-Type": "application/json"
                },
                timeout: 25000
            }
        );
        return response.data.choices[0].message.content.trim();
    }
}

module.exports = OpenRouterProvider;
