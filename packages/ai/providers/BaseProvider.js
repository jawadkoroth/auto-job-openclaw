class BaseProvider {
    /**
     * Parse natural language command using system template prompts
     * @param {string} commandText 
     * @param {string} systemPrompt 
     * @returns {Promise<Object>} Structured action JSON
     */
    async parseCommand(commandText, systemPrompt) {
        throw new Error(`parseCommand() not implemented in ${this.constructor.name}`);
    }
}

module.exports = BaseProvider;
