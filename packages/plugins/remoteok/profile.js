module.exports = async function updateProfile(plugin, page) {
    plugin.logger.info("RemoteOK is an open board. Skipping profile refresh.");
    return true;
};
