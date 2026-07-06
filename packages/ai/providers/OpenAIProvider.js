const BaseProvider = require("./BaseProvider");
const axios = require("axios");
const logger = require("../../logger");

class OpenAIProvider extends BaseProvider {
    /**
     * @param {string} apiKey 
     * @param {string} model 
     */
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey;
        this.model = model || "gpt-4o-mini";
    }

    async parseCommand(commandText, systemPrompt) {
        logger.automation.info(`Executing AI completion via OpenAI API (${this.model}).`);
        const response = await axios.post(
            "https://api.openai.com/v1/chat/completions",
            {
                model: this.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: commandText }
                ],
                temperature: 0.1,
                response_format: { type: "json_object" }
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
}

module.exports = OpenAIProvider;
