// Audio helpers for the phone path.
//
//   Twilio  -> us : 8 kHz G.711 mu-law, 160-byte frames every 20 ms
//   Gnani STT     : raw 16-bit PCM, little-endian, mono, 1024-byte frames
//   Gnani TTS     : (container "mulaw") raw 8 kHz mu-law, which Twilio plays as-is

const MULAW_TO_PCM = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  const magnitude = (((mantissa << 3) + 0x84) << exponent) - 0x84;
  MULAW_TO_PCM[i] = u & 0x80 ? -magnitude : magnitude;
}

const BIAS = 0x84;
const CLIP = 32635;

function pcmSampleToMulaw(sample) {
  const sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** mu-law bytes -> 16-bit little-endian PCM bytes (twice as long). */
export function mulawToPcm16(mulaw) {
  const out = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) out.writeInt16LE(MULAW_TO_PCM[mulaw[i]], i * 2);
  return out;
}

/** 16-bit little-endian PCM bytes -> mu-law bytes (half as long). */
export function pcm16ToMulaw(pcm) {
  const samples = Math.floor(pcm.length / 2);
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) out[i] = pcmSampleToMulaw(pcm.readInt16LE(i * 2));
  return out;
}

/** Wrap 16-bit mono PCM in a WAV header (so you can double-click and listen). */
export function pcm16ToWav(pcm, sampleRate = 8000) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Convert 16-bit little-endian PCM (mono or stereo, any sample rate of 8 kHz or more) to 8 kHz mono.
 * Each output sample is the average of the input samples it covers: a simple low-pass filter
 * that is plenty for speech recognition and for tests.
 */
export function resampleTo8k(pcm, sourceRate, channels = 1) {
  const frames = Math.floor(pcm.length / (2 * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += pcm.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels;
  }
  const ratio = sourceRate / 8000;
  const outLength = Math.floor(frames / ratio);
  const out = Buffer.alloc(outLength * 2);
  for (let o = 0; o < outLength; o++) {
    const start = o * ratio;
    const end = start + ratio;
    let sum = 0;
    let weight = 0;
    for (let i = Math.floor(start); i < Math.min(frames, Math.ceil(end)); i++) {
      const w = Math.min(i + 1, end) - Math.max(i, start);
      sum += mono[i] * w;
      weight += w;
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sum / weight))), o * 2);
  }
  return out;
}

/**
 * Read a .wav file and return its audio as raw 8 kHz mono 16-bit PCM, converting
 * from a higher sample rate and/or stereo when needed (so a phone or laptop
 * recording works as-is). Only 16-bit PCM wavs are supported.
 */
export function wavToPcm8k(wav) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a WAV file");
  }
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    let size = wav.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      fmt = {
        format: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!fmt) throw new Error("WAV has no fmt chunk before the data");
      if (fmt.format !== 1 || fmt.bits !== 16 || fmt.channels > 2 || fmt.sampleRate < 8000) {
        throw new Error(
          `Unsupported WAV (${fmt.sampleRate} Hz, ${fmt.channels} ch, ${fmt.bits}-bit, format ${fmt.format}). ` +
            `Use 16-bit PCM, or convert it with: ffmpeg -i input.wav -ar 8000 -ac 1 output.wav`
        );
      }
      if (size === 0 || body + size > wav.length) size = wav.length - body;
      const data = wav.subarray(body, body + size);
      if (fmt.sampleRate === 8000 && fmt.channels === 1) return data;
      return resampleTo8k(data, fmt.sampleRate, fmt.channels);
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** `ms` milliseconds of digital silence as 16-bit PCM. */
export function silencePcm(ms, sampleRate = 8000) {
  return Buffer.alloc(Math.round((sampleRate * ms) / 1000) * 2);
}

/** Re-groups arbitrary-sized audio into fixed-size frames (Gnani STT needs exactly 1024 bytes). */
export class FrameChunker {
  constructor(frameBytes = 1024) {
    this.frameBytes = frameBytes;
    this.rest = Buffer.alloc(0);
  }

  /** Add audio; returns the complete frames now available. */
  push(chunk) {
    const data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    const frames = [];
    let offset = 0;
    while (data.length - offset >= this.frameBytes) {
      frames.push(data.subarray(offset, offset + this.frameBytes));
      offset += this.frameBytes;
    }
    this.rest = data.subarray(offset);
    return frames;
  }

  /** The leftover audio, padded with silence to a full frame (or null if none). */
  flush() {
    if (!this.rest.length) return null;
    const frame = Buffer.alloc(this.frameBytes);
    this.rest.copy(frame);
    this.rest = Buffer.alloc(0);
    return frame;
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));