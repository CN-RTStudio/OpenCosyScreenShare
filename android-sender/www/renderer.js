window._cosyLog('renderer.js 开始执行');

let CosyNetwork;
try {
  window._cosyLog('Capacitor 类型: ' + typeof Capacitor);
  window._cosyLog('Capacitor.Plugins: ' + JSON.stringify(Object.keys(Capacitor.Plugins || {})));
  CosyNetwork = Capacitor.Plugins.CosyNetwork;
  if (CosyNetwork) {
    window._cosyLog('插件获取成功');
  } else {
    window._cosyLog('插件不存在于 Capacitor.Plugins');
  }
} catch (e) {
  window._cosyLog('插件获取失败: ' + e.message);
}

const codeInput = document.getElementById('codeInput');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const disconnectBtn2 = document.getElementById('disconnectBtn2');
const shareBtn = document.getElementById('shareBtn');
const stopShareBtn = document.getElementById('stopShareBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const srcScreenBtn = document.getElementById('srcScreenBtn');
const srcCameraBtn = document.getElementById('srcCameraBtn');

const connectView = document.getElementById('connectView');
const infoView = document.getElementById('infoView');

const receiverVersion = document.getElementById('receiverVersion');
const receiverOs = document.getElementById('receiverOs');
const receiverIp = document.getElementById('receiverIp');

let pc = null;
let localStream = null;
let sharing = false;
let connected = false;
// 传屏源: 'screen' (默认屏幕投射) | 'camera' (摄像头)
let captureSource = 'screen';

function log(msg) {
  window._cosyLog(msg);
}

log('脚本加载完成');

// ---- Status ----
function setStatus(state, text) {
  statusDot.className = 'status-dot';
  if (state) statusDot.classList.add(state);
  statusText.textContent = text;
}

// ---- View switching ----
function showConnectView() {
  infoView.classList.add('hidden');
  connectView.classList.remove('hidden');
}

function showInfoView() {
  connectView.classList.add('hidden');
  infoView.classList.remove('hidden');
}

// ---- WebRTC ----
function createPeerConnection() {
  log('创建 RTCPeerConnection');
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const payload = btoa(JSON.stringify({
        type: 'ice',
        candidate: event.candidate
      }));
      CosyNetwork.sendSignal({ payload: payload });
    }
  };

  pc.onconnectionstatechange = () => {
    log('WebRTC 状态: ' + pc.connectionState);
  };
}

async function startScreenShare() {
  if (sharing) return;
  sharing = true;
  shareBtn.disabled = true;
  shareBtn.textContent = '正在启动...';

  if (captureSource === 'screen') {
    // 屏幕投射模式 → 调用原生 WebRTC (ScreenCapturerAndroid)
    // Android WebView 不支持 getDisplayMedia, 必须使用原生 MediaProjection
    try {
      log('调用原生 startScreenShare');
      const ret = await CosyNetwork.startScreenShare();
      log('原生 startScreenShare 已启动: ' + JSON.stringify(ret));
      setStatus('connected', '正在传输');
      shareBtn.classList.add('hidden');
      stopShareBtn.classList.remove('hidden');
    } catch (e) {
      const msg = (e && e.message) ? e.message : JSON.stringify(e);
      log('原生 startScreenShare 失败: ' + msg);
      setStatus('error', '屏幕投射失败: ' + msg);
      sharing = false;
      shareBtn.disabled = false;
      shareBtn.textContent = '传屏';
    }
    return;
  }

  // 摄像头模式 → 使用 JS WebRTC (getUserMedia)
  try {
    log('尝试 getUserMedia (摄像头)');
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', frameRate: { ideal: 30, max: 30 } },
      audio: true
    });
    log('getUserMedia (摄像头) 成功');
  } catch (e2) {
    // 再试仅视频
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false
      });
      log('getUserMedia (仅视频) 成功');
    } catch (e3) {
      log('摄像头捕获失败: ' + e3.message);
      setStatus('error', '摄像头捕获失败');
      sharing = false;
      shareBtn.disabled = false;
      shareBtn.textContent = '开启摄像头';
      return;
    }
  }

  if (!pc) {
    createPeerConnection();
  }

  // 添加本地轨道
  localStream.getTracks().forEach((track) => {
    pc.addTrack(track, localStream);
    log('已添加 track: ' + track.kind);
  });

  // 创建 offer 并发送
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    log('已创建 offer');

    const offerPayload = btoa(JSON.stringify({
      type: 'offer',
      sdp: offer.sdp
    }));
    CosyNetwork.sendSignal({ payload: offerPayload });
    log('已发送 offer');

    setStatus('connected', '正在传输');
    shareBtn.classList.add('hidden');
    stopShareBtn.classList.remove('hidden');
  } catch (e) {
    log('创建 offer 失败: ' + e.message);
    setStatus('error', '传屏启动失败');
    stopScreenShare();
  }
}

