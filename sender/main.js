const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, desktopCapturer, session } = require('electron');
const net = require('net');
const path = require('path');
const { MAX_CONTROL_BYTES } = require('../sharingguard');
const captureGuard = require('../captureguard');

const MIN_SDK_VERSION = 2;

let mainWindow = null;
let clientSocket = null;
let tray = null;
let receiverIp = '';

// ---- Parse share code back into ip:port ----
function parseCode(code) {
  if (typeof code !== 'string') return null;
  const cleaned = code.trim().toLowerCase();
  if (cleaned.length < 5 || cleaned.length > 40) return null;
  const parts = cleaned.split('-');
  if (parts.length !== 5) return null;

  const nums = [];
  for (const p of parts) {
    if (p.length < 1 || p.length > 4) return null;
    if (!/^[0-9a-f]+$/.test(p)) return null;
    const n = parseInt(p, 16);
    if (isNaN(n)) return null;
    nums.push(n);
  }

  const [ip1, ip2, ip3, ip4, port] = nums;
  if (ip1 > 255 || ip2 > 255 || ip3 > 255 || ip4 > 255) return null;
  if (port < 1 || port > 65535) return null;
  if (ip1 === 0 || ip1 === 127 || ip1 === 255 || ip1 >= 224) return null;
  if (ip2 > 255 || (ip1 === 169 && ip2 === 254)) return null;

  return {
    ip: `${ip1}.${ip2}.${ip3}.${ip4}`,
    port: port
  };
}

// ---- Connect handshake + info exchange ----
function parseStrictInt(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (value.length < 1 || value.length > 9) return null;
  let n = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return null;
    n = (n * 10) + code;
  }
  return n;
}

function connectToReceiver(ip, port, code) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let settled = false;
    let initiated = false;

    function fail(message) {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      reject(new Error(message));
    }

    socket.setTimeout(5000);

    socket.on('connect', () => {
      socket.write('AUTH:' + code + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      if (buffer.length > MAX_CONTROL_BYTES) {
        buffer = '';
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error('Receiver sent an oversize control frame'));
        } else {
          socket.destroy();
        }
        return;
      }
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (line === 'AUTH:OK' && !initiated) {
          initiated = true;
          socket.write('INIT\n');
        } else if (line.startsWith('STATUS:')) {
          const status = parseStrictInt(line.slice(7));
          if (status === null) {
            fail('Receiver sent a malformed status line');
            return;
          }
          if (status === 0) {
            socket.write('CONNECTED\n');
            // Request receiver info
            socket.write('INFO\n');
          } else {
            fail(`Connection rejected (status ${status})`);
            return;
          }
        } else if (line.startsWith('INFO:')) {
          // Parse INFO:sdk|version|os
          const infoStr = line.slice(5);
          const parts = infoStr.split('|');
          if (parts.length < 3) {
            fail('Receiver sent a malformed info line');
            return;
          }
          const sdk = parseStrictInt(parts[0]);
          const version = parts[1];
          const osName = parts[2];
          if (sdk === null) {
            fail('Receiver sent a non-numeric SDK version');
            return;
          }
          if (!/^[0-9A-Za-z._-]{1,32}$/.test(version) || !/^[0-9A-Za-z._-]{1,32}$/.test(osName)) {
            fail('Receiver sent a malformed version/os field');
            return;
          }
          if (sdk < MIN_SDK_VERSION) {
            fail(`SDK version too low (got ${sdk}, need >= ${MIN_SDK_VERSION})`);
            return;
          }
          if (!settled) {
            settled = true;
            clientSocket = socket;
            socket.setTimeout(0);
            resolve({ sdk, version, os: osName, ip: receiverIp });
          }
        } else if (line.startsWith('SIGNAL:')) {
          const sanitized = captureGuard.sanitizeSignal(line.slice(7));
          if (sanitized.ok && mainWindow) {
            mainWindow.webContents.send('rtc-signal', sanitized.payload);
          }
        }
      }
    });

    socket.on('error', (err) => {
      fail(String(err && err.message ? err.message : 'socket-error'));
    });

    socket.on('timeout', () => {
      fail('Connection timed out');
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        reject(new Error('Connection closed'));
      }
      clientSocket = null;
      if (mainWindow) {
        mainWindow.webContents.send('connection-status', false);
      }
    });

    socket.connect(port, ip);
  });
}

