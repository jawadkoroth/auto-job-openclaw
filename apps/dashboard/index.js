const http = require("http");
const fs = require("fs-extra");
const path = require("path");
const db = require("../../packages/database");
const taskQueue = require("../../packages/queue/TaskQueue");
const browserPool = require("../../packages/browser/BrowserPool");
const logger = require("../../packages/logger");

const PORT = process.env.DASHBOARD_PORT || 3000;

// Sleek responsive dashboard HTML
const htmlTemplate = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Browser Automation Dashboard</title>
    <style>
        :root {
            --bg-color: #0b0f19;
            --card-bg: #151c2c;
            --text-color: #f3f4f6;
            --accent-blue: #3b82f6;
            --accent-green: #10b981;
            --accent-red: #ef4444;
            --border-color: #1e293b;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
            background-color: var(--bg-color);
            color: var(--text-color);
            font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            padding: 2rem;
        }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2rem;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 1rem;
        }
        h1 { font-size: 1.8rem; background: linear-gradient(to right, #60a5fa, #3b82f6); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .badge { background: #1e293b; padding: 0.3rem 0.6rem; border-radius: 4px; font-size: 0.8rem; font-weight: bold; }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
            gap: 1.5rem;
            margin-bottom: 2rem;
        }
        .card {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 1.5rem;
            box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
        }
        .card-title { font-size: 0.85rem; color: #94a3b8; text-transform: uppercase; margin-bottom: 0.5rem; }
        .card-value { font-size: 2rem; font-weight: bold; }
        .sections {
            display: grid;
            grid-template-columns: 2fr 1fr;
            gap: 1.5rem;
        }
        .sec-card {
            background-color: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 1.5rem;
            margin-bottom: 1.5rem;
        }
        .sec-title { font-size: 1.1rem; margin-bottom: 1rem; border-left: 4px solid var(--accent-blue); padding-left: 0.5rem; }
        table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
        th, td { text-align: left; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border-color); font-size: 0.9rem; }
        th { color: #94a3b8; font-weight: 500; }
        .status-pill { padding: 0.2rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: bold; display: inline-block; }
        .status-pending { background: #3b82f620; color: #60a5fa; }
        .status-running { background: #f59e0b20; color: #fbbf24; }
        .status-completed { background: #10b98120; color: #34d399; }
        .status-failed { background: #ef444420; color: #f87171; }
        .logs-box {
            background: #030712;
            padding: 1rem;
            border-radius: 6px;
            font-family: monospace;
            font-size: 0.8rem;
            max-height: 250px;
            overflow-y: auto;
            white-space: pre-wrap;
            color: #38bdf8;
            border: 1px solid #1e293b;
        }
    </style>
</head>
<body>
    <header>
        <h1>Platform Control Dashboard</h1>
        <div class="badge" id="system-time">GMT</div>
    </header>
    
    <div class="grid">
        <div class="card">
            <div class="card-title">Pending Queue Tasks</div>
            <div class="card-value" id="val-pending">-</div>
        </div>
        <div class="card">
            <div class="card-title">Applied Today</div>
            <div class="card-value" id="val-applied" style="color: var(--accent-green);">-</div>
        </div>
        <div class="card">
            <div class="card-title">Jobs Database Count</div>
            <div class="card-value" id="val-jobs">-</div>
        </div>
        <div class="card">
            <div class="card-title">Scheduler Status</div>
            <div class="card-value" style="color: var(--accent-blue);">ACTIVE</div>
        </div>
    </div>

    <div class="sections">
        <div>
            <div class="sec-card">
                <div class="sec-title">Recent Task Queue Executions</div>
                <div style="overflow-x: auto;">
                    <table id="tasks-table">
                        <thead>
                            <tr>
                                <th>Portal</th>
                                <th>Action</th>
                                <th>Status</th>
                                <th>Created At</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
            
            <div class="sec-card">
                <div class="sec-title">Deduplicated Scraped Jobs</div>
                <div style="overflow-x: auto;">
                    <table id="jobs-table">
                        <thead>
                            <tr>
                                <th>Portal</th>
                                <th>Title</th>
                                <th>Company</th>
                                <th>Status</th>
                            </tr>
                        </thead>
                        <tbody></tbody>
                    </table>
                </div>
            </div>
        </div>
        
        <div>
            <div class="sec-card">
                <div class="sec-title">Browser Session Status</div>
                <table id="sessions-table">
                    <thead>
                        <tr>
                            <th>Portal</th>
                            <th>Health</th>
                        </tr>
                    </thead>
                    <tbody></tbody>
                </table>
            </div>
            
            <div class="sec-card">
                <div class="sec-title">Live Automation logs</div>
                <div class="logs-box" id="logs-box">Loading logs...</div>
            </div>
        </div>
    </div>

    <script>
        async function fetchStatus() {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                document.getElementById('system-time').innerText = new Date().toLocaleTimeString();
                document.getElementById('val-pending').innerText = data.pendingCount;
                document.getElementById('val-applied').innerText = data.appliedTodayCount;
                document.getElementById('val-jobs').innerText = data.totalJobsCount;
                
                // Tasks
                const tasksBody = document.querySelector('#tasks-table tbody');
                tasksBody.innerHTML = data.recentTasks.map(t => \`
                    <tr>
                        <td><strong>\${t.portal}</strong></td>
                        <td>\${t.action}</td>
                        <td><span class="status-pill status-\${t.status}">\${t.status}</span></td>
                        <td>\${new Date(t.created_at + 'Z').toLocaleString()}</td>
                    </tr>
                \`).join('');

                // Jobs
                const jobsBody = document.querySelector('#jobs-table tbody');
                jobsBody.innerHTML = data.recentJobs.map(j => \`
                    <tr>
                        <td><strong>\${j.portal}</strong></td>
                        <td>\${j.title}</td>
                        <td>\${j.company}</td>
                        <td>
                            <span class="status-pill \${j.applied ? 'status-completed' : j.ignored ? 'status-failed' : 'status-pending'}">
                                \${j.applied ? 'Applied' : j.ignored ? 'Ignored' : 'Unapplied'}
                            </span>
                        </td>
                    </tr>
                \`).join('');

                // Session Health
                const sessBody = document.querySelector('#sessions-table tbody');
                sessBody.innerHTML = Object.entries(data.browserHealth).map(([portal, health]) => \`
                    <tr>
                        <td>\${portal}</td>
                        <td><span class="status-pill \${health === 'healthy' ? 'status-completed' : 'status-failed'}">\${health}</span></td>
                    </tr>
                \`).join('');

                // Logs
                document.getElementById('logs-box').innerText = data.logs;

            } catch (e) {
                console.error(e);
            }
        }
        
        fetchStatus();
        setInterval(fetchStatus, 3000);
    </script>
</body>
</html>
`;

const server = http.createServer(async (req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(htmlTemplate);
    } else if (req.url === "/api/status") {
        try {
            await db.init();
            const pendingCount = await taskQueue.getPendingCount();
            const recentTasks = await taskQueue.getRecent(10);
            
            const appliedToday = await db.get(
                "SELECT COUNT(*) as count FROM jobs WHERE applied = 1 AND date(timestamp) = date('now')"
            );
            const totalJobs = await db.get("SELECT COUNT(*) as count FROM jobs");
            const recentJobs = await db.all("SELECT * FROM jobs ORDER BY timestamp DESC LIMIT 10");
            
            const browserHealth = await browserPool.healthCheckAll();

            // Read last 20 lines of logs/automation.log
            let logLines = "No logs recorded yet.";
            const logPath = path.join(process.cwd(), "logs", "automation.log");
            if (fs.existsSync(logPath)) {
                const logsContent = await fs.readFile(logPath, "utf-8");
                logLines = logsContent.trim().split("\n").slice(-25).join("\n");
            }

            const responseData = {
                pendingCount,
                recentTasks,
                appliedTodayCount: appliedToday ? appliedToday.count : 0,
                totalJobsCount: totalJobs ? totalJobs.count : 0,
                recentJobs,
                browserHealth,
                logs: logLines
            };

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(responseData));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(`Internal Error: ${err.message}`);
        }
    } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
    }
});

if (require.main === module) {
    server.listen(PORT, () => {
        logger.automation.info(`Lightweight Dashboard server listening on port: ${PORT}`);
    });
}

module.exports = server;
