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
        try {
            const response = await axios.post(
                "https://openrouter.ai/api/v1/chat/completions",
                {
                    model: this.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: commandText }
                    ],
                    max_tokens: 1000,
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
        } catch (error) {
            if (error.response) {
                logger.automation.error(`OpenRouter API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
            } else {
                logger.automation.error(`OpenRouter Request Error: ${error.message}`);
            }
            throw error;
        }
    }

    async generateText(promptText, systemPrompt) {
        logger.automation.info(`Executing AI completion via OpenRouter (${this.model}).`);
        try {
            const response = await axios.post(
                "https://openrouter.ai/api/v1/chat/completions",
                {
                    model: this.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: promptText }
                    ],
                    max_tokens: 1000,
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
        } catch (error) {
            if (error.response) {
                logger.automation.error(`OpenRouter API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
            } else {
                logger.automation.error(`OpenRouter Request Error: ${error.message}`);
            }
            throw error;
        }
    }
}

module.exports = OpenRouterProvider;
