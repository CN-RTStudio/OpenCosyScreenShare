const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const dgram = require('dgram');
const net = require('net');
const path = require('path');
const os = require('os');

const TCP_PORT = 25555;
const TCP_PORT_MAX = 25565;
const DISCOVERY_PORT = 30001;
const DISPLAY_WINDOW_TITLE = 'OpenCosyScreenShareDisplay';
const SDK_VERSION = 3;
const APP_VERSION = '1.0.0';

let mainWindow = null;
let displayWindow = null;
let displayWindowReady = false;
let pendingSignals = [];
let tcpServer = null;
let activeSocket = null;
let shareCode = '';

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
  const parts = ip.split('.').map((p) => parseInt(p, 10));
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
function startTcpServer(ip) {
  let currentPort = TCP_PORT;

  function tryListen() {
    tcpServer = net.createServer((socket) => {
      if (activeSocket) {
        socket.end();
        return;
      }
      activeSocket = socket;
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          handleMessage(line, socket);
        }
      });

      socket.on('close', () => {
        activeSocket = null;
        handleDisconnect();
      });

      socket.on('error', () => {
        activeSocket = null;
        handleDisconnect();
      });
    });

    tcpServer.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && currentPort < TCP_PORT_MAX) {
        currentPort++;
        tryListen();
      }
    });

    tcpServer.listen(currentPort, '0.0.0.0', () => {
      shareCode = generateCode(ip, currentPort);
      if (mainWindow) {
        mainWindow.webContents.send('code-ready', shareCode);
      }
    });
  }

  tryListen();
}

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
    // Forward WebRTC signaling to display window
    const payload = line.slice(7);
    if (!displayWindow) {
      // Display window was closed (e.g. after STOP) -> re-open for new share
      openDisplayWindow();
      if (mainWindow) mainWindow.hide();
    }
    if (displayWindowReady && displayWindow) {
      displayWindow.webContents.send('rtc-signal', payload);
    } else {
      // Queue messages until display window is ready
      pendingSignals.push(payload);
    }
  }
}

function handleStopShare() {
  if (displayWindow) {
    displayWindow.close();
    displayWindow = null;
  }
  displayWindowReady = false;
  pendingSignals = [];
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
  if (activeSocket) {
    activeSocket.write('SIGNAL:' + payload + '\n');
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
