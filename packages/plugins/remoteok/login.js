module.exports = async function login(plugin, page) {
    plugin.logger.info("RemoteOK is an open board. Skipping authentication steps.");
    return true;
};
