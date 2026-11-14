'use strict';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SECOND = 240;
const MAX_FAILED_HANDSHAKES = 5;
const SHARE_CODE_LENGTH = 6;
const SHARE_CODE_MAX_LENGTH = 32;

const FRAME_KIND = {
  CONTROL: 'control',
  IMAGE: 'image',
  SIGNAL: 'signal',
  UNKNOWN: 'unknown'
};

const KIND_LIMITS = new Map([
  [FRAME_KIND.CONTROL, MAX_CONTROL_BYTES],
  [FRAME_KIND.SIGNAL, MAX_CONTROL_BYTES],
  [FRAME_KIND.IMAGE, MAX_FRAME_BYTES]
]);

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
  if (value.length < SHARE_CODE_LENGTH || value.length > SHARE_CODE_MAX_LENGTH) return '';
  let body = 0;
  for (const ch of value) {
    const digit = ch >= '0' && ch <= '9';
    const upper = ch >= 'A' && ch <= 'Z';
    if (digit || upper) { body += 1; continue; }
    if (ch !== '-') return '';
  }
  if (body < SHARE_CODE_LENGTH) return '';
  if (value.startsWith('-') || value.endsWith('-')) return '';
  if (value.indexOf('--') >= 0) return '';
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
  return KIND_LIMITS.has(kind) ? kind : FRAME_KIND.UNKNOWN;
}

function limitForKind(kind) {
  return KIND_LIMITS.get(kind) || 0;
}

function validateFrame(header, payloadBytes) {
  const kind = classifyKind(header);
  if (kind === FRAME_KIND.UNKNOWN) {
    return { ok: false, reason: REJECT.BAD_KIND, kind };
  }
  if (typeof payloadBytes !== 'number') {
    return { ok: false, reason: REJECT.MALFORMED, kind };
  }
  const size = payloadBytes;
  if (!Number.isFinite(size) || !Number.isInteger(size) || size < 0) {
    return { ok: false, reason: REJECT.MALFORMED, kind };
  }
  if (size > limitForKind(kind)) {
    return { ok: false, reason: REJECT.OVERSIZE, kind };
  }
  return { ok: true, reason: REJECT.NONE, kind };
}

function parseOctet(part) {
  if (part.length < 1 || part.length > 3) return -1;
  if (part.length > 1 && part.charCodeAt(0) === 48) return -1;
  let n = 0;
  for (let i = 0; i < part.length; i += 1) {
    const code = part.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return -1;
    n = (n * 10) + code;
  }
  return n > 255 ? -1 : n;
}

function ipv4ToInt(ip) {
  if (typeof ip !== 'string') return null;
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = parseOctet(part);
    if (octet < 0) return null;
    value = (value * 256) + octet;
  }
  return value;
}

function subnetPrefixFor(ip) {
  const value = ipv4ToInt(ip);
  if (value === null) return 0;
  if ((value & 0xff000000) === 0x0a000000) return 8;
  if ((value & 0xfff00000) === 0xac100000) return 12;
  if ((value & 0xffff0000) === 0xc0a80000) return 16;
  if ((value & 0xff000000) === 0x7f000000) return 8;
  return 24;
}

function sameSubnet(a, b, prefixBits) {
  const bits = Number.isInteger(prefixBits) && prefixBits > 0 ? prefixBits : subnetPrefixFor(b);
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
    locked: false,
    lockedUntil: 0
  };
}

function lockDurationMs(failed) {
  const over = failed - MAX_FAILED_HANDSHAKES;
  if (over < 0) return 0;
  if (over > 6) return 60000;
  return 1000 * (1 << over);
}

function noteFailure(state, nowMs) {
  if (!state || typeof state !== 'object') return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  state.failedHandshakes = (Number(state.failedHandshakes) || 0) + 1;
  if (state.failedHandshakes >= MAX_FAILED_HANDSHAKES) {
    state.locked = true;
    state.lockedUntil = now + lockDurationMs(state.failedHandshakes);
  }
  return state.locked === true;
}

function noteSuccess(state) {
  if (!state || typeof state !== 'object') return;
  state.failedHandshakes = 0;
  state.locked = false;
  state.lockedUntil = 0;
}

function stillLocked(state, nowMs) {
  if (state.locked !== true) return false;
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  if (now >= Number(state.lockedUntil || 0)) {
    state.locked = false;
    state.lockedUntil = 0;
    state.failedHandshakes = 0;
    return false;
  }
  return true;
}

function admitMessage(state, nowMs, kind) {
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
  if (!state || typeof state !== 'object') {
    return { ok: false, reason: REJECT.MALFORMED, state: createSessionState(now) };
  }
  if (stillLocked(state, now)) {
    return { ok: false, reason: REJECT.RATE_LIMITED, state };
  }
  if (now < state.windowStart || now - state.windowStart >= 1000) {
    state.windowStart = now;
    state.count = 0;
  }
  state.count += 1;
  if (state.count > MAX_MESSAGES_PER_SECOND) {
    state.locked = true;
    state.lockedUntil = now + 1000;
    return { ok: false, reason: REJECT.RATE_LIMITED, state };
  }
  if (kind === FRAME_KIND.UNKNOWN) {
    noteFailure(state, now);
    return { ok: false, reason: REJECT.BAD_KIND, state };
  }
  return { ok: true, reason: REJECT.NONE, state };
}

function admitConnection(peerAddress, hostAddress, expectedCode, receivedCode, state, nowMs) {
  if (!sameSubnet(peerAddress, hostAddress, 0)) {
    return { ok: false, reason: REJECT.NOT_SAME_SUBNET };
  }
  if (!shareCodeEquals(expectedCode, receivedCode)) {
    noteFailure(state, nowMs);
    return { ok: false, reason: REJECT.BAD_CODE };
  }
  noteSuccess(state);
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
  limitForKind,
  validateFrame,
  sameSubnet,
  createSessionState,
  admitMessage,
  noteSuccess,
  admitConnection
};
