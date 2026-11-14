const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const dgram = require('dgram');
const net = require('net');
const path = require('path');
const os = require('os');
const guard = require('../sharingguard');
const captureGuard = require('../captureguard');
const signalingGuard = require('../signalingguard');

const TCP_PORT = 25555;
const TCP_PORT_MAX = 25565;
const SOCKET_IDLE_MS = 45000;
const AUTH_DEADLINE_MS = 10000;
const MAX_PENDING_SIGNALS = 32;
const MAX_PENDING_SIGNAL_BYTES = 64 * 1024;
const MAX_SESSIONS = 4;
const DISCOVERY_PORT = 30001;
const DISPLAY_WINDOW_TITLE = 'OpenCosyScreenShareDisplay';
const SDK_VERSION = 3;
const APP_VERSION = '1.0.0';

let mainWindow = null;
let displayWindow = null;
let displayWindowReady = false;
let pendingSignals = [];
let pendingSignalBytes = 0;let tcpServer = null;
let activeSocket = null;
let liveSessions = 0;
let shareCode = '';
let localIp = '';

// ---- UDP discovery: get local LAN IP via broadcast ----
function discoverLocalIp() {
  return new Promise((resolve) => {
    let resolved = false;
    const socket = dgram.createSocket('udp4');

    const finish = (ip) => {
      if (resolved) return;
      resolved = true;
      try { socket.close(); } catch (e) {}
      resolve(ip);
    };

    socket.on('message', (msg, rinfo) => {
      if (msg.toString() === 'COSY_DISCOVER' && rinfo.address && !rinfo.address.startsWith('127.')) {
        finish(rinfo.address);
      }
    });

    socket.on('error', () => {
      finish(getFallbackIp());
    });

    socket.bind(0, () => {
      socket.setBroadcast(true);
      const msg = Buffer.from('COSY_DISCOVER');
      socket.send(msg, 0, msg.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) finish(getFallbackIp());
      });
    });

    setTimeout(() => finish(getFallbackIp()), 1500);
  });
}

function getFallbackIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// ---- Code generation ----
function generateCode(ip, port) {
  const parts = String(ip || '').split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4) return '';
  for (const n of parts) {
    if (!Number.isInteger(n) || n < 0 || n > 255) return '';
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  const hex = (n) => n.toString(16);
  return [
    hex(parts[0]),
    hex(parts[1]),
    hex(parts[2]),
    hex(parts[3]),
    hex(port)
  ].join('-');
}

// ---- TCP server: handle handshake + signaling ----
function isLocalPeer(peer) {
  if (!peer) return false;
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (guard.sameSubnet(peer, iface.address, 0)) return true;
    }
  }
  return false;
}

function rejectCtx(ctx) {
  ctx.failed = true;
  ctx.buffer = '';
  try { ctx.socket.destroy(); } catch (e) {}
}

function dispatchLine(line, ctx, peer) {
  if (ctx.failed) return;
  if (line.length > guard.MAX_CONTROL_BYTES) {
    rejectCtx(ctx);
    return;
  }
  if (!ctx.admitted) {
    if (!line.startsWith('AUTH:')) {
      guard.noteFailure(ctx.state, Date.now());
      rejectCtx(ctx);
      return;
    }
    if (!isLocalPeer(peer)) {
      rejectCtx(ctx);
      return;
    }
    const admitted = guard.admitConnection(peer, localIp, shareCode, line.slice(5), ctx.state);
    if (!admitted.ok) {
      rejectCtx(ctx);
      return;
    }
    if (activeSocket && activeSocket !== ctx.socket) {
      rejectCtx(ctx);
      return;
    }
    ctx.admitted = true;
    activeSocket = ctx.socket;
    ctx.socket.write('AUTH:OK\n');
    return;
  }
  const allowed = guard.admitMessage(ctx.state, Date.now(), guard.FRAME_KIND.CONTROL);
  if (!allowed.ok) {
    rejectCtx(ctx);
    return;
  }
  const frame = guard.validateFrame({ kind: guard.FRAME_KIND.CONTROL }, line.length);
  if (!frame.ok) {
    rejectCtx(ctx);
    return;
  }
  handleMessage(line, ctx.socket);
}

