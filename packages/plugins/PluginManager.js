const path = require("path");
const fs = require("fs");
const BasePlugin = require("./BasePlugin");
const logger = require("../logger");
const config = require("../config");

class PluginManager {
    constructor() {
        this.plugins = new Map();
    }

    /**
     * Scan the packages/plugins/ directory and load all active plugins
     */
    loadPlugins() {
        const pluginDirs = ["naukri", "linkedin", "foundit", "hirist", "instahyre", "wellfound", "remoteok", "weworkremotely", "cutshort"];
        
        for (const dirName of pluginDirs) {
            const pluginPath = path.join(__dirname, dirName);
            const indexPath = path.join(pluginPath, "index.js");
            
            if (fs.existsSync(indexPath)) {
                try {
                    const PluginClass = require(pluginPath);
                    const context = {
                        logger: logger.plugin(dirName),
                        config,
                        name: dirName
                    };
                    
                    const instance = new PluginClass(context);
                    if (instance instanceof BasePlugin) {
                        this.plugins.set(dirName, instance);
                        logger.automation.info(`Successfully loaded plugin: ${dirName}`);
                    } else {
                        logger.automation.error(`Plugin in ${dirName} does not extend BasePlugin`);
                    }
                } catch (error) {
                    logger.automation.error(`Failed to load plugin ${dirName}: ${error.stack}`);
                }
            }
        }
    }

    /**
     * Retrieve a loaded plugin instance by name
     * @param {string} name 
     * @returns {BasePlugin}
     */
    getPlugin(name) {
        const normName = name.toLowerCase();
        if (!this.plugins.has(normName)) {
            throw new Error(`Plugin not loaded or does not exist: ${name}`);
        }
        return this.plugins.get(normName);
    }

    /**
     * Get a list of all loaded plugin names
     * @returns {string[]}
     */
    getAvailablePlugins() {
        return Array.from(this.plugins.keys());
    }
}

const manager = new PluginManager();
// Load plugins right away
manager.loadPlugins();

module.exports = manager;
