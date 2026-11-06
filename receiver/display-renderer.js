const { ipcRenderer } = require('electron');

const video = document.getElementById('displayVideo');
const placeholder = document.getElementById('placeholder');

let pc = null;

function createPeerConnection() {
  pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  // Display remote stream when it arrives
  pc.ontrack = (event) => {
    if (event.streams.length > 0) {
      video.srcObject = event.streams[0];
      video.style.display = 'block';
      if (placeholder) placeholder.style.display = 'none';
    }
  };

  // Send ICE candidates to sender via signaling
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      const payload = Buffer.from(JSON.stringify({
        type: 'ice',
        candidate: event.candidate
      })).toString('base64');
      ipcRenderer.send('rtc-signal', payload);
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      video.style.display = 'none';
      if (placeholder) placeholder.style.display = 'block';
    }
  };
}

function handleSignal(payload) {
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch (e) {
    return;
  }

  if (!pc) createPeerConnection();

  if (data.type === 'offer') {
    pc.setRemoteDescription({ type: 'offer', sdp: data.sdp })
      .then(() => pc.createAnswer())
      .then((answer) => pc.setLocalDescription(answer))
      .then(() => {
        const answerPayload = Buffer.from(JSON.stringify({
          type: 'answer',
          sdp: pc.localDescription.sdp
        })).toString('base64');
        ipcRenderer.send('rtc-signal', answerPayload);
      })
      .catch(() => {});
  } else if (data.type === 'ice') {
    if (data.candidate) {
      pc.addIceCandidate(data.candidate).catch(() => {});
    }
  }
}

ipcRenderer.on('rtc-signal', (event, payload) => {
  handleSignal(payload);
});

// Initialize peer connection on load
createPeerConnection();