function startTcpServer(ip) {
  localIp = ip;
  let currentPort = TCP_PORT;

  function tryListen() {
    tcpServer = net.createServer((socket) => {
      const peer = String(socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (liveSessions >= MAX_SESSIONS) {
        try { socket.destroy(); } catch (e) {}
        return;
      }
      liveSessions += 1;
      socket.once('close', () => { liveSessions = Math.max(0, liveSessions - 1); });
      const ctx = {
        socket,
        peer,
        state: guard.createSessionState(Date.now()),
        admitted: false,
        failed: false,
        buffer: ''
      };

      socket.setTimeout(SOCKET_IDLE_MS);
      socket.on('timeout', () => {
        ctx.failed = true;
        try { socket.destroy(); } catch (e) {}
      });

      const authTimer = setTimeout(() => {
        if (!ctx.admitted) {
          ctx.failed = true;
          try { socket.destroy(); } catch (e) {}
        }
      }, AUTH_DEADLINE_MS);
      if (typeof authTimer.unref === 'function') authTimer.unref();

      socket.on('data', (data) => {
        if (ctx.failed) return;
        ctx.buffer += data.toString();
        if (ctx.buffer.length > guard.MAX_CONTROL_BYTES) {
          ctx.failed = true;
          try { socket.destroy(); } catch (e) {}
          return;
        }
        let idx;
        while (!ctx.failed && (idx = ctx.buffer.indexOf('\n')) !== -1) {
          const line = ctx.buffer.slice(0, idx).trim();
          ctx.buffer = ctx.buffer.slice(idx + 1);
          dispatchLine(line, ctx, peer);
        }
      });

      socket.on('close', () => {
        clearTimeout(authTimer);
        releaseIfActive(socket);
      });

      socket.on('error', () => {
        clearTimeout(authTimer);
        releaseIfActive(socket);
      });
    });

    tcpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && currentPort < TCP_PORT_MAX) {
        try { tcpServer.close(); } catch (e) {}
        currentPort++;
        tryListen();
        return;
      }
      if (mainWindow) {
        mainWindow.webContents.send('server-error', String(err.code || err.message || 'listen-failed'));
      }
    });

    tcpServer.listen(currentPort, ip, () => {
      shareCode = generateCode(ip, currentPort);
      if (mainWindow) {
        mainWindow.webContents.send('code-ready', shareCode);
      }
    });
  }

  tryListen();
}

const signalLimiter = signalingGuard.createRateLimiter({ capacity: 40, refillPerSecond: 16 });

function handleMessage(line, socket) {
  if (line === 'INIT') {
    socket.write('STATUS:0\n');
  } else if (line === 'INFO') {
    const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform;
    socket.write(`INFO:${SDK_VERSION}|${APP_VERSION}|${osName}\n`);
  } else if (line === 'CONNECTED') {
    openDisplayWindow();
    if (mainWindow) {
      mainWindow.hide();
      mainWindow.webContents.send('connection-status', true);
    }
  } else if (line === 'STOP') {
    // Sender stopped sharing but keeps connection alive -> return to waiting page
    handleStopShare();
  } else if (line.startsWith('SIGNAL:')) {
    const budget = signalLimiter.take(Date.now());
    if (!budget.ok) {
      socket.write('ERROR:SIGNAL-RATE\n');
      return;
    }
    const rawPayload = line.slice(7);
    if (rawPayload.length === 0 || rawPayload.length > MAX_PENDING_SIGNAL_BYTES) {
      return;
    }
    const sanitized = captureGuard.sanitizeSignal(rawPayload);
    if (!sanitized.ok) {
      return;
    }
    const payload = sanitized.payload;
    if (!displayWindow) {
      // Display window was closed (e.g. after STOP) -> re-open for new share
      openDisplayWindow();
      if (mainWindow) mainWindow.hide();
    }
    if (displayWindowReady && displayWindow) {
      displayWindow.webContents.send('rtc-signal', payload);
    } else {
      // Queue messages until display window is ready
      while (pendingSignals.length &&
             (pendingSignals.length >= MAX_PENDING_SIGNALS ||
              pendingSignalBytes + payload.length > MAX_PENDING_SIGNAL_BYTES)) {
        pendingSignalBytes -= pendingSignals[0].length;
        pendingSignals.shift();
      }
      if (payload.length <= MAX_PENDING_SIGNAL_BYTES) {
        pendingSignals.push(payload);
        pendingSignalBytes += payload.length;
      }
    }
  }
}

