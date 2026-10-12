# VPS Projects Command Center 🚀

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Runtime: Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-green.svg)
![OS: Linux / Debian](https://img.shields.io/badge/OS-Linux%20Debian-red.svg)
![Platform: systemd & PM2](https://img.shields.io/badge/Fleet-systemd%20%7C%20PM2-blue.svg)

Production VPS Fleet Monitor, Service Supervisor, and HUD Dashboard for managing Debian Linux server workloads, systemd daemons, and PM2 Node.js instances in real time.

---

## Features

- **Live Host Telemetry**: Real-time CPU load, memory utilization, swap usage, disk capacity, network bandwidth, and system uptime.
- **Service Supervision**: Integrated management for both **systemd** services (`systemctl status/restart`) and **PM2** processes (`pm2 status/restart`).
- **HTTP Health Probing**: Automatic HTTP status code and latency health checks across all locally hosted web apps and reverse proxies.
- **Dual Interface**:
  - **Web Dashboard**: Modern dark-mode interface (`http://localhost:9090`) with real-time SSE / polling metrics, quick restart triggers, and log viewers.
  - **CLI HUD**: Interactive color terminal status dashboard (`./command-center`) for terminal sessions and SSH logins.
- **Desktop Integration**: Includes `.desktop` shortcuts ready for Linux desktop environments (XFCE, KDE Plasma, GNOME, etc.).
- **Zero Heavy Dependencies**: Server backend written entirely with Node.js built-in modules (`http`, `child_process`, `fs`, `os`).

---

## Directory Layout

```
vps-command-center/
├── server.js                   # Lightweight Node.js HTTP server and management API
├── command-center              # Interactive terminal CLI HUD monitor (Bash)
├── public/
│   └── index.html              # Responsive dark-mode fleet monitor UI
├── vps-command-center.service  # systemd service definition file
├── *.desktop                   # Linux desktop entry shortcuts
├── LICENSE                     # MIT License
└── README.md                   # Project documentation
```

---

## Quick Start

### 1. Run the Terminal HUD
```bash
chmod +x command-center
./command-center
```

### 2. Run the Web Dashboard
```bash
# Start manually
node server.js

# Or manage with PM2
pm2 start server.js --name vps-command-center

# Or install as a systemd service
sudo cp vps-command-center.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vps-command-center
```

The web dashboard is served on port `9090` by default.

---

## License & Copyright

Copyright (c) 2026 Luis Rodrigo García Hernández.  
Released under the [MIT License](LICENSE).
