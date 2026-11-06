const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, desktopCapturer, session } = require('electron');
const net = require('net');
const path = require('path');

const MIN_SDK_VERSION = 2;

let mainWindow = null;
let clientSocket = null;
let tray = null;
let receiverIp = '';

// ---- Parse share code back into ip:port ----
function parseCode(code) {
  const cleaned = code.trim().toLowerCase();
  const parts = cleaned.split('-');
  if (parts.length !== 5) return null;

  const nums = [];
  for (const p of parts) {
    if (!/^[0-9a-f]+$/.test(p)) return null;
    const n = parseInt(p, 16);
    if (isNaN(n)) return null;
    nums.push(n);
  }

  const [ip1, ip2, ip3, ip4, port] = nums;
  if (ip1 > 255 || ip2 > 255 || ip3 > 255 || ip4 > 255) return null;
  if (port < 1 || port > 65535) return null;

  return {
    ip: `${ip1}.${ip2}.${ip3}.${ip4}`,
    port: port
  };
}

// ---- Connect handshake + info exchange ----
function connectToReceiver(ip, port) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let settled = false;

    socket.setTimeout(5000);

    socket.on('connect', () => {
      socket.write('INIT\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);

        if (line.startsWith('STATUS:')) {
          const status = parseInt(line.slice(7), 10);
          if (status === 0) {
            socket.write('CONNECTED\n');
            // Request receiver info
            socket.write('INFO\n');
          } else {
            if (!settled) {
              settled = true;
              socket.destroy();
              reject(new Error(`Connection rejected (status ${status})`));
            }
          }
        } else if (line.startsWith('INFO:')) {
          // Parse INFO:sdk|version|os
          const infoStr = line.slice(5);
          const parts = infoStr.split('|');
          if (parts.length >= 3) {
            const sdk = parseInt(parts[0], 10);
            const version = parts[1];
            const osName = parts[2];

            if (sdk < MIN_SDK_VERSION) {
              if (!settled) {
                settled = true;
                socket.destroy();
                reject(new Error(`SDK version too low (got ${sdk}, need >= ${MIN_SDK_VERSION})`));
              }
              return;
            }

            if (!settled) {
              settled = true;
              clientSocket = socket;
              socket.setTimeout(0);
              resolve({ sdk, version, os: osName, ip: receiverIp });
            }
          }
        } else if (line.startsWith('SIGNAL:')) {
          const payload = line.slice(7);
          if (mainWindow) {
            mainWindow.webContents.send('rtc-signal', payload);
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });

    socket.on('timeout', () => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error('Connection timed out'));
      }
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
  if (clientSocket) {
    try { clientSocket.end(); } catch (e) {}
    clientSocket = null;
  }
}

function sendStopShare() {
  if (clientSocket) {
    try { clientSocket.write('STOP\n'); } catch (e) {}
  }
}

function sendSignal(payload) {
  if (clientSocket) {
    clientSocket.write('SIGNAL:' + payload + '\n');
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

  connectToReceiver(target.ip, target.port)
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
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
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
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'media') {
      return true;
    }
    return false;
  });

  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => {
  app.quit();
});
