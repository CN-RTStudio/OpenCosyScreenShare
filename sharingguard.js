'use strict';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 240;
const MAX_FAILED_HANDSHAKES = 5;
const SHARE_CODE_LENGTH = 6;

const FRAME_KIND = {
  CONTROL: 'control',
  IMAGE: 'image',
  SIGNAL: 'signal',
  UNKNOWN: 'unknown'
};

const REJECT = {
  NONE: '',
  OVERSIZE: 'frame-oversize',
  BAD_KIND: 'bad-kind',
  BAD_CODE: 'bad-share-code',
  RATE_LIMITED: 'rate-limited',
  NOT_SAME_SUBNET: 'not-same-subnet',
  MALFORMED: 'malformed'
};

function normalizeShareCode(input) {
  if (typeof input !== 'string') return '';
  const value = input.trim().toUpperCase();
  if (value.length !== SHARE_CODE_LENGTH) return '';
  for (const ch of value) {
    const ok = (ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z');
    if (!ok) return '';
  }
  return value;
}

function shareCodeEquals(expected, received) {
  const left = normalizeShareCode(expected);
  const right = normalizeShareCode(received);
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

function classifyKind(header) {
  if (!header || typeof header !== 'object') return FRAME_KIND.UNKNOWN;
  const kind = typeof header.kind === 'string' ? header.kind.toLowerCase() : '';
  if (kind === FRAME_KIND.CONTROL) return FRAME_KIND.CONTROL;
  if (kind === FRAME_KIND.IMAGE) return FRAME_KIND.IMAGE;
  if (kind === FRAME_KIND.SIGNAL) return FRAME_KIND.SIGNAL;
  return FRAME_KIND.UNKNOWN;
}

function limitForKind(kind) {
  if (kind === FRAME_KIND.CONTROL || kind === FRAME_KIND.SIGNAL) return MAX_CONTROL_BYTES;
  if (kind === FRAME_KIND.IMAGE) return MAX_FRAME_BYTES;
  return 0;
}

function validateFrame(header, payloadBytes) {
  const kind = classifyKind(header);
  if (kind === FRAME_KIND.UNKNOWN) {
    return { ok: false, reason: REJECT.BAD_KIND, kind };
  }
  const size = Number.isFinite(Number(payloadBytes)) ? Number(payloadBytes) : 0;
  if (size < 0) return { ok: false, reason: REJECT.MALFORMED, kind };
  const limit = limitForKind(kind);
  if (size > limit) return { ok: false, reason: REJECT.OVERSIZE, kind };
  return { ok: true, reason: REJECT.NONE, kind };
}

function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = (value * 256) + n;
  }
  return value;
}

function sameSubnet(a, b, prefixBits) {
  const bits = Number.isInteger(prefixBits) ? prefixBits : 24;
  if (bits < 8 || bits > 32) return false;
  const left = ipv4ToInt(a);
  const right = ipv4ToInt(b);
  if (left === null || right === null) return false;
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return ((left & mask) >>> 0) === ((right & mask) >>> 0);
}

function createSessionState(nowMs) {
  return {
    windowStart: Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0,
    count: 0,
    failedHandshakes: 0,
    locked: false
  };
}

function admitMessage(state, nowMs, kind) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  if (!state || typeof state !== 'object') {
    return { ok: false, reason: REJECT.MALFORMED, state: createSessionState(now) };
  }
  if (state.locked === true) {
    return { ok: false, reason: REJECT.RATE_LIMITED, state };
  }
  if (now - state.windowStart >= 1000) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count += 1;
  if (state.count > MAX_MESSAGES_PER_SECOND) {
    state.locked = true;
    return { ok: false, reason: REJECT.RATE_LIMITED, state };
  }
  if (kind === FRAME_KIND.UNKNOWN) {
    state.failedHandshakes += 1;
    if (state.failedHandshakes >= MAX_FAILED_HANDSHAKES) {
      state.locked = true;
    }
    return { ok: false, reason: REJECT.BAD_KIND, state };
  }
  return { ok: true, reason: REJECT.NONE, state };
}

function admitConnection(peerAddress, hostAddress, expectedCode, receivedCode, state) {
  if (!sameSubnet(peerAddress, hostAddress, 24)) {
    return { ok: false, reason: REJECT.NOT_SAME_SUBNET };
  }
  if (!shareCodeEquals(expectedCode, receivedCode)) {
    if (state && typeof state === 'object') {
      state.failedHandshakes = (Number(state.failedHandshakes) || 0) + 1;
      if (state.failedHandshakes >= MAX_FAILED_HANDSHAKES) state.locked = true;
    }
    return { ok: false, reason: REJECT.BAD_CODE };
  }
  return { ok: true, reason: REJECT.NONE };
}

module.exports = {
  MAX_FRAME_BYTES,
  MAX_CONTROL_BYTES,
  MAX_MESSAGES_PER_SECOND,
  FRAME_KIND,
  REJECT,
  normalizeShareCode,
  shareCodeEquals,
  classifyKind,
  validateFrame,
  sameSubnet,
  createSessionState,
  admitMessage,
  admitConnection
};