function releaseIfActive(socket) {
  if (activeSocket !== socket) return;
  activeSocket = null;
  handleDisconnect();
}

function handleStopShare() {
  if (displayWindow) {
    displayWindow.close();
    displayWindow = null;
  }
  displayWindowReady = false;
  pendingSignals = [];
  pendingSignalBytes = 0;
  if (mainWindow) {
    mainWindow.show();
    mainWindow.setFullScreen(true);
    // Keep connection-status true (still connected, just not sharing)
  }
}

function handleDisconnect() {
  if (displayWindow) {
    displayWindow.close();
    displayWindow = null;
  }
  if (mainWindow) {
    mainWindow.show();
    mainWindow.setFullScreen(true);
    mainWindow.webContents.send('connection-status', false);
  }
}

function sendSignal(payload) {
  const socket = activeSocket;
  if (!socket || socket.destroyed === true || socket.writable !== true) return false;
  if (typeof payload !== 'string') return false;
  if (payload.indexOf('\n') >= 0 || payload.indexOf('\r') >= 0) return false;
  try {
    socket.write('SIGNAL:' + payload + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Windows ----
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    fullscreen: true,
    autoHideMenuBar: true,
    backgroundColor: '#fafafa',
    icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.setFullScreen(true);

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (activeSocket) { try { activeSocket.end(); } catch (e) {} }
    if (tcpServer) { try { tcpServer.close(); } catch (e) {} }
    app.quit();
  });
}

function openDisplayWindow() {
  displayWindowReady = false;
  pendingSignals = [];
  pendingSignalBytes = 0;
  displayWindow = new BrowserWindow({
    fullscreen: true,
    autoHideMenuBar: true,
    title: DISPLAY_WINDOW_TITLE,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  displayWindow.loadFile(path.join(__dirname, 'display.html'));
  displayWindow.setFullScreen(true);

  // Flush queued signals once the display window is ready
  displayWindow.webContents.on('did-finish-load', () => {
    displayWindowReady = true;
    for (const payload of pendingSignals) {
      displayWindow.webContents.send('rtc-signal', payload);
    }
    pendingSignals = [];
  pendingSignalBytes = 0;
  });

  displayWindow.on('closed', () => {
    displayWindow = null;
    displayWindowReady = false;
  });
}

// ---- IPC ----
ipcMain.on('exit-app', () => {
  if (activeSocket) { try { activeSocket.end(); } catch (e) {} }
  if (tcpServer) { try { tcpServer.close(); } catch (e) {} }
  app.quit();
});

// WebRTC signaling: display window -> main -> TCP -> sender
ipcMain.on('signal-rejected', (event, reason) => {
  if (activeSocket && activeSocket.writable) {
    const label = typeof reason === 'string' ? reason.slice(0, 64) : 'unknown';
    activeSocket.write('ERROR:SIGNAL-REJECTED:' + label + '\n');
  }
});

ipcMain.on('rtc-signal', (event, payload) => {
  sendSignal(payload);
});

// ---- App lifecycle ----
app.whenReady().then(async () => {
  createMainWindow();
  const ip = await discoverLocalIp();
  startTcpServer(ip);
});

app.on('window-all-closed', () => {
  if (tcpServer) { try { tcpServer.close(); } catch (e) {} }
  app.quit();
});