function stopScreenShare() {
  log('停止传屏');

  if (captureSource === 'screen' && sharing) {
    // 屏幕模式 → 调用原生停止
    try { CosyNetwork.stopShare(); } catch (e) {}
  }

  if (pc) {
    try { pc.close(); } catch (e) {}
    pc = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => {
      try { t.stop(); } catch (e) {}
    });
    localStream = null;
  }
  sharing = false;
  shareBtn.disabled = false;
  shareBtn.textContent = (captureSource === 'camera') ? '开启摄像头' : '传屏';
  shareBtn.classList.remove('hidden');
  stopShareBtn.classList.add('hidden');
  if (connected) {
    setStatus('connected', '已连接');
  }
}

function handleSignal(payload) {
  let data;
  try {
    data = JSON.parse(atob(payload));
  } catch (e) {
    log('信号解析失败: ' + e.message);
    return;
  }

  if (!pc) {
    log('pc 不存在, 忽略信号');
    return;
  }

  if (data.type === 'answer') {
    log('收到 answer');
    pc.setRemoteDescription({ type: 'answer', sdp: data.sdp })
      .catch((e) => log('setRemoteDescription 失败: ' + e.message));
  } else if (data.type === 'ice') {
    if (data.candidate) {
      pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }
}

function doDisconnect() {
  stopScreenShare();
  if (CosyNetwork) {
    CosyNetwork.disconnect();
  }
  connected = false;
  showConnectView();
  setStatus('', '未连接');
  connectBtn.classList.remove('hidden');
  disconnectBtn.classList.add('hidden');
  connectBtn.disabled = false;
  codeInput.disabled = false;
}

// ---- UI events ----
connectBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!code) {
    setStatus('error', '请输入传屏码');
    return;
  }
  if (!CosyNetwork) {
    setStatus('error', '插件未加载');
    return;
  }

  connectBtn.disabled = true;
  setStatus('connecting', '正在连接...');

  log('调用 connect: ' + code);
  CosyNetwork.connect({ code: code })
    .then((result) => {
      log('连接成功: ' + JSON.stringify(result));
      connected = true;
      receiverVersion.textContent = result.version || '-';
      receiverOs.textContent = result.os || '-';
      receiverIp.textContent = result.ip || '-';
      showInfoView();
      setStatus('connected', '已连接');
      shareBtn.disabled = false;
    })
    .catch((err) => {
      const msg = (err && err.message) ? err.message : JSON.stringify(err);
      log('连接失败: ' + msg);
      setStatus('error', msg);
      connectBtn.disabled = false;
    });
});

shareBtn.addEventListener('click', () => {
  startScreenShare();
});

stopShareBtn.addEventListener('click', () => {
  stopScreenShare();
});

// ---- 传屏源切换 ----
function setCaptureSource(source) {
  if (sharing) {
    log('传屏中, 不允许切换源');
    return;
  }
  captureSource = source;
  if (source === 'screen') {
    srcScreenBtn.classList.add('active');
    srcScreenBtn.setAttribute('aria-selected', 'true');
    srcCameraBtn.classList.remove('active');
    srcCameraBtn.setAttribute('aria-selected', 'false');
    shareBtn.textContent = '传屏';
  } else {
    srcCameraBtn.classList.add('active');
    srcCameraBtn.setAttribute('aria-selected', 'true');
    srcScreenBtn.classList.remove('active');
    srcScreenBtn.setAttribute('aria-selected', 'false');
    shareBtn.textContent = '开启摄像头';
  }
  log('切换传屏源: ' + source);
}

srcScreenBtn.addEventListener('click', () => setCaptureSource('screen'));
srcCameraBtn.addEventListener('click', () => setCaptureSource('camera'));

disconnectBtn.addEventListener('click', doDisconnect);
disconnectBtn2.addEventListener('click', doDisconnect);

codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    connectBtn.click();
  }
});

// ---- Plugin event listeners ----
if (CosyNetwork) {
  CosyNetwork.addListener('signal', (data) => {
    log('收到信号事件 (摄像头模式)');
    handleSignal(data.payload);
  });

  CosyNetwork.addListener('connectionStatus', (data) => {
    log('连接状态变更: ' + data.connected);
    if (!data.connected) {
      connected = false;
      stopScreenShare();
      showConnectView();
      setStatus('', '已断开');
      connectBtn.classList.remove('hidden');
      disconnectBtn.classList.add('hidden');
      connectBtn.disabled = false;
      codeInput.disabled = false;
    }
  });

  // 原生日志推送到前端调试面板
  CosyNetwork.addListener('nativeLog', (data) => {
    if (data && data.msg) {
      window._cosyLog('[原生] ' + data.msg);
    }
  });
} else {
  log('CosyNetwork 插件未加载, 无法注册事件');
}

// ---- Back button handling ----
document.addEventListener('backbutton', (e) => {
  e.preventDefault();
  log('返回键按下');
  if (sharing) {
    // 正在传屏 → 先停止传屏
    stopScreenShare();
  } else if (connected) {
    // 已连接 → 断开连接
    doDisconnect();
  } else {
    // 主界面 → 退出
    if (navigator.app) {
      navigator.app.exitApp();
    }
  }
});

log('初始化完成');