function disconnect() {
  const sock = clientSocket;
  clientSocket = null;
  if (!sock) return false;
  try { sock.end(); } catch (e) {}
  const timer = setTimeout(() => {
    try { sock.destroy(); } catch (e) {}
  }, 2000);
  if (typeof timer.unref === 'function') timer.unref();
  return true;
}

function sendStopShare() {
  if (!isWritable(clientSocket)) return false;
  try {
    clientSocket.write('STOP\n');
    return true;
  } catch (e) {
    return false;
  }
}

function isWritable(sock) {
  return !!sock && sock.destroyed !== true && sock.writable === true;
}

function sendSignal(payload) {
  if (!isWritable(clientSocket)) return false;
  if (typeof payload !== 'string') return false;
  if (payload.indexOf('\n') >= 0 || payload.indexOf('\r') >= 0) return false;
  const checked = captureGuard.sanitizeSignal(payload);
  if (!checked.ok) return false;
  try {
    clientSocket.write('SIGNAL:' + checked.payload + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

// ---- Tray ----
function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon);
  tray.setToolTip('Cosy 传屏 - 发送端');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '停止传屏',
      click: () => {
        sendStopShare();
        if (mainWindow) {
          mainWindow.webContents.send('stop-share-from-tray');
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    {
      label: '断开连接',
      click: () => {
        disconnect();
        if (mainWindow) {
          mainWindow.webContents.send('connection-status', false);
          mainWindow.show();
          mainWindow.focus();
        }
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        disconnect();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });
}

// ---- Window ----
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 560,
    height: 640,
    resizable: false,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#fafafa',
    icon: nativeImage.createFromPath(path.join(__dirname, 'icon.png')),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    disconnect();
    app.quit();
  });
}

// ---- IPC ----
ipcMain.on('connect', (event, code) => {
  const target = parseCode(code);
  if (!target) {
    event.reply('connect-result', { ok: false, error: 'Invalid code format' });
    return;
  }

  receiverIp = target.ip;

  connectToReceiver(target.ip, target.port, code)
    .then((info) => {
      event.reply('connect-result', { ok: true, info: info });
    })
    .catch((err) => {
      event.reply('connect-result', { ok: false, error: err.message });
    });
});

ipcMain.on('disconnect', () => {
  disconnect();
});

ipcMain.on('stop-share', () => {
  sendStopShare();
});

ipcMain.on('show-window', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

ipcMain.on('hide-to-tray', () => {
  if (mainWindow) {
    mainWindow.hide();
    if (tray) tray.displayBalloon({ title: 'Cosy 传屏', content: '正在传输画面' });
  }
});

ipcMain.on('exit-app', () => {
  disconnect();
  app.quit();
});

// WebRTC signaling: renderer -> main -> TCP -> receiver
ipcMain.on('rtc-signal', (event, payload) => {
  if (typeof payload !== 'string' || payload.length === 0 || payload.length > MAX_CONTROL_BYTES) {
    event.reply('signal-result', { ok: false, error: 'Invalid signal payload' });
    return;
  }
  sendSignal(payload);
});

// Screen source: provide desktop capturer source ID to renderer
ipcMain.handle('get-screen-source', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  if (sources.length > 0) {
    return sources[0].id;
  }
  return null;
});

// Window sources: list all available windows for window sharing
ipcMain.handle('get-window-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    return sources.slice(0, 20).map((s) => ({
      id: s.id,
      name: s.name.slice(0, 120),
      thumbnail: s.thumbnail.toDataURL(),
      icon: s.appIcon ? s.appIcon.toDataURL() : null
    }));
  } catch (e) {
    return [];
  }
});

// ---- App lifecycle ----
app.whenReady().then(() => {
  // Allow media (screen capture) permissions in packaged app
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = webContents && webContents.getURL ? webContents.getURL() : '';
    if (permission === 'media' && origin.startsWith('file://')) {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const origin = webContents && webContents.getURL ? webContents.getURL() : '';
    return permission === 'media' && origin.startsWith('file://');
  });

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  app.quit();
});
