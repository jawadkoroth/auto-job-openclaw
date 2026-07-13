module.exports = async function updateProfile(plugin, page) {
    plugin.logger.info("WeWorkRemotely is an open board. Skipping profile refresh.");
    return true;
};
