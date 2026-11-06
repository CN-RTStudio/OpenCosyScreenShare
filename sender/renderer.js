const { ipcRenderer } = require('electron');

const codeInput = document.getElementById('codeInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const disconnectBtn2 = document.getElementById('disconnectBtn2');
const shareBtn = document.getElementById('shareBtn');
const windowShareBtn = document.getElementById('windowShareBtn');
const stopShareBtn = document.getElementById('stopShareBtn');
const exitBtn = document.getElementById('exitBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

const connectView = document.querySelector('.container:not(.hidden)');
const infoView = document.getElementById('infoView');
const windowPickerView = document.getElementById('windowPickerView');
const windowGrid = document.getElementById('windowGrid');
const pickerBackBtn = document.getElementById('pickerBackBtn');
const pickerShareBtn = document.getElementById('pickerShareBtn');

const receiverVersion = document.getElementById('receiverVersion');
const receiverOs = document.getElementById('receiverOs');
const receiverIp = document.getElementById('receiverIp');

let pc = null;
let localStream = null;
let sharing = false;
let selectedWindowSourceId = null;

function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state) statusDot.classList.add(state);
  statusText.textContent = text;
}

function showConnectView() {
  infoView.classList.add('hidden');
  windowPickerView.classList.add('hidden');
  connectView.classList.remove('hidden');
}

function showInfoView() {
  connectView.classList.add('hidden');
  windowPickerView.classList.add('hidden');
  infoView.classList.remove('hidden');
}

function showWindowPickerView() {
  infoView.classList.add('hidden');
  windowPickerView.classList.remove('hidden');
}

// ---- WebRTC ----
async function startScreenShare(sourceIdOverride) {
  if (sharing) return;
  sharing = true;

  let sourceId = sourceIdOverride;
  if (!sourceId) {
    sourceId = await ipcRenderer.invoke('get-screen-source');
    if (!sourceId) {
      setStatus('error', '无法获取屏幕源');
      sharing = false;
      return;
    }
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop'
        }
      },
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 30
        }
      }
    });
  } catch (e) {
    // Retry without audio (system audio may not be available)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: 30
          }
        }
      });
    } catch (e2) {
      setStatus('error', '屏幕捕获失败');
      sharing = false;
      return;
    }
  }

  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Add local tracks
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
    // Detect track end (e.g. captured window closed) -> auto stop
    track.onended = () => {
      if (sharing) {
        stopScreenShare();
        showInfoView();
        ipcRenderer.send('show-window');
      }
    };
  });

  // Send ICE candidates to receiver via signaling
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const payload = Buffer.from(JSON.stringify({
        type: 'ice',
        candidate: event.candidate
      })).toString('base64');
      ipcRenderer.send('rtc-signal', payload);
    }
  };

  // Create offer and send to receiver
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const offerPayload = Buffer.from(JSON.stringify({
    type: 'offer',
    sdp: offer.sdp
  })).toString('base64');
  ipcRenderer.send('rtc-signal', offerPayload);

  // Show stop button, hide share buttons
  shareBtn.disabled = true;
  shareBtn.textContent = '屏幕投屏';
  windowShareBtn.disabled = true;
  windowShareBtn.textContent = '窗口投屏';
  stopShareBtn.classList.remove('hidden');

  // Hide to tray after starting share
  ipcRenderer.send('hide-to-tray');
}

function handleSignal(payload) {
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch (e) {
    return;
  }

  if (!pc) return;

  if (data.type === 'answer') {
    pc.setRemoteDescription({ type: 'answer', sdp: data.sdp });
  } else if (data.type === 'ice') {
    if (data.candidate) {
      pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }
}

function stopScreenShare() {
  if (!sharing && !pc && !localStream) return;
  if (pc) {
    pc.close();
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    localStream = null;
  }
  sharing = false;
  // Notify receiver to return to waiting page (keep TCP connection alive)
  ipcRenderer.send('stop-share');
  // Hide stop button, restore share buttons
  stopShareBtn.classList.add('hidden');
  shareBtn.disabled = false;
  shareBtn.textContent = '屏幕投屏';
  windowShareBtn.disabled = false;
  windowShareBtn.textContent = '窗口投屏';
  selectedWindowSourceId = null;
  pickerShareBtn.disabled = true;
  pickerShareBtn.textContent = '开始投屏';
}

function doDisconnect() {
  stopScreenShare();
  ipcRenderer.send('disconnect');
  showConnectView();
  setStatus('', '未连接');
  connectBtn.classList.remove('hidden');
  disconnectBtn.classList.add('hidden');
  connectBtn.disabled = false;
  codeInput.disabled = false;
  selectedWindowSourceId = null;
  stopShareBtn.classList.add('hidden');
  pickerShareBtn.disabled = true;
  pickerShareBtn.textContent = '开始投屏';
  shareBtn.disabled = false;
  shareBtn.textContent = '屏幕投屏';
  windowShareBtn.disabled = false;
  windowShareBtn.textContent = '窗口投屏';
}

// ---- UI events ----
connectBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!code) {
    setStatus('error', '请输入传屏码');
    return;
  }

  connectBtn.disabled = true;
  setStatus('connecting', '正在连接...');

  ipcRenderer.send('connect', code);
});

