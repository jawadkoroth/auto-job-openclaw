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
            lastHeartbeat: Date.now()
        });

        this.registerWorker("windows", {
            type: "windows",
            name: "Windows Worker (Desktop Playwright)",
            status: "online",
            capabilities: ["linkedin", "naukri", "foundit", "hirist", "cutshort", "instahyre", "wellfound", "remoteok", "weworkremotely"],
            battery: null,
            isCloud: false,
            lastHeartbeat: Date.now()
        });

        this.registerWorker("android", {
            type: "android",
            name: "Android Worker (Native Mobile Node)",
            status: "online",
            capabilities: ["naukri", "linkedin", "hirist", "cutshort", "foundit", "instahyre", "wellfound", "remoteok", "weworkremotely"],
            battery: { level: 92, charging: true },
            isCloud: false,
            lastHeartbeat: Date.now()
        });
    }

    registerWorker(id, details) {
        const existing = this.workers.get(id) || {};
        const updated = {
            id,
            name: details.name || id,
            type: details.type || id,
            status: details.status || "online",
            capabilities: details.capabilities || [],
            battery: details.battery || null,
            currentTask: details.currentTask || null,
            lastHeartbeat: details.lastHeartbeat || Date.now(),
            metrics: details.metrics || { tasksCompleted: 0, tasksFailed: 0 },
            ...existing,
            ...details
        };
        this.workers.set(id, updated);
        logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Worker registered/updated: ${id} (${updated.status})`) : console.log(`Registered ${id}`);
        return updated;
    }

    updateHeartbeat(id, metrics = {}) {
        const worker = this.workers.get(id);
        if (!worker) {
            return this.registerWorker(id, { ...metrics, lastHeartbeat: Date.now() });
        }
        worker.lastHeartbeat = Date.now();
        if (worker.status === "offline") {
            worker.status = "online";
            logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Worker ${id} recovered back to ONLINE state`) : null;
            eventBus.emit("WorkerOnline", { workerId: id });
        }
        if (metrics.status) worker.status = metrics.status;
        if (metrics.battery) worker.battery = metrics.battery;
        if (metrics.currentTask !== undefined) worker.currentTask = metrics.currentTask;
        if (metrics.tasksCompleted) worker.metrics.tasksCompleted = metrics.tasksCompleted;
        if (metrics.tasksFailed) worker.metrics.tasksFailed = metrics.tasksFailed;
        return worker;
    }

    setWorkerStatus(id, status, details = {}) {
        const worker = this.workers.get(id);
        if (worker) {
            worker.status = status;
            if (details.currentTask !== undefined) worker.currentTask = details.currentTask;
            logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Worker ${id} status set to: ${status}`) : null;
        }
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
            if (worker && (worker.status === "online" || worker.status === "idle") && worker.capabilities.includes(pName)) {
                logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Selected best worker '${workerId}' for portal '${pName}'`) : null;
                return worker;
            }
        }

        // Fallback: Return any online worker that lists capability
        for (const worker of this.workers.values()) {
            if ((worker.status === "online" || worker.status === "idle") && worker.capabilities.includes(pName)) {
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

        if (targetId === "android") {
            const androidWorker = require("./AndroidWorker");
            return androidWorker.startJob(task.portal, task.action || "apply", task);
        } else if (targetId === "windows") {
            const scriptRunner = require("./ScriptRunner");
            return scriptRunner.runScript(task.portal, task.action || "apply", task);
        } else {
            // Oracle Cloud Worker
            logger.scheduler ? logger.scheduler.info(`[WorkerRegistry] Task queued for Cloud Oracle Worker execution: ${task.taskId || 'N/A'}`) : null;
            return { queued: true, workerId: "oracle" };
        }
    }

    startHeartbeatMonitor() {
        setInterval(() => {
            const now = Date.now();
            const timeoutThreshold = 45000; // 45s heartbeat timeout
            for (const [id, worker] of this.workers.entries()) {
                if (worker.status !== "offline" && now - worker.lastHeartbeat > timeoutThreshold) {
                    worker.status = "offline";
                    logger.scheduler ? logger.scheduler.warn(`[WorkerRegistry] Worker ${id} missed heartbeats. Marking OFFLINE.`) : console.warn(`Worker ${id} offline`);
                    eventBus.emit("WorkerOffline", { workerId: id });
                }
            }
        }, 15000);
    }
}

module.exports = new WorkerRegistry();
