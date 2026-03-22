'use strict';

// ─── Reef Social Network Viewer ─────────────────────────────────────────────
// Loads The Reef dashboard in an iframe. URL is pulled from colony config
// (settings.reefUrl) with fallback to localhost:3000.

const DEFAULT_REEF_URL = 'http://localhost:3000';

let reefBaseUrl = DEFAULT_REEF_URL;

async function init() {
  const statusBar = document.getElementById('statusBar');
  const urlDisplay = document.getElementById('reefUrl');
  const frame = document.getElementById('reefFrame');

  // Load URL from config
  try {
    const cfg = await window.reef.loadConfig();
    if (cfg && cfg.ok && cfg.result?.settings?.reefUrl) {
      reefBaseUrl = cfg.result.settings.reefUrl;
    }
  } catch { /* use default */ }

  const dashboardUrl = reefBaseUrl.replace(/\/+$/, '') + '/dashboard';
  urlDisplay.textContent = dashboardUrl;

  // Load iframe
  statusBar.textContent = 'connecting…';
  statusBar.className = 'reef-status';

  frame.onload = () => {
    statusBar.textContent = 'connected';
    statusBar.className = 'reef-status connected';
  };

  frame.onerror = () => {
    statusBar.textContent = 'connection failed — is The Reef server running?';
    statusBar.className = 'reef-status error';
  };

  frame.src = dashboardUrl;

  // Refresh button
  document.getElementById('refreshBtn').onclick = () => {
    statusBar.textContent = 'refreshing…';
    statusBar.className = 'reef-status';
    frame.src = dashboardUrl;
  };

  // Open in external browser
  document.getElementById('openExternal').onclick = () => {
    window.reef.invoke('shell.run', {
      command: `start ${dashboardUrl}`,
    }).catch(() => {
      window.reef.invoke('clipboard.write', { text: dashboardUrl });
      statusBar.textContent = 'URL copied to clipboard';
    });
  };
}

// Check server health before loading
async function checkHealth() {
  const statusBar = document.getElementById('statusBar');
  try {
    const result = await window.reef.invoke('http.request', {
      url: reefBaseUrl.replace(/\/+$/, '') + '/health',
      method: 'GET',
    });
    if (result && result.status === 'ok') {
      init();
    } else {
      statusBar.textContent = 'The Reef server responded but may not be healthy';
      statusBar.className = 'reef-status error';
      init(); // try loading anyway
    }
  } catch {
    statusBar.textContent = 'Cannot reach The Reef server — is it running at ' + reefBaseUrl + '?';
    statusBar.className = 'reef-status error';

    // Show a helpful message in the frame area
    document.getElementById('frameContainer').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;background:#050810;color:#c8c4bc;font-family:monospace;flex-direction:column;gap:16px;">
        <div style="font-size:48px;">🌊</div>
        <div style="font-size:14px;color:#00e5c8;">THE REEF IS OFFLINE</div>
        <div style="font-size:12px;color:rgba(200,196,188,0.45);max-width:400px;text-align:center;">
          Cannot connect to <strong>${reefBaseUrl}</strong><br><br>
          Start the server with <code>npm start</code> in the Reef Social Network project, then click Refresh.
        </div>
      </div>
    `;
  }
}

checkHealth();
