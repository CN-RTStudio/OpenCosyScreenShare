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

const codeValue = document.getElementById('codeValue');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const mainView = document.getElementById('mainView');
const displayView = document.getElementById('displayView');
const video = document.getElementById('displayVideo');
const placeholder = document.getElementById('placeholder');

let pc = null;

// ---- 日志输出到前端 ----
function log(msg) {
  window._cosyLog(msg);
}

log('脚本加载完成');

// ---- View switching ----
function showMainView() {
  displayView.classList.remove('active');
  mainView.classList.add('active');
}

function showDisplayView() {
  mainView.classList.remove('active');
  displayView.classList.add('active');
}

// ---- Status ----
function setStatus(connected) {
  if (connected) {
    statusDot.classList.add('connected');
    statusText.textContent = '已连接 - 等待投屏';
  } else {
    statusDot.classList.remove('connected');
    statusText.textContent = '等待连接';
  }
}

// ---- 停止投屏 (保持 TCP 连接) ----
function handleStopShare() {
  log('收到 STOP, 停止投屏但保持连接');
  if (pc) {
    pc.close();
    pc = null;
  }
  video.srcObject = null;
  video.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';
  // 保持 connected 状态, 仅切换回主视图等待重新投屏
  statusDot.classList.add('connected');
  statusText.textContent = '已连接 - 等待投屏';
  showMainView();
}

// ---- WebRTC ----
function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  pc.ontrack = (event) => {
    log('收到 track 事件');
    if (event.streams.length > 0) {
      video.srcObject = event.streams[0];
      video.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
      statusText.textContent = '已连接 - 正在传输';
      showDisplayView();
    }
  };

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
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      video.style.display = 'none';
      if (placeholder) placeholder.style.display = 'block';
    }
  };
}

function handleSignal(payload) {
  let data;
  try {
    data = JSON.parse(atob(payload));
  } catch (e) {
    log('信号解析失败: ' + e.message);
    return;
  }

  if (!pc) createPeerConnection();

  if (data.type === 'offer') {
    log('收到 offer');
    pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        const answerPayload = btoa(JSON.stringify({
          type: 'answer',
          sdp: pc.localDescription.sdp
        }));
        CosyNetwork.sendSignal({ payload: answerPayload });
        log('已发送 answer');
      })
      .catch((e) => log('answer 失败: ' + e.message));
  } else if (data.type === 'ice') {
    if (data.candidate) {
      pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }
}

// ---- Plugin event listeners ----
CosyNetwork.addListener('signal', (data) => {
  log('收到信号事件');
  // 若 pc 已被 STOP 关闭, 收到新 SIGNAL 时重新创建 (支持停止后重新投屏)
  if (!pc) createPeerConnection();
  handleSignal(data.payload);
});

CosyNetwork.addListener('stopShare', () => {
  handleStopShare();
});

CosyNetwork.addListener('connectionStatus', (data) => {
  log('连接状态变更: ' + data.connected);
  if (data.connected) {
    setStatus(true);
    showDisplayView();
    if (!pc) createPeerConnection();
  } else {
    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;
    video.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    setStatus(false);
    showMainView();
  }
});

// ---- Start server on load ----
log('准备调用 startServer');
CosyNetwork.startServer()
  .then((result) => {
    log('startServer 成功: ' + JSON.stringify(result));
    codeValue.innerHTML = '';
    const codeSpan = document.createElement('span');
    codeSpan.textContent = result.code;
    codeValue.appendChild(codeSpan);
  })
  .catch((err) => {
    log('startServer 失败: ' + (err && err.message ? err.message : JSON.stringify(err)));
    codeValue.innerHTML = '<span class="placeholder">启动失败</span>';
  });

// ---- Back button handling ----
document.addEventListener('backbutton', (e) => {
  e.preventDefault();
  if (displayView.classList.contains('active')) {
    // 显示界面按返回 → 停止投屏但保持连接
    if (pc) {
      pc.close();
      pc = null;
    }
    video.srcObject = null;
    video.style.display = 'none';
    if (placeholder) placeholder.style.display = 'block';
    statusText.textContent = '已连接 - 等待投屏';
    showMainView();
  } else {
    // 主界面按返回 → 先停止服务，再退出
    log('返回键：停止服务并退出');
    CosyNetwork.stopServer().then(() => {
      navigator.app.exitApp();
    }).catch(() => {
      navigator.app.exitApp();
    });
  }
});
