const db = require("../database");
const crypto = require("crypto");

class TaskQueue {
    /**
     * Push a new task into the SQLite database-backed queue
     * @param {string} portal Portal name (e.g. 'naukri')
     * @param {string} action Action to execute (e.g. 'updateProfile')
     * @param {Object} args Custom arguments
     * @returns {Promise<string>} Created task unique ID
     */
    async push(portal, action, args = {}) {
        await db.init();
        const id = crypto.randomUUID();
        const sql = `
            INSERT INTO tasks (id, portal, action, args, status, attempts, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'pending', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `;
        await db.run(sql, [id, portal.toLowerCase(), action, JSON.stringify(args)]);
        return id;
    }

    /**
     * Poll and fetch the oldest pending task, marking it as running
     * @returns {Promise<Object|null>} Task object or null if queue is empty
     */
    async getNext() {
        await db.init();
        
        // Fetch oldest pending task
        const sqlSelect = `
            SELECT * FROM tasks 
            WHERE status = 'pending' 
            ORDER BY created_at ASC 
            LIMIT 1
        `;
        const task = await db.get(sqlSelect);
        if (!task) return null;

        // Reserve task by updating status to 'running'
        const sqlUpdate = `
            UPDATE tasks 
            SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `;
        await db.run(sqlUpdate, [task.id]);
        
        try {
            task.args = JSON.parse(task.args || "{}");
        } catch (e) {
            task.args = {};
        }
        return task;
    }

    /**
     * Mark a task as completed with outcome result
     * @param {string} id Task ID
     * @param {any} result Execution outcome details
     */
    async complete(id, result = {}) {
        await db.init();
        const sql = `
            UPDATE tasks 
            SET status = 'completed', result = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `;
        await db.run(sql, [JSON.stringify(result), id]);
    }

    /**
     * Mark a task as failed with error log details
     * @param {string} id Task ID
     * @param {string} errorMsg Exception message
     */
    async fail(id, errorMsg) {
        await db.init();
        const sql = `
            UPDATE tasks 
            SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ?
        `;
        await db.run(sql, [errorMsg, id]);
    }

    /**
     * Get count of tasks waiting in queue
     * @returns {Promise<number>}
     */
    async getPendingCount() {
        await db.init();
        const row = await db.get("SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'");
        return row ? row.count : 0;
    }

    /**
     * Fetch list of recent tasks
     * @param {number} limit 
     * @returns {Promise<any[]>}
     */
    async getRecent(limit = 10) {
        await db.init();
        return await db.all("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?", [limit]);
    }
}

module.exports = new TaskQueue();
