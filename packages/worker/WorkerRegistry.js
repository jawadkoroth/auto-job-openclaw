const EventEmitter = require("events");
const eventBus = require("../events/EventBus");
const logger = require("../logger");
const config = require("../config");

class WorkerRegistry extends EventEmitter {
    constructor() {
        super();
        this.workers = new Map();
        this.initDefaultWorkers();
        this.startHeartbeatMonitor();
    }

    initDefaultWorkers() {
        // Initialize default registered worker nodes
        this.registerWorker("oracle", {
            type: "oracle",
            name: "Oracle Worker (Cloud)",
            status: "online",
            capabilities: ["hirist", "cutshort", "instahyre", "wellfound", "remoteok", "weworkremotely", "foundit"],
            battery: null,
            isCloud: true,
            hostname: "oracle-cloud-vm",
            platform: "linux",
            lastHeartbeat: Date.now()
        });

        this.registerWorker("windows", {
            type: "windows",
            name: "Windows Worker (Desktop Playwright)",
            status: "offline", // Default to offline until live agent sends heartbeat
            capabilities: ["linkedin", "naukri", "foundit", "hirist", "cutshort", "instahyre", "wellfound", "remoteok", "weworkremotely"],
            battery: null,
            isCloud: false,
            hostname: "windows-pc",
            platform: "win32",
            lastHeartbeat: 0
        });

        this.registerWorker("android", {
            type: "android",
            name: "Android Worker (Native Mobile Node)",
            status: "offline", // Default to offline until live agent sends heartbeat
            capabilities: ["naukri", "linkedin", "hirist", "cutshort", "foundit", "instahyre", "wellfound", "remoteok", "weworkremotely"],
            battery: { level: 92, charging: true },
            isCloud: false,
            hostname: "android-node",
            platform: "android",
            lastHeartbeat: 0
        });
    }

