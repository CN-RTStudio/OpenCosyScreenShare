const { ipcRenderer } = require('electron');
const signalingGuard = require('../signalingguard');

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

const signalLimiter = signalingGuard.createRateLimiter({ capacity: 32, refillPerSecond: 12 });
let pinnedFingerprint = null;
let negotiateInFlight = false;
let lastOfferAt = 0;

function reportSignalReject(reason) {
  if (typeof reason === 'string' && reason.length > 0) {
    ipcRenderer.send('signal-rejected', reason);
  }
}

function applyOffer(offer) {
  const stamp = Date.now();
  if (stamp - lastOfferAt < 500) {
    reportSignalReject('offer-too-soon');
    return;
  }
  if (negotiateInFlight) {
    reportSignalReject('offer-in-flight');
    return;
  }
  if (pinnedFingerprint && offer.fingerprint !== pinnedFingerprint) {
    reportSignalReject('offer-fingerprint-mismatch');
    return;
  }
  pinnedFingerprint = offer.fingerprint;
  lastOfferAt = stamp;
  negotiateInFlight = true;
  pc.setRemoteDescription({ type: 'offer', sdp: offer.sdp })
    .then(() => pc.createAnswer())
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => {
      const answerPayload = Buffer.from(JSON.stringify({
        type: 'answer',
        sdp: pc.localDescription.sdp
      })).toString('base64');
      ipcRenderer.send('rtc-signal', answerPayload);
    })
    .catch(() => reportSignalReject('answer-failed'))
    .then(() => { negotiateInFlight = false; });
}

function handleSignal(payload) {
  const budget = signalLimiter.take(Date.now());
  if (!budget.ok) {
    reportSignalReject('signal-rate-limited');
    return;
  }
  const decoded = signalingGuard.decodePayload(payload);
  if (!decoded.ok) {
    reportSignalReject(decoded.reason);
    return;
  }
  const data = decoded.data;
  if (!pc) createPeerConnection();

  if (data.type === 'offer') {
    const offer = signalingGuard.validateOffer(payload);
    if (!offer.ok) {
      reportSignalReject(offer.reason);
      return;
    }
    applyOffer(offer);
    return;
  }
  if (data.type === 'ice') {
    const ice = signalingGuard.validateIce(payload);
    if (!ice.ok) {
      reportSignalReject(ice.reason);
      return;
    }
    pc.addIceCandidate(ice.candidate).catch(() => reportSignalReject('ice-add-failed'));
    return;
  }
  reportSignalReject('unknown-signal-type');
}

ipcRenderer.on('rtc-signal', (event, payload) => {
  handleSignal(payload);
});

// Initialize peer connection on load
createPeerConnection();