shareBtn.addEventListener('click', () => {
  shareBtn.disabled = true;
  shareBtn.textContent = '正在传输...';
  windowShareBtn.disabled = true;
  startScreenShare();
});

windowShareBtn.addEventListener('click', async () => {
  shareBtn.disabled = true;
  windowShareBtn.disabled = true;
  windowShareBtn.textContent = '加载中...';
  try {
    await loadWindowList();
  } catch (e) {}
  windowShareBtn.textContent = '窗口投屏';
  windowShareBtn.disabled = false;
  shareBtn.disabled = false;
  showWindowPickerView();
});

pickerBackBtn.addEventListener('click', () => {
  selectedWindowSourceId = null;
  pickerShareBtn.disabled = true;
  document.querySelectorAll('.window-card').forEach((c) => c.classList.remove('selected'));
  showInfoView();
});

pickerShareBtn.addEventListener('click', () => {
  if (!selectedWindowSourceId) return;
  pickerShareBtn.disabled = true;
  pickerShareBtn.textContent = '正在传输...';
  startScreenShare(selectedWindowSourceId);
});

async function loadWindowList() {
  windowGrid.innerHTML = '<div class="picker-empty">正在获取窗口列表...</div>';
  selectedWindowSourceId = null;
  pickerShareBtn.disabled = true;
  try {
    const sources = await ipcRenderer.invoke('get-window-sources');
    if (!sources || sources.length === 0) {
      windowGrid.innerHTML = '<div class="picker-empty">没有可用窗口</div>';
      return;
    }
    windowGrid.innerHTML = '';
    sources.forEach((src) => {
      const card = document.createElement('div');
      card.className = 'window-card';
      card.dataset.sourceId = src.id;
      const img = document.createElement('img');
      img.src = src.thumbnail;
      img.alt = src.name;
      img.loading = 'lazy';
      const name = document.createElement('div');
      name.className = 'window-name';
      name.textContent = src.name;
      card.appendChild(img);
      card.appendChild(name);
      card.addEventListener('click', () => {
        document.querySelectorAll('.window-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedWindowSourceId = src.id;
        pickerShareBtn.disabled = false;
      });
      windowGrid.appendChild(card);
    });
  } catch (e) {
    windowGrid.innerHTML = '<div class="picker-empty">获取窗口列表失败</div>';
  }
}

disconnectBtn.addEventListener('click', doDisconnect);
disconnectBtn2.addEventListener('click', doDisconnect);

stopShareBtn.addEventListener('click', () => {
  stopScreenShare();
  showInfoView();
  ipcRenderer.send('show-window');
});

exitBtn.addEventListener('click', () => {
  stopScreenShare();
  ipcRenderer.send('exit-app');
});

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    connectBtn.click();
  }
});

// ---- IPC events ----
ipcRenderer.on('connect-result', (event, result) => {
  if (result.ok) {
    // Show info view with receiver details
    const info = result.info || {};
    receiverVersion.textContent = info.version || '-';
    receiverOs.textContent = info.os || '-';
    receiverIp.textContent = info.ip || '-';
    showInfoView();
    shareBtn.disabled = false;
    shareBtn.textContent = '屏幕投屏';
    windowShareBtn.disabled = false;
    windowShareBtn.textContent = '窗口投屏';
  } else {
    setStatus('error', result.error || '连接失败');
    connectBtn.disabled = false;
  }
});

ipcRenderer.on('connection-status', (event, connected) => {
  if (!connected) {
    stopScreenShare();
    showConnectView();
    setStatus('', '已断开');
    connectBtn.classList.remove('hidden');
    disconnectBtn.classList.add('hidden');
    connectBtn.disabled = false;
    codeInput.disabled = false;
    shareBtn.disabled = false;
    shareBtn.textContent = '屏幕投屏';
    windowShareBtn.disabled = false;
    windowShareBtn.textContent = '窗口投屏';
    selectedWindowSourceId = null;
    pickerShareBtn.disabled = true;
    pickerShareBtn.textContent = '开始投屏';
    ipcRenderer.send('show-window');
  }
});

ipcRenderer.on('rtc-signal', (event, payload) => {
  handleSignal(payload);
});

ipcRenderer.on('stop-share-from-tray', () => {
  stopScreenShare();
  showInfoView();
});

// When window is shown (from tray), if currently in window-picker view, go back to infoView
ipcRenderer.on('show-window', () => {
  if (!windowPickerView.classList.contains('hidden')) {
    selectedWindowSourceId = null;
    pickerShareBtn.disabled = true;
    document.querySelectorAll('.window-card').forEach((c) => c.classList.remove('selected'));
    showInfoView();
  }
});
