'use strict';
// Synthetic audio files for tests (no encoder, no ffmpeg, no real voices): silent WAV, MP3 frames, Ogg Opus pages and WebM (Matroska) with
// placeholder blocks. Valid enough for magic-byte sniffing and for music-metadata's duration measurement; not playable speech.

function wav(seconds, sampleRate = 8000) {
  const data = Buffer.alloc(Math.round(seconds * sampleRate), 0x80);              // 8-bit mono silence
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** MPEG-1 Layer III, 44.1 kHz mono, no Xing/Info header. vbr alternates 128 and 64 kbit/s, so only a whole-file scan gives the duration. */
function mp3(seconds, { vbr = false } = {}) {
  const frame = kbps => {
    const b = Buffer.alloc(Math.floor(144 * kbps * 1000 / 44100));
    b[0] = 0xff; b[1] = 0xfb; b[2] = ({ 128: 9, 64: 5 }[kbps]) << 4; b[3] = 0xc4;
    return b;
  };
  return Buffer.concat(Array.from({ length: Math.round(seconds * 44100 / 1152) }, (_, i) => frame(vbr && i % 3 ? 64 : 128)));
}

// ---- Ogg Opus
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
const crc = buf => { let c = 0; for (const b of buf) c = ((c << 8) ^ CRC[((c >>> 24) ^ b) & 0xff]) >>> 0; return c; };
function oggPage(packets, { type = 0, granule = 0n, seq }) {
  const lacing = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { lacing.push(255); n -= 255; } lacing.push(n); }
  const head = Buffer.alloc(27 + lacing.length);
  head.write('OggS', 0); head[5] = type; head.writeBigInt64LE(granule, 6); head.writeUInt32LE(0x1234, 14); head.writeUInt32LE(seq, 18);
  head[26] = lacing.length; Buffer.from(lacing).copy(head, 27);
  const full = Buffer.concat([head, ...packets]);
  full.writeUInt32LE(crc(full), 22);
  return full;
}
function oggOpus(seconds) {
  const preSkip = 312;
  const opusHead = Buffer.alloc(19); opusHead.write('OpusHead', 0); opusHead[8] = 1; opusHead[9] = 1; opusHead.writeUInt16LE(preSkip, 10);
  opusHead.writeUInt32LE(48000, 12);
  const vendor = Buffer.from('test');
  const tags = Buffer.concat([Buffer.from('OpusTags'), Buffer.from([vendor.length, 0, 0, 0]), vendor, Buffer.alloc(4)]);
  const pages = [oggPage([opusHead], { type: 2, seq: 0 }), oggPage([tags], { seq: 1 })];
  const total = seconds * 50; let granule = BigInt(preSkip); let seq = 2;
  for (let i = 0; i < total; i += 50) {
    const n = Math.min(50, total - i); granule += BigInt(n * 960);
    pages.push(oggPage(Array.from({ length: n }, () => Buffer.from([0xf8, 0, 0, 0])), { granule, seq: seq++, type: i + n >= total ? 4 : 0 }));
  }
  return Buffer.concat(pages);
}

// ---- WebM (EBML)
const UNKNOWN = Buffer.from([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const vsize = n => (n < 127 ? Buffer.from([0x80 | n]) : (() => { const b = Buffer.alloc(8); b[0] = 0x01; b.writeUIntBE(n, 2, 6); return b; })());
const idBuf = id => { const hex = id.toString(16); return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex'); };
const el = (id, data, unknownSize = false) => Buffer.concat([idBuf(id), unknownSize ? UNKNOWN : vsize(data.length), data]);
const uint = (id, v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return el(id, b); };
const str = (id, s) => el(id, Buffer.from(s, 'ascii'));
const f64 = (id, v) => { const b = Buffer.alloc(8); b.writeDoubleBE(v); return el(id, b); };

/** headerDuration: false mimics Chrome's MediaRecorder (no Segment Info Duration, unknown-size Segment and Clusters). video adds a video track. */
function webm(seconds, { headerDuration = true, video = false } = {}) {
  const unknownSizes = !headerDuration;
  const header = el(0x1a45dfa3, Buffer.concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'),
    uint(0x4287, 4), uint(0x4285, 2)]));
  const info = el(0x1549a966, Buffer.concat([uint(0x2ad7b1, 1000000), str(0x4d80, 'test'), str(0x5741, 'test'),
    ...(headerDuration ? [f64(0x4489, seconds * 1000)] : [])]));
  const audioTrack = el(0xae, Buffer.concat([uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 2), str(0x86, 'A_OPUS'),
    el(0xe1, Buffer.concat([f64(0xb5, 48000), uint(0x9f, 1)]))]));
  const videoTrack = el(0xae, Buffer.concat([uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 1), str(0x86, 'V_VP8'),
    el(0xe0, Buffer.concat([uint(0xb0, 16), uint(0xba, 16)]))]));
  const tracks = el(0x1654ae6b, Buffer.concat([audioTrack, ...(video ? [videoTrack] : [])]));
  const clusters = [];
  for (let start = 0; start < seconds * 1000; start += 1000) {
    const blocks = [];
    for (let t = 0; t < 1000 && start + t < seconds * 1000; t += 20) {
      const body = Buffer.alloc(14); body[0] = 0x81; body.writeInt16BE(t, 1); body[3] = 0x80; body[4] = 0xf8;
      blocks.push(el(0xa3, body));
    }
    clusters.push(el(0x1f43b675, Buffer.concat([uint(0xe7, start), ...blocks]), unknownSizes));
  }
  return Buffer.concat([header, el(0x18538067, Buffer.concat([info, tracks, ...clusters]), unknownSizes)]);
}

module.exports = { wav, mp3, oggOpus, webm };
