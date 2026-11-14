const MAX_SIGNAL_BYTES = 96 * 1024;
const MAX_SDP_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 256;
const MAX_ICE_UFRAG = 256;
const MAX_ICE_PWD = 256;
const CANDIDATE_TYPES = new Set(['host', 'srflx', 'prflx', 'relay']);
const CANDIDATE_PROTOCOLS = new Set(['udp', 'tcp']);

function decodePayload(payload) {
  if (typeof payload !== 'string' || payload.length === 0) {
    return { ok: false, reason: 'empty' };
  }
  if (payload.length > MAX_SIGNAL_BYTES) {
    return { ok: false, reason: 'oversize' };
  }
  let text;
  try {
    text = Buffer.from(payload, 'base64').toString('utf8');
  } catch (e) {
    return { ok: false, reason: 'decode' };
  }
  if (text.length === 0 || text.length > MAX_SIGNAL_BYTES) {
    return { ok: false, reason: 'decoded-size' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: 'json' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'shape' };
  }
  return { ok: true, data: data };
}

function sdpLines(sdp) {
  return sdp.split(/\r?\n/).filter(line => line.length > 0);
}

function findAttribute(lines, name) {
  const prefix = 'a=' + name + ':';
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length).trim();
  }
  return null;
}

function countAttribute(lines, name) {
  const prefix = 'a=' + name;
  let total = 0;
  for (const line of lines) {
    if (line.startsWith(prefix)) total += 1;
  }
  return total;
}

function validateSdpText(sdp, expectVideo) {
  if (typeof sdp !== 'string' || sdp.length === 0) {
    return { ok: false, reason: 'sdp-empty' };
  }
  if (sdp.length > MAX_SDP_BYTES) {
    return { ok: false, reason: 'sdp-oversize' };
  }
  const lines = sdpLines(sdp);
  if (lines.length === 0) return { ok: false, reason: 'sdp-lines' };
  if (!lines[0].startsWith('v=0')) return { ok: false, reason: 'sdp-version' };
  let mediaCount = 0;
  let hasVideo = false;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      mediaCount += 1;
      if (line.startsWith('m=video')) hasVideo = true;
    }
    if (line.length > 2048) return { ok: false, reason: 'sdp-line-oversize' };
  }
  if (mediaCount === 0 || mediaCount > 4) return { ok: false, reason: 'sdp-media-count' };
  if (expectVideo && !hasVideo) return { ok: false, reason: 'sdp-no-video' };
  const ufrag = findAttribute(lines, 'ice-ufrag');
  const pwd = findAttribute(lines, 'ice-pwd');
  if (!ufrag || ufrag.length > MAX_ICE_UFRAG) return { ok: false, reason: 'sdp-ufrag' };
  if (!pwd || pwd.length > MAX_ICE_PWD) return { ok: false, reason: 'sdp-pwd' };
  const fingerprint = findAttribute(lines, 'fingerprint');
  if (!fingerprint) return { ok: false, reason: 'sdp-fingerprint' };
  if (!fingerprint.startsWith('sha-256 ')) return { ok: false, reason: 'sdp-fingerprint-algo' };
  const setup = findAttribute(lines, 'setup');
  if (setup && !['actpass', 'active', 'passive'].includes(setup)) {
    return { ok: false, reason: 'sdp-setup' };
  }
  if (countAttribute(lines, 'candidate') > 4) return { ok: false, reason: 'sdp-candidate-flood' };
  return { ok: true, fingerprint: fingerprint, hasVideo: hasVideo };
}

