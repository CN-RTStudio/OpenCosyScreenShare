'use strict';

const MAX_CAPTURE_WIDTH = 1920;
const MAX_CAPTURE_HEIGHT = 1080;
const MAX_CAPTURE_PIXELS = MAX_CAPTURE_WIDTH * MAX_CAPTURE_HEIGHT;
const MIN_CAPTURE_WIDTH = 160;
const MIN_CAPTURE_HEIGHT = 120;
const MAX_CAPTURE_FPS = 30;
const MIN_CAPTURE_FPS = 1;
const MAX_SIGNAL_BYTES = 16 * 1024;
const MAX_SDP_BYTES = 12 * 1024;
const MAX_CANDIDATE_BYTES = 512;
const MAX_SDP_MID_BYTES = 64;
const SIGNAL_TYPES = ['offer', 'answer', 'candidate', 'bye'];

function toInteger(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string' && value.length <= 9 && /^[0-9]+$/.test(value)) return parseInt(value, 10);
  return null;
}

function clampEven(value, min, max) {
  const n = Math.min(max, Math.max(min, value));
  return n % 2 === 0 ? n : n - 1;
}

function clampCapture(request) {
  if (!request || typeof request !== 'object') {
    return { ok: false, reason: 'malformed', width: MAX_CAPTURE_WIDTH, height: MAX_CAPTURE_HEIGHT, frameRate: MAX_CAPTURE_FPS };
  }
  let width = toInteger(request.width);
  let height = toInteger(request.height);
  let fps = toInteger(request.frameRate === undefined ? request.fps : request.frameRate);
  if (width === null || height === null || width <= 0 || height <= 0) {
    return { ok: false, reason: 'bad-geometry', width: MAX_CAPTURE_WIDTH, height: MAX_CAPTURE_HEIGHT, frameRate: MAX_CAPTURE_FPS };
  }
  if (fps === null || fps <= 0) fps = MAX_CAPTURE_FPS;
  let clamped = false;
  if (width > MAX_CAPTURE_WIDTH || height > MAX_CAPTURE_HEIGHT || width * height > MAX_CAPTURE_PIXELS) {
    const byPixels = Math.sqrt(MAX_CAPTURE_PIXELS / (width * height));
    const byLong = Math.min(MAX_CAPTURE_WIDTH / width, MAX_CAPTURE_HEIGHT / height);
    const scale = Math.min(1, byPixels, byLong);
    width = Math.floor(width * scale);
    height = Math.floor(height * scale);
    clamped = true;
  }
  const finalWidth = clampEven(width, MIN_CAPTURE_WIDTH, MAX_CAPTURE_WIDTH);
  const finalHeight = clampEven(height, MIN_CAPTURE_HEIGHT, MAX_CAPTURE_HEIGHT);
  if (finalWidth !== width || finalHeight !== height) clamped = true;
  const finalFps = Math.min(MAX_CAPTURE_FPS, Math.max(MIN_CAPTURE_FPS, fps));
  if (finalFps !== fps) clamped = true;
  return { ok: true, reason: clamped ? 'clamped' : 'ok', width: finalWidth, height: finalHeight, frameRate: finalFps };
}

function byteLength(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
}

function sanitizeSignal(rawPayload) {
  if (typeof rawPayload !== 'string' || rawPayload.length === 0) {
    return { ok: false, reason: 'malformed', payload: '' };
  }
  if (byteLength(rawPayload) > MAX_SIGNAL_BYTES) {
    return { ok: false, reason: 'oversize', payload: '' };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawPayload);
  } catch (e) {
    return { ok: false, reason: 'malformed', payload: '' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', payload: '' };
  }
  const type = typeof parsed.type === 'string' ? parsed.type : '';
  if (SIGNAL_TYPES.indexOf(type) < 0) {
    return { ok: false, reason: 'bad-type', payload: '' };
  }
  const out = { type };
  if (type === 'offer' || type === 'answer') {
    if (typeof parsed.sdp !== 'string' || byteLength(parsed.sdp) > MAX_SDP_BYTES) {
      return { ok: false, reason: 'bad-sdp', payload: '' };
    }
    out.sdp = parsed.sdp;
  }
  if (type === 'candidate') {
    const candidate = parsed.candidate;
    if (typeof candidate === 'string') {
      if (byteLength(candidate) > MAX_CANDIDATE_BYTES) {
        return { ok: false, reason: 'bad-candidate', payload: '' };
      }
      out.candidate = candidate;
    } else if (candidate === null || candidate === undefined) {
      out.candidate = null;
    } else {
      return { ok: false, reason: 'bad-candidate', payload: '' };
    }
    if (typeof parsed.sdpMid === 'string' && byteLength(parsed.sdpMid) <= MAX_SDP_MID_BYTES) {
      out.sdpMid = parsed.sdpMid;
    }
    const lineIndex = toInteger(parsed.sdpMLineIndex);
    if (lineIndex !== null && lineIndex >= 0 && lineIndex <= 64) {
      out.sdpMLineIndex = lineIndex;
    }
  }
  if (typeof parsed.id === 'string' && byteLength(parsed.id) <= MAX_SDP_MID_BYTES) {
    out.id = parsed.id;
  }
  const payload = JSON.stringify(out);
  if (byteLength(payload) > MAX_SIGNAL_BYTES) {
    return { ok: false, reason: 'oversize', payload: '' };
  }
  return { ok: true, reason: 'ok', payload };
}

function sanitizeCaptureHints(message) {
  if (!message || typeof message !== 'object') return null;
  if (typeof message.width !== 'number' && typeof message.height !== 'number' && typeof message.frameRate !== 'number') {
    return null;
  }
  const result = clampCapture(message);
  return result.ok ? { width: result.width, height: result.height, frameRate: result.frameRate } : null;
}

module.exports = {
  MAX_CAPTURE_WIDTH,
  MAX_CAPTURE_HEIGHT,
  MAX_CAPTURE_PIXELS,
  MAX_CAPTURE_FPS,
  MAX_SIGNAL_BYTES,
  clampCapture,
  sanitizeSignal,
  sanitizeCaptureHints
};