    registerWorker(id, details) {
        const normId = this.normalizeWorkerId(id) || id;
        const existing = this.workers.get(normId) || {};
        const updated = {
            id: normId,
            name: details.name || normId,
            type: details.type || normId,
            status: details.status || "online",
            capabilities: details.capabilities || existing.capabilities || [],
            battery: details.battery || existing.battery || null,
            hostname: details.hostname || existing.hostname || "unknown",
            platform: details.platform || existing.platform || "unknown",
            currentTask: details.currentTask !== undefined ? details.currentTask : (existing.currentTask || null),
            lastTaskAt: details.lastTaskAt || existing.lastTaskAt || null,
            lastHeartbeat: details.lastHeartbeat || Date.now(),
            metrics: details.metrics || existing.metrics || { tasksCompleted: 0, tasksFailed: 0 },
            ...existing,
            ...details
        };
        this.workers.set(normId, updated);
        logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Worker registered/updated: ${normId} (${updated.status})`) : console.log(`Registered ${normId}`);
        return updated;
    }

    updateHeartbeat(id, metrics = {}) {
        const normId = this.normalizeWorkerId(id) || id;
        const worker = this.workers.get(normId);
        if (!worker) {
            return this.registerWorker(normId, { ...metrics, status: "online", lastHeartbeat: Date.now() });
        }
        worker.lastHeartbeat = Date.now();
        if (worker.status === "offline") {
            worker.status = "online";
            logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Worker ${normId} recovered back to ONLINE state`) : null;
            eventBus.emit("WorkerOnline", { workerId: normId });
        }
        if (metrics.status) worker.status = metrics.status;
        if (metrics.battery) worker.battery = metrics.battery;
        if (metrics.hostname) worker.hostname = metrics.hostname;
        if (metrics.platform) worker.platform = metrics.platform;
        if (metrics.currentTask !== undefined) worker.currentTask = metrics.currentTask;
        if (metrics.lastTaskAt) worker.lastTaskAt = metrics.lastTaskAt;
        if (metrics.tasksCompleted) worker.metrics.tasksCompleted = metrics.tasksCompleted;
        if (metrics.tasksFailed) worker.metrics.tasksFailed = metrics.tasksFailed;
        return worker;
    }

    setWorkerStatus(id, status, details = {}) {
        const normId = this.normalizeWorkerId(id) || id;
        const worker = this.workers.get(normId);
        if (worker) {
            worker.status = status;
            if (details.currentTask !== undefined) worker.currentTask = details.currentTask;
            if (details.lastTaskAt) worker.lastTaskAt = details.lastTaskAt;
            logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Worker ${normId} status set to: ${status}`) : null;
        }
    }

    isWorkerOnline(id) {
        const worker = this.getWorker(id);
        if (!worker) return false;
        if (worker.isCloud) return true; // Oracle is local/cloud process
        const isRecent = (Date.now() - (worker.lastHeartbeat || 0)) <= 45000;
        return (worker.status === "online" || worker.status === "idle" || worker.status === "busy") && isRecent;
    }

    normalizeWorkerId(id) {
        if (!id || typeof id !== "string") return null;
        const norm = id.trim().toLowerCase();
        if (norm === "pc" || norm === "windows" || norm === "desktop") return "windows";
        if (norm === "mobile" || norm === "android") return "android";
        if (norm === "oracle" || norm === "cloud") return "oracle";
        return norm;
    }

    getWorker(id) {
        const normId = this.normalizeWorkerId(id) || id;
        return this.workers.get(normId) || this.workers.get(id) || null;
    }

    getAllWorkers() {
        return Array.from(this.workers.values());
    }

    getBestWorker(portal, workerPreference = null) {
        return this.getBestWorkerForPortal(portal, workerPreference);
    }

    getBestWorkerForPortal(portal, workerPreference = null) {
        const pName = portal ? portal.toLowerCase() : "naukri";

        // 1. Explicit Worker Selection (e.g., pc/windows, mobile/android, oracle)
        if (workerPreference) {
            const targetId = this.normalizeWorkerId(workerPreference);
            const targetWorker = this.workers.get(targetId);
            if (targetWorker) {
                logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Explicit worker selected: '${targetWorker.id}' for portal '${pName}'`) : null;
                return targetWorker;
            }
        }

        // 2. Default Priority List matching portal config
        const priorityList = config.workerPriorities[pName] || config.workerPriorities.default || ["windows", "android", "oracle"];
        
        for (const workerId of priorityList) {
            const worker = this.workers.get(workerId);
            if (worker && this.isWorkerOnline(workerId) && worker.capabilities.includes(pName)) {
                logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Selected best worker '${workerId}' for portal '${pName}'`) : null;
                return worker;
            }
        }

        // Fallback: Return any online worker that lists capability
        for (const worker of this.workers.values()) {
            if (this.isWorkerOnline(worker.id) && worker.capabilities.includes(pName)) {
                logger.scheduler ? logger.scheduler.warn(`[WorkerRegistry] Preferred priority workers offline for '${pName}'. Fallback to '${worker.id}'`) : null;
                return worker;
            }
        }

        // Default fallback to first priority if none online
        const fallbackId = priorityList[0] || "windows";
        logger.scheduler ? logger.scheduler.warn(`[WorkerRegistry] All candidate workers offline for '${pName}'. Defaulting task to '${fallbackId}'`) : null;
        return this.workers.get(fallbackId) || { id: fallbackId, name: `${fallbackId} Worker`, status: "offline" };
    }

    async execute(workerId, task = {}) {
        const targetId = this.normalizeWorkerId(workerId) || "windows";
        logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Routing execution to worker '${targetId}' for task ${task.taskId || 'N/A'}`) : null;

        if (!this.isWorkerOnline(targetId) && targetId !== "oracle") {
            logger.scheduler ? logger.scheduler.warn(`[WorkerRegistry] Cannot execute task on OFFLINE worker '${targetId}'`) : null;
            return { queued: false, success: false, error: `Worker '${targetId}' is OFFLINE`, status: "OFFLINE" };
        }

        if (targetId === "android") {
            const androidWorker = require("./AndroidWorker");
            return androidWorker.startJob(task.portal, task.action || "apply", task);
        } else if (targetId === "windows") {
            // Task is queued in TaskQueue for the remote Windows Worker Agent to poll & execute natively
            logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Task ${task.taskId || 'N/A'} queued for Windows PC Worker Agent polling.`) : null;
            return { queued: true, workerId: "windows", status: "WAITING_FOR_WINDOWS_WORKER" };
        } else {
            // Oracle Cloud Worker (Local execution)
            const scriptRunner = require("./ScriptRunner");
            return scriptRunner.runScript(task.portal, task.action || "apply", task);
        }
    }

    startHeartbeatMonitor() {
        setInterval(() => {
            const now = Date.now();
            const timeoutThreshold = 45000; // 45s heartbeat timeout
            for (const [id, worker] of this.workers.entries()) {
                if (!worker.isCloud && worker.status !== "offline" && (now - worker.lastHeartbeat > timeoutThreshold)) {
                    worker.status = "offline";
                    logger.scheduler ? logger.scheduler.warn(`[WorkerRegistry] Worker ${id} missed heartbeats. Marking OFFLINE.`) : console.warn(`Worker ${id} offline`);
                    eventBus.emit("WorkerOffline", { workerId: id });
                }
            }
        }, 15000);
    }
}

module.exports = new WorkerRegistry();