function validateCandidate(raw) {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'candidate-shape' };
  const value = typeof raw.candidate === 'string' ? raw.candidate : '';
  if (value.length === 0 || value.length > MAX_CANDIDATE_BYTES) {
    return { ok: false, reason: 'candidate-size' };
  }
  const trimmed = value.startsWith('a=') ? value.slice(2) : value;
  if (!trimmed.startsWith('candidate:')) return { ok: false, reason: 'candidate-prefix' };
  const parts = trimmed.split(' ');
  if (parts.length < 8) return { ok: false, reason: 'candidate-parts' };
  const component = parts[1];
  if (component !== '1' && component !== '2') return { ok: false, reason: 'candidate-component' };
  const protocol = parts[2].toLowerCase();
  if (!CANDIDATE_PROTOCOLS.has(protocol)) return { ok: false, reason: 'candidate-protocol' };
  const port = Number(parts[5]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, reason: 'candidate-port' };
  }
  const address = parts[4];
  if (address.length > 64 || /[^0-9a-f:.]/i.test(address)) {
    return { ok: false, reason: 'candidate-address' };
  }
  let typ = null;
  for (let i = 6; i + 1 < parts.length; i += 1) {
    if (parts[i] === 'typ') typ = parts[i + 1];
  }
  if (!typ || !CANDIDATE_TYPES.has(typ)) return { ok: false, reason: 'candidate-type' };
  if (raw.sdpMid !== undefined && raw.sdpMid !== null && typeof raw.sdpMid !== 'string') {
    return { ok: false, reason: 'candidate-mid' };
  }
  if (raw.sdpMLineIndex !== undefined && raw.sdpMLineIndex !== null) {
    const index = raw.sdpMLineIndex;
    if (!Number.isInteger(index) || index < 0 || index > 3) {
      return { ok: false, reason: 'candidate-index' };
    }
  }
  return { ok: true, candidate: { candidate: trimmed, sdpMid: raw.sdpMid, sdpMLineIndex: raw.sdpMLineIndex } };
}

function validateOffer(payload) {
  const decoded = decodePayload(payload);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const data = decoded.data;
  if (data.type !== 'offer') return { ok: false, reason: 'type' };
  if (typeof data.sdp !== 'string') return { ok: false, reason: 'sdp-type' };
  const sdp = validateSdpText(data.sdp, true);
  if (!sdp.ok) return { ok: false, reason: sdp.reason };
  return { ok: true, sdp: data.sdp, fingerprint: sdp.fingerprint };
}

function validateAnswer(payload) {
  const decoded = decodePayload(payload);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const data = decoded.data;
  if (data.type !== 'answer') return { ok: false, reason: 'type' };
  if (typeof data.sdp !== 'string') return { ok: false, reason: 'sdp-type' };
  const sdp = validateSdpText(data.sdp, true);
  if (!sdp.ok) return { ok: false, reason: sdp.reason };
  return { ok: true, sdp: data.sdp, fingerprint: sdp.fingerprint };
}

function validateIce(payload) {
  const decoded = decodePayload(payload);
  if (!decoded.ok) return { ok: false, reason: decoded.reason };
  const data = decoded.data;
  if (data.type !== 'ice') return { ok: false, reason: 'type' };
  const candidate = validateCandidate(data.candidate);
  if (!candidate.ok) return { ok: false, reason: candidate.reason };
  return { ok: true, candidate: candidate.candidate };
}

function createRateLimiter(options) {
  const cfg = options || {};
  const capacity = Number.isInteger(cfg.capacity) ? cfg.capacity : 24;
  const refillPerSecond = Number.isInteger(cfg.refillPerSecond) ? cfg.refillPerSecond : 8;
  let tokens = capacity;
  let last = Date.now();
  let rejected = 0;
  return {
    take(now) {
      const stamp = Number.isInteger(now) ? now : Date.now();
      const elapsed = Math.max(0, stamp - last) / 1000;
      tokens = Math.min(capacity, tokens + elapsed * refillPerSecond);
      last = stamp;
      if (tokens < 1) {
        rejected += 1;
        return { ok: false, rejected: rejected };
      }
      tokens -= 1;
      return { ok: true, rejected: rejected };
    },
    stats() {
      return { tokens: tokens, rejected: rejected };
    }
  };
}

module.exports = {
  decodePayload,
  validateSdpText,
  validateCandidate,
  validateOffer,
  validateAnswer,
  validateIce,
  createRateLimiter
};
