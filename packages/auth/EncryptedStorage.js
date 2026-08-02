const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger");

class EncryptedStorage {
    constructor(storagePath) {
        this.storagePath = storagePath || path.join(process.cwd(), "sessions", "encrypted_store.json");
        this.algorithm = "aes-256-gcm";
        const secret = process.env.OPENCLAW_ENCRYPTION_KEY || process.env.ANDROID_WORKER_SECRET || "openclaw_master_secure_key_2026";
        this.key = crypto.createHash("sha256").update(secret).digest();
        this._ensureStorageDir();
    }

    _ensureStorageDir() {
        try {
            const dir = path.dirname(this.storagePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        } catch (e) {
            logger.auth ? logger.auth.error(`Failed creating storage directory: ${e.message}`) : console.error(e);
        }
    }

    encrypt(text) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.algorithm, this.key, iv);
        let encrypted = cipher.update(text, "utf8", "hex");
        encrypted += cipher.final("hex");
        const authTag = cipher.getAuthTag().toString("hex");
        return {
            iv: iv.toString("hex"),
            authTag,
            content: encrypted
        };
    }

    decrypt(encryptedObj) {
        if (!encryptedObj || !encryptedObj.iv || !encryptedObj.authTag || !encryptedObj.content) {
            throw new Error("Invalid encrypted payload structure");
        }
        const decipher = crypto.createDecipheriv(
            this.algorithm,
            this.key,
            Buffer.from(encryptedObj.iv, "hex")
        );
        decipher.setAuthTag(Buffer.from(encryptedObj.authTag, "hex"));
        let decrypted = decipher.update(encryptedObj.content, "hex", "utf8");
        decrypted += decipher.final("utf8");
        return decrypted;
    }

    _loadStore() {
        if (!fs.existsSync(this.storagePath)) return {};
        try {
            const raw = fs.readFileSync(this.storagePath, "utf8");
            return JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }

    _saveStore(store) {
        try {
            fs.writeFileSync(this.storagePath, JSON.stringify(store, null, 2), "utf8");
        } catch (e) {
            logger.auth ? logger.auth.error(`Failed writing encrypted store: ${e.message}`) : console.error(e);
        }
    }

    set(key, data) {
        const store = this._loadStore();
        const textPayload = typeof data === "object" ? JSON.stringify(data) : String(data);
        const encrypted = this.encrypt(textPayload);
        store[key] = {
            encrypted,
            updatedAt: new Date().toISOString()
        };
        this._saveStore(store);
    }

    get(key) {
        const store = this._loadStore();
        if (!store[key] || !store[key].encrypted) return null;
        try {
            const decrypted = this.decrypt(store[key].encrypted);
            try {
                return JSON.parse(decrypted);
            } catch (e) {
                return decrypted;
            }
        } catch (e) {
            logger.auth ? logger.auth.warn(`Decryption failed for key ${key}: ${e.message}`) : console.warn(e);
            return null;
        }
    }

    delete(key) {
        const store = this._loadStore();
        if (store[key]) {
            delete store[key];
            this._saveStore(store);
        }
    }
}

module.exports = new EncryptedStorage();
