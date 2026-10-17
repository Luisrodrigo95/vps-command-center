const http = require('http');
const { exec, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 9090;

function execPromise(cmd, timeout = 3500) {
    return new Promise((resolve) => {
        exec(cmd, { timeout }, (err, stdout, stderr) => {
            if (err) return resolve({ error: err.message, stdout: '', stderr: stderr ? stderr.toString() : '' });
            resolve({ error: null, stdout: stdout.toString(), stderr: stderr ? stderr.toString() : '' });
        });
    });
}

async function checkHttp(url, timeout = 2500) {
    const start = Date.now();
    try {
        const res = await execPromise(`curl -s -o /dev/null -w "%{http_code}" --max-time 2.5 "${url}"`, timeout);
        const code = parseInt(res.stdout.trim(), 10);
        const latency = Date.now() - start;
        return { ok: code >= 200 && code < 400, code: isNaN(code) ? 0 : code, latency };
    } catch (e) {
        return { ok: false, code: 0, latency: Date.now() - start };
    }
}

async function getSystemMetrics() {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const loadAvg = os.loadavg();
    const cpus = os.cpus();
    const uptimeSec = os.uptime();

    let disk = { total: '25G', used: '11G', free: '13G', percent: '45%' };
    try {
        const dfRes = execSync("df -h / | tail -n 1").toString().trim().split(/\s+/);
        if (dfRes.length >= 5) {
            disk = { total: dfRes[1], used: dfRes[2], free: dfRes[3], percent: dfRes[4] };
        }
    } catch (e) {}

    let memDetailed = { totalMb: Math.round(totalMem / (1024*1024)), usedMb: Math.round(usedMem / (1024*1024)), percent: Math.round((usedMem / totalMem) * 100) };
    try {
        const freeOut = execSync("free -m | grep Mem:").toString().trim().split(/\s+/);
        if (freeOut.length >= 7) {
            const t = parseInt(freeOut[1], 10);
            const u = parseInt(freeOut[2], 10);
            memDetailed = { totalMb: t, usedMb: u, percent: Math.round((u / t) * 100) };
        }
    } catch (e) {}

    return {
        hostname: os.hostname(),
        uptimeSec,
        uptimeFormatted: formatUptime(uptimeSec),
        loadAvg,
        cpuCount: cpus.length,
        memory: memDetailed,
        disk
    };
}

function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d > 0 ? d + 'd ' : ''}${h}h ${m}m`;
}

async function getSslInfo() {
    const certs = [
        { domain: 'therodrigo.com', file: '/etc/letsencrypt/live/therodrigo.com/cert.pem' },
        { domain: 'totimigracion.es', file: '/etc/letsencrypt/live/totimigracion.es/cert.pem' },
        { domain: 'agent.therodrigo.com', file: '/etc/letsencrypt/live/agent.therodrigo.com/cert.pem' }
    ];
    const results = [];
    for (const c of certs) {
        try {
            if (fs.existsSync(c.file)) {
                const out = execSync(`openssl x509 -enddate -noout -in "${c.file}"`).toString().trim();
                const dateStr = out.replace('notAfter=', '');
                const expDate = new Date(dateStr);
                const diffDays = Math.round((expDate - new Date()) / (1000 * 60 * 60 * 24));
                results.push({ domain: c.domain, daysLeft: diffDays, valid: diffDays > 0, date: expDate.toISOString().split('T')[0] });
            } else {
                results.push({ domain: c.domain, daysLeft: null, valid: false, date: 'N/A' });
            }
        } catch (e) {
            results.push({ domain: c.domain, daysLeft: null, valid: false, date: 'Error' });
        }
    }
    return results;
}

async function getFleetNodes() {
    const nodes = [
        { id: 'node-deb-01', name: 'Debian VPS Host', ip: '127.0.0.1', target: '127.0.0.1' },
        { id: 'node-win-01', name: 'Windows Node 01', ip: '194.156.90.100', target: '194.156.90.100' },
        { id: 'node-win-02', name: 'Windows Node 02', ip: '194.156.90.101', target: '194.156.90.101' },
        { id: 'node-win-03', name: 'Windows Node 03', ip: '194.156.90.103', target: '194.156.90.103' }
    ];

    const results = [];
    for (const n of nodes) {
        try {
            const start = Date.now();
            const res = await execPromise(`ping -c 1 -W 1.2 ${n.target}`);
            const latency = Date.now() - start;
            if (!res.error && res.stdout.includes('1 received')) {
                const match = res.stdout.match(/time=([0-9.]+)\s*ms/);
                const pingMs = match ? parseFloat(match[1]) : latency;
                results.push({ ...n, status: 'ONLINE', latency: pingMs });
            } else {
                results.push({ ...n, status: 'TIMEOUT', latency: null });
            }
        } catch (e) {
            results.push({ ...n, status: 'ERROR', latency: null });
        }
    }
    return results;
}

async function getProjectsStatus() {
    let pm2List = [];
    try {
        const pm2Out = execSync("pm2 jlist 2>/dev/null").toString();
        pm2List = JSON.parse(pm2Out);
    } catch (e) {}

    const pm2Map = {};
    for (const app of pm2List) {
        pm2Map[app.name] = {
            status: app.pm2_env ? app.pm2_env.status : 'stopped',
            pid: app.pid || 0,
            memory: app.monit ? Math.round(app.monit.memory / (1024*1024)) : 0,
            cpu: app.monit ? app.monit.cpu : 0,
            uptime: app.pm2_env && app.pm2_env.pm_uptime ? formatUptime((Date.now() - app.pm2_env.pm_uptime) / 1000) : '0s',
            restarts: app.pm2_env ? app.pm2_env.restart_time : 0,
            version: app.pm2_env ? app.pm2_env.version : '1.0.0'
        };
    }

    async function getSystemdService(serviceName) {
        try {
            const out = execSync(`systemctl show ${serviceName} --property=ActiveState,SubState,MainPID,ExecMainStartTimestamp`).toString();
            const active = out.match(/ActiveState=([^\n]+)/);
            const sub = out.match(/SubState=([^\n]+)/);
            const pid = out.match(/MainPID=([^\n]+)/);
            const startTime = out.match(/ExecMainStartTimestamp=([^\n]+)/);
            const isActive = active && active[1] === 'active';
            let memMb = 0;
            const pidNum = pid ? parseInt(pid[1], 10) : 0;
            if (pidNum > 0) {
                try {
                    const rss = execSync(`ps -o rss= -p ${pidNum}`).toString().trim();
                    memMb = Math.round(parseInt(rss, 10) / 1024) || 0;
                } catch(e) {}
            }
            return {
                status: isActive ? 'online' : 'stopped',
                subState: sub ? sub[1] : 'unknown',
                pid: pidNum,
                memory: memMb,
                cpu: 0,
                uptime: isActive ? (startTime ? startTime[1].split(' ').slice(1, 4).join(' ') : 'running') : 'offline',
                restarts: 0
            };
        } catch(e) {
            return { status: 'stopped', subState: 'failed', pid: 0, memory: 0, cpu: 0, uptime: 'offline', restarts: 0 };
        }
    }

    const totiSys = await getSystemdService('totimigraciones.service');
    const citaSys = await getSystemdService('cita-control.service');
    const nginxSys = await getSystemdService('nginx.service');
    const postfixSys = await getSystemdService('postfix.service');
    const dovecotSys = await getSystemdService('dovecot.service');
    const isMailOnline = postfixSys.status === 'online' && dovecotSys.status === 'online';

    const [httpPreswin, httpPortfolio, httpToti, httpInspection, httpCita] = await Promise.all([
        checkHttp('http://127.0.0.1:4000/'),
        checkHttp('http://127.0.0.1:3000/api/uptime'),
        checkHttp('http://127.0.0.1:3001/'),
        checkHttp('http://127.0.0.1:3000/technical-inspection'),
        checkHttp('http://127.0.0.1:8090/Appointment_Checker')
    ]);

    const projects = [
        {
            id: 'preswin',
            name: 'PresWin',
            subtitle: 'Construction Cost Estimator & Price Analysis',
            badge: 'Node PM2',
            port: 4000,
            publicUrl: 'https://therodrigo.com/preswin',
            localUrl: 'http://127.0.0.1:4000',
            path: '/var/www/preswin',
            icon: 'fa-calculator',
            color: '#38bdf8',
            data: pm2Map['preswin'] || { status: 'stopped', pid: 0, memory: 0, cpu: 0, uptime: 'N/A', restarts: 0 },
            http: httpPreswin,
            canRestart: true,
            actionKey: 'preswin'
        },
        {
            id: 'portfolio',
            name: 'therodrigo.com',
            subtitle: 'Personal Portfolio & Real-time Telemetry Hub',
            badge: 'Node / Express 5',
            port: 3000,
            publicUrl: 'https://therodrigo.com',
            localUrl: 'http://127.0.0.1:3000',
            path: '/var/www/my-portfolio',
            icon: 'fa-globe',
            color: '#2dd4bf',
            data: pm2Map['portfolio'] || { status: 'stopped', pid: 0, memory: 0, cpu: 0, uptime: 'N/A', restarts: 0 },
            http: httpPortfolio,
            canRestart: true,
            actionKey: 'portfolio'
        },
        {
            id: 'technical-inspection',
            name: 'Technical Inspection',
            subtitle: 'Plant Reliability, Punch List & CAM Orchestrator',
            badge: 'CAM Enterprise',
            port: 3000,
            publicUrl: 'https://therodrigo.com/technical-inspection',
            localUrl: 'http://127.0.0.1:3000/technical-inspection',
            path: '/var/www/my-portfolio/public/technical-inspection',
            icon: 'fa-industry',
            color: '#a855f7',
            data: {
                status: (httpInspection.ok || httpInspection.code === 401) ? 'online' : 'error',
                pid: pm2Map['portfolio'] ? pm2Map['portfolio'].pid : 0,
                memory: pm2Map['portfolio'] ? pm2Map['portfolio'].memory : 0,
                cpu: pm2Map['portfolio'] ? pm2Map['portfolio'].cpu : 0,
                uptime: pm2Map['portfolio'] ? pm2Map['portfolio'].uptime : 'N/A',
                restarts: pm2Map['portfolio'] ? pm2Map['portfolio'].restarts : 0
            },
            http: httpInspection,
            canRestart: true,
            actionKey: 'portfolio'
        },
        {
            id: 'totimigracion',
            name: 'totimigracion.es',
            subtitle: 'Asesoría de Extranjería y Trámites de Residencia',
            badge: 'Systemd Service',
            port: 3001,
            publicUrl: 'https://totimigracion.es',
            localUrl: 'http://127.0.0.1:3001',
            path: '/var/www/totimigraciones',
            icon: 'fa-passport',
            color: '#f59e0b',
            data: totiSys,
            http: httpToti,
            canRestart: true,
            actionKey: 'totimigracion'
        },
        {
            id: 'appointment-checker',
            name: 'Appointment Checker (Control Panel)',
            subtitle: 'Gestión de citas consulares vía totimigracion.es/admin',
            badge: 'Python Daemon',
            port: 8090,
            publicUrl: 'https://totimigracion.es/admin',
            localUrl: 'http://127.0.0.1:8090/Appointment_Checker',
            path: '/opt/cita-control',
            icon: 'fa-calendar-check',
            color: '#ec4899',
            data: citaSys,
            http: httpCita,
            canRestart: true,
            actionKey: 'cita-control'
        },
        {
            id: 'darkbot',
            name: 'DarkBot (Tanos API v12)',
            subtitle: 'DarkOrbit Bot & Linux Browser Native',
            badge: 'OpenJDK 17',
            port: 'GUI',
            publicUrl: 'Desktop: /home/bombi/DarkBot',
            localUrl: 'Desktop GUI',
            path: '/home/bombi/DarkBot',
            icon: 'fa-robot',
            color: '#ec4899',
            data: (() => {
                let pid = 0, mem = 0;
                try {
                    const pOut = execSync("pgrep -f 'DarkBot.jar' 2>/dev/null").toString().trim().split('\n')[0];
                    pid = parseInt(pOut, 10) || 0;
                    if (pid > 0) {
                        const rss = execSync(`ps -o rss= -p ${pid} 2>/dev/null`).toString().trim();
                        mem = Math.round(parseInt(rss, 10) / 1024) || 0;
                    }
                } catch(e) {}
                return {
                    status: pid > 0 ? 'online' : 'stopped',
                    pid: pid,
                    memory: mem,
                    cpu: 0,
                    uptime: pid > 0 ? 'activo' : 'inactivo',
                    restarts: 0
                };
            })(),
            http: { ok: true, code: 200, latency: 0 },
            canRestart: true,
            actionKey: 'darkbot'
        },
        {
            id: 'pikabot',
            name: 'Pikabot Suite',
            subtitle: 'DarkOrbit Bot & Tools (JDK 21)',
            badge: 'OpenJDK 21',
            port: 'GUI',
            publicUrl: 'Desktop: /home/bombi/Documents/Pikabot',
            localUrl: 'Desktop GUI',
            path: '/home/bombi/Documents/Pikabot',
            icon: 'fa-gamepad',
            color: '#eab308',
            data: (() => {
                let pid = 0, mem = 0;
                try {
                    const pOut = execSync("pgrep -f '[Pp]ika[Bb]ot.*\\.jar' 2>/dev/null").toString().trim().split('\n')[0];
                    pid = parseInt(pOut, 10) || 0;
                    if (pid > 0) {
                        const rss = execSync(`ps -o rss= -p ${pid} 2>/dev/null`).toString().trim();
                        mem = Math.round(parseInt(rss, 10) / 1024) || 0;
                    }
                } catch(e) {}
                return {
                    status: pid > 0 ? 'online' : 'stopped',
                    pid: pid,
                    memory: mem,
                    cpu: 0,
                    uptime: pid > 0 ? 'activo' : 'inactivo',
                    restarts: 0
                };
            })(),
            http: { ok: true, code: 200, latency: 0 },
            canRestart: true,
            actionKey: 'pikabot'
        },
        {
            id: 'totimail',
            name: 'TotiMail & Retention',
            subtitle: 'Postfix, Dovecot & Auto-Purge (30d)',
            badge: 'Mail Core',
            port: '25/993/587',
            publicUrl: 'https://mail.totimigracion.es',
            localUrl: 'Maildir /var/mail/vhosts',
            path: '/var/mail/vhosts/totimigracion.es',
            icon: 'fa-envelope-open-text',
            color: '#f43f5e',
            data: {
                status: isMailOnline ? 'online' : 'error',
                pid: postfixSys.pid || dovecotSys.pid || 0,
                memory: (postfixSys.memory || 0) + (dovecotSys.memory || 0),
                cpu: 0,
                uptime: postfixSys.uptime || 'online',
                restarts: 0
            },
            http: { ok: true, code: 200, latency: 1 },
            canRestart: true,
            actionKey: 'mail'
        },
        {
            id: 'nginx',
            name: 'Nginx Reverse Proxy',
            subtitle: 'Edge Gateway, SSL Term & Static Caching',
            badge: 'Gateway',
            port: 443,
            publicUrl: 'https://therodrigo.com',
            localUrl: 'http://127.0.0.1',
            path: '/etc/nginx',
            icon: 'fa-server',
            color: '#10b981',
            data: nginxSys,
            http: { ok: true, code: 200, latency: 1 },
            canRestart: true,
            actionKey: 'nginx'
        }
    ];

    return projects;
}

function getServiceLogs(serviceKey) {
    try {
        let cmd = '';
        switch (serviceKey) {
            case 'preswin':
                cmd = 'tail -n 80 /root/.pm2/logs/preswin-out.log 2>/dev/null; echo "\n[!] --- ERROR LOG ---"; tail -n 40 /root/.pm2/logs/preswin-error.log 2>/dev/null';
                break;
            case 'portfolio':
            case 'technical-inspection':
                cmd = 'tail -n 80 /root/.pm2/logs/portfolio-out.log 2>/dev/null; echo "\n[!] --- ERROR LOG ---"; tail -n 40 /root/.pm2/logs/portfolio-error.log 2>/dev/null';
                break;
            case 'totimigracion':
                cmd = 'journalctl -u totimigraciones.service -n 100 --no-pager 2>/dev/null';
                break;
            case 'cita-control':
                cmd = 'journalctl -u cita-control.service -n 100 --no-pager 2>/dev/null';
                break;
            case 'darkbot':
                cmd = 'tail -n 80 /home/bombi/Documents/darkbot/darkbot.log 2>/dev/null; tail -n 80 /home/bombi/Documents/darkbot/logs/* 2>/dev/null; echo "\n[!] --- DarkBot Libs ---"; ls -la /home/bombi/Documents/darkbot/lib';
                break;
            case 'pikabot':
                cmd = 'tail -n 80 /home/bombi/Documents/Pikabot/pikabot.log 2>/dev/null; echo "\n[!] --- Archivos en Pikabot ---"; ls -la /home/bombi/Documents/Pikabot/';
                break;
            case 'nginx':
                cmd = 'tail -n 60 /var/log/nginx/error.log 2>/dev/null; echo "\n[!] --- ACCESS LOG ---"; tail -n 40 /var/log/nginx/access.log 2>/dev/null';
                break;
            case 'xrdp':
                cmd = 'journalctl -u xrdp.service -n 100 --no-pager 2>/dev/null';
                break;
            case 'mail':
            case 'totimail':
            case 'mail-retention':
                cmd = 'journalctl -u totimigracion-mail-retention.service -n 50 --no-pager 2>/dev/null; echo "\n[!] --- PROXIMAS LIMPIEZAS (SYSTEMD TIMER) ---"; systemctl list-timers totimigracion-mail-retention.timer --no-pager 2>/dev/null; echo "\n[!] --- ESTADO SERVICIOS POSTFIX & DOVECOT ---"; systemctl status postfix dovecot --no-pager 2>/dev/null';
                break;
            default:
                cmd = 'dmesg | tail -n 60';
        }
        return execSync(cmd).toString();
    } catch(e) {
        return `Error leyendo logs: ${e.message}`;
    }
}

async function performAction(service, action) {
    try {
        if (action === 'restart') {
            switch(service) {
                case 'darkbot':
                    execSync('pkill -f DarkBot.jar 2>/dev/null || true');
                    execSync('sudo -u bombi DISPLAY=:10 nohup /home/bombi/Documents/darkbot/start-darkbot.sh > /home/bombi/Documents/darkbot/darkbot.log 2>&1 &');
                    return { success: true, message: 'DarkBot iniciado con Java 17 en la sesión gráfica KDE' };
                case 'pikabot':
                    execSync("pkill -f '[Pp]ika[Bb]ot.*\\.jar' 2>/dev/null || true");
                    execSync('sudo -u bombi DISPLAY=:10 nohup /home/bombi/Documents/Pikabot/start-pikabot.sh > /home/bombi/Documents/Pikabot/pikabot.log 2>&1 &');
                    return { success: true, message: 'Pikabot iniciado con Java 21 en la sesión gráfica KDE' };
                case 'preswin':
                    execSync('pm2 restart preswin');
                    return { success: true, message: 'PresWin reiniciado exitosamente en PM2' };
                case 'portfolio':
                    execSync('pm2 restart portfolio');
                    return { success: true, message: 'therodrigo.com (Portfolio) reiniciado en PM2' };
                case 'totimigracion':
                    execSync('systemctl restart totimigraciones.service');
                    return { success: true, message: 'totimigracion.es reiniciado en Systemd' };
                case 'cita-control':
                    execSync('systemctl restart cita-control.service');
                    return { success: true, message: 'Appointment Checker reiniciado en Systemd' };
                case 'nginx':
                    execSync('systemctl reload nginx');
                    return { success: true, message: 'Nginx recargado exitosamente' };
                case 'all':
                    execSync('pm2 restart all && systemctl reload nginx');
                    return { success: true, message: 'Todos los servicios Node y Nginx reiniciados' };
            }
        } else if (action === 'purge-mail-retention') {
            const out = execSync('/usr/local/bin/totimigracion-mail-retention.sh 2>&1').toString().trim();
            const lastLine = out.split('\n').pop() || 'Completado con éxito.';
            return { success: true, message: `Depuración (>30d) ejecutada: ${lastLine}` };
        } else if (action === 'status-mail-retention') {
            const out = execSync('systemctl list-timers totimigracion-mail-retention.timer --no-pager 2>&1').toString();
            return { success: true, message: out };
        } else if (action === 'test-nginx') {
            const out = execSync('nginx -t 2>&1').toString();
            return { success: true, message: out };
        } else if (action === 'flush-cache') {
            execSync('sync && echo 3 > /proc/sys/vm/drop_caches');
            return { success: true, message: 'Buffers y PageCache del kernel purgados' };
        } else if (action === 'renew-ssl') {
            const out = execSync('certbot renew --deploy-hook "systemctl reload nginx" 2>&1').toString().trim();
            if (out.includes('Congratulations') || out.includes('renewed')) {
                return { success: true, message: 'Certificados SSL renovados exitosamente y Nginx recargado.' };
            } else if (out.includes('not yet due')) {
                return { 
                    success: true, 
                    message: 'Certificados verificados: aún están vigentes (>30 días). Certbot los renovará automáticamente cuando queden menos de 30 días.' 
                };
            } else {
                const summary = out.split('\n').filter(l => l.trim() && !l.includes('Saving debug')).slice(-2).join(' ');
                return { success: true, message: summary || 'Certbot ejecutado con éxito.' };
            }
        } else if (action === 'force-renew-ssl') {
            execSync('certbot renew --force-renewal --deploy-hook "systemctl reload nginx" 2>&1');
            return { success: true, message: 'Renovación forzada completada para todos los dominios y Nginx recargado.' };
        }
        return { success: false, message: 'Acción no reconocida' };
    } catch (e) {
        return { success: false, message: `Error ejecutando ${action}: ${e.message}` };
    }
}

function getHtml() {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
        return fs.readFileSync(htmlPath, 'utf8');
    }
    return `<h1>Command Center Loading...</h1>`;
}

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(getHtml());
    }

    if (pathname === '/api/status') {
        const [metrics, projects, fleet, ssl] = await Promise.all([
            getSystemMetrics(),
            getProjectsStatus(),
            getFleetNodes(),
            getSslInfo()
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ metrics, projects, fleet, ssl, timestamp: Date.now() }));
    }

    if (pathname === '/api/logs') {
        const service = url.searchParams.get('service') || 'portfolio';
        const logs = getServiceLogs(service);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ service, logs, timestamp: Date.now() }));
    }

    if (pathname === '/api/action' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                const result = await performAction(data.service, data.action);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch(e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: e.message }));
            }
        });
        return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`VPS Command Center online on http://0.0.0.0:${PORT}`);
});
