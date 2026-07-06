# Creating Portal Plugins Guide

Every job portal is implemented as a plugin inside `packages/plugins/`. This guide explains how to add new plugins or update selectors.

---

## 🏗️ Plugin Structure

To add a new portal plugin (e.g. `monster`), create a directory under `packages/plugins/monster/` with these files:

```text
monster/
  ├── login.js          # Authentication automation
  ├── profile.js        # Profile modification / update triggers
  ├── search.js         # Scraping job listings based on queries
  ├── apply.js          # Clicking apply selectors
  └── index.js          # Class entry point extending BasePlugin
```

---

## 📝 Entry File Example (`index.js`)

Your plugin main class must extend `BasePlugin`:

```javascript
const BasePlugin = require("../BasePlugin");
const login = require("./login");
const profile = require("./profile");
const search = require("./search");
const apply = require("./apply");

class MonsterPlugin extends BasePlugin {
    async login() {
        return login(this);
    }
    
    async updateProfile() {
        return profile(this);
    }
    
    async search(queryOptions) {
        return search(this, queryOptions);
    }
    
    async apply(jobs, options) {
        return apply(this, jobs, options);
    }
}

module.exports = MonsterPlugin;
```

---

## 🔌 Registering Your Plugin

Open `packages/plugins/PluginManager.js` and add your plugin directory name to the `pluginDirs` scan list:

```javascript
const pluginDirs = ["naukri", "linkedin", "foundit", "hirist", "instahyre", "monster"];
```

The system will dynamically load, register, and make your new plugin accessible. It is now accessible via OpenClaw AI command parsing!
