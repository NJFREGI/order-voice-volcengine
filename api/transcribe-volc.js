// Vercel Serverless Function: /api/transcribe-volc
// V23: Volcengine/Doubao SAUC v3 binary WebSocket protocol adapter for NJF voice order.
// Key fixes:
// - Uses official SAUC v3 binary frame format.
// - Adds X-Api-Request-Id and X-Api-Sequence headers.
// - Marks the LAST REAL AUDIO CHUNK as the final/negative packet instead of sending an empty final packet.
// - Supports old console headers (App Key + Access Key) and new console X-Api-Key.

export const config = { maxDuration: 60 };

import { gzipSync, gunzipSync } from 'node:zlib';
import crypto from 'node:crypto';
import WebSocket from 'ws';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function collectRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseContentDisposition(header) {
  const out = {};
  String(header || '').split(';').map(s => s.trim()).forEach(p => {
    const eq = p.indexOf('=');
    if (eq > -1) {
      const k = p.slice(0, eq).trim().toLowerCase();
      let v = p.slice(eq + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out[k] = v;
    }
  });
  return out;
}

function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {}, files = {};
  let pos = buffer.indexOf(boundary);
  while (pos !== -1) {
    let next = buffer.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    let part = buffer.slice(pos + boundary.length, next);
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    if (part.length === 0 || part.slice(0, 2).toString() === '--') { pos = next; continue; }
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) { pos = next; continue; }
    const headerText = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);
    const headers = {};
    headerText.split('\r\n').forEach(line => {
      const idx = line.indexOf(':');
      if (idx > -1) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    });
    const disp = parseContentDisposition(headers['content-disposition']);
    if (disp.name) {
      if (disp.filename) files[disp.name] = { filename: disp.filename, contentType: headers['content-type'] || 'application/octet-stream', buffer: body };
      else fields[disp.name] = body.toString('utf8');
    }
    pos = next;
  }
  return { fields, files };
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function envFirst(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// SAUC v3 binary protocol frame:
// byte0: version(4bit)=1 + headerSize(4bit)=1 => 0x11
// byte1: msgType(4bit) + flags(4bit)
// byte2: serialization(4bit) + compression(4bit)
// byte3: reserved 0
// then payload size uint32BE, then payload
function buildFrame(messageType, flags, serialization, compression, payload) {
  const payloadBuf = Buffer.from(payload || Buffer.alloc(0));
  const header = Buffer.from([(0x01 << 4) | 0x01, (messageType << 4) | flags, (serialization << 4) | compression, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payloadBuf.length, 0);
  return Buffer.concat([header, size, payloadBuf]);
}

function parseServerFrame(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 4) return { data: null };

  const byte1 = buf.readUInt8(1);
  const byte2 = buf.readUInt8(2);
  const msgType = (byte1 >> 4) & 0x0f;
  const flags = byte1 & 0x0f;
  const compression = byte2 & 0x0f;

  if (msgType === 0x0f) {
    // Error frame: header + errorCode(4B) + errorSize(4B) + message
    const code = buf.length >= 8 ? buf.readUInt32BE(4) : 0;
    const msgSize = buf.length >= 12 ? buf.readUInt32BE(8) : Math.max(0, buf.length - 12);
    const msg = buf.slice(12, 12 + msgSize).toString('utf8');
    return { error: true, code, message: msg || `Volcengine server error ${code}` };
  }

  let offset = 4;
  let sequence = null;
  // Full server response has sequence field before payload size.
  if (msgType === 0x09 && buf.length >= 12) {
    sequence = buf.readInt32BE(offset);
    offset += 4;
  }

  if (buf.length < offset + 4) return { msgType, flags, sequence, data: null };
  const payloadSize = buf.readUInt32BE(offset);
  offset += 4;
  let payload = buf.slice(offset, offset + payloadSize);
  if (compression === 0x01 && payload.length) payload = gunzipSync(payload);
  const str = payload.toString('utf8');
  let data = null;
  try { data = JSON.parse(str || '{}'); }
  catch { data = { text: str }; }
  return { msgType, flags, sequence, data };
}

function extractText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.text) return data.text;
  if (data.transcript) return data.transcript;
  if (data.result?.text) return data.result.text;
  if (Array.isArray(data.result?.utterances)) return data.result.utterances.map(u => u.text || '').join('');
  if (Array.isArray(data.utterances)) return data.utterances.map(u => u.text || '').join('');
  const all = [];
  try {
    JSON.stringify(data, (k, v) => {
      if ((k === 'text' || k === 'utterance' || k === 'sentence') && typeof v === 'string') all.push(v);
      return v;
    });
  } catch {}
  return [...new Set(all)].join('');
}

function parseWavPcm(buffer) {
  if (buffer.slice(0, 4).toString('ascii') !== 'RIFF' || buffer.slice(8, 12).toString('ascii') !== 'WAVE') {
    throw new Error('Expected WAV audio. Please use the latest index.html.');
  }
  let offset = 12, fmt = null, data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.slice(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') fmt = buffer.slice(start, start + size);
    if (id === 'data') data = buffer.slice(start, start + size);
    offset = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('Invalid WAV: missing fmt or data chunk');
  const audioFormat = fmt.readUInt16LE(0);
  const channels = fmt.readUInt16LE(2);
  const sampleRate = fmt.readUInt32LE(4);
  const bits = fmt.readUInt16LE(14);
  if (audioFormat !== 1 || bits !== 16) throw new Error(`Only PCM16 WAV is supported, got format=${audioFormat}, bits=${bits}`);
  if (channels !== 1) throw new Error(`Only mono WAV is supported, got channels=${channels}`);
  return { pcm: data, sampleRate, bits, channels };
}

async function transcribeBySaucV3(audioBuffer, fields) {
  const appKey = envFirst('VOLCENGINE_ASR_APP_ID', 'DOUBAO_APP_ID', 'VOLCENGINE_APP_KEY');
  const accessKey = envFirst('VOLCENGINE_ASR_ACCESS_TOKEN', 'DOUBAO_ACCESS_TOKEN', 'VOLCENGINE_ACCESS_KEY');
  const apiKey = envFirst('VOLCENGINE_ASR_API_KEY', 'DOUBAO_API_KEY');

  if (!apiKey && (!appKey || !accessKey)) {
    throw new Error('Missing Volcengine key. Use either VOLCENGINE_ASR_API_KEY, or VOLCENGINE_ASR_APP_ID + VOLCENGINE_ASR_ACCESS_TOKEN.');
  }

  const resourceId = envFirst('VOLCENGINE_ASR_RESOURCE_ID', 'DOUBAO_ASR_RESOURCE_ID', 'VOLCENGINE_RESOURCE_ID') || 'volc.seedasr.sauc.duration';
  const wsUrl = envFirst('VOLCENGINE_ASR_WS_URL') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
  const language = envFirst('VOLCENGINE_ASR_LANGUAGE'); // optional: zh-CN / ja-JP / empty

  const { pcm, sampleRate } = parseWavPcm(audioBuffer);
  if (sampleRate !== 16000) throw new Error(`Audio sample rate must be 16000Hz, got ${sampleRate}. Please use the latest index.html.`);

  const requestId = uuid();
  const connectId = uuid();
  const headers = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Sequence': '-1',
    'X-Api-Connect-Id': connectId,
  };
  if (apiKey) headers['X-Api-Key'] = apiKey;
  else {
    headers['X-Api-App-Key'] = appKey;
    headers['X-Api-Access-Key'] = accessKey;
  }

  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers, perMessageDeflate: false });
    let finished = false;
    let bestText = '';
    const texts = [];

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      if (bestText || texts.length) resolve(bestText || texts.join(''));
      else reject(new Error('Volcengine ASR timeout. Check Vercel Logs and X-Tt-Logid if available.'));
    }, Number(process.env.VOLCENGINE_ASR_TIMEOUT_MS || 45000));

    function done(text) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve(text || bestText || texts.join(''));
    }

    ws.on('upgrade', (res) => {
      console.log('[Volcengine ASR] upgrade headers', {
        logid: res.headers['x-tt-logid'],
        connectId: res.headers['x-api-connect-id'],
        statusCode: res.statusCode,
      });
    });

    ws.on('open', () => {
      const productHint = String(fields.product_hint || '').slice(0, 1500);
      const hotwords = productHint ? productHint.split('、').slice(0, 120).map(w => ({ word: w.slice(0, 32) })) : undefined;

      const initPayload = {
        user: { uid: process.env.VOLCENGINE_UID || 'njf_voice_order' },
        audio: {
          format: 'pcm',
          rate: 16000,
          bits: 16,
          channel: 1,
          ...(language ? { language } : {}),
        },
        request: {
          model_name: process.env.VOLCENGINE_ASR_MODEL_NAME || 'bigmodel',
          enable_itn: true,
          enable_punc: true,
          enable_ddc: false,
          result_type: process.env.VOLCENGINE_ASR_RESULT_TYPE || 'full',
          ...(hotwords ? { corpus: { context: JSON.stringify({ hotwords }) } } : {}),
        },
      };

      const initPayloadGz = gzipSync(Buffer.from(JSON.stringify(initPayload), 'utf8'));
      ws.send(buildFrame(0x01, 0x00, 0x01, 0x01, initPayloadGz));

      // Send real PCM chunks. The final REAL chunk is marked with flag 0x02.
      // Do not send a separate empty final packet; the official doc says the final packet should contain audio data.
      const chunkSize = Number(process.env.VOLCENGINE_ASR_CHUNK_BYTES || 6400); // 200ms PCM16 mono at 16k = 6400 bytes
      const delayMs = Number(process.env.VOLCENGINE_ASR_CHUNK_DELAY_MS || 100);
      let pos = 0;

      const sendNext = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (pcm.length === 0) return reject(new Error('Empty audio'));

        const end = Math.min(pos + chunkSize, pcm.length);
        const chunk = pcm.slice(pos, end);
        pos = end;
        const isLast = pos >= pcm.length;
        const flags = isLast ? 0x02 : 0x00;
        const chunkGz = gzipSync(chunk);
        ws.send(buildFrame(0x02, flags, 0x00, 0x01, chunkGz));

        if (!isLast) setTimeout(sendNext, delayMs);
      };

      // Wait a little after init to avoid the first audio packet arriving before server has accepted the config.
      setTimeout(sendNext, Number(process.env.VOLCENGINE_ASR_INIT_DELAY_MS || 80));
    });

    ws.on('message', msg => {
      try {
        const parsed = parseServerFrame(msg);
        if (parsed.error) return reject(new Error(`${parsed.code || ''} ${parsed.message || 'Volcengine ASR error'}`.trim()));
        const data = parsed.data;

        if (data?.code && Number(data.code) !== 20000000) {
          return reject(new Error(data.message || `Volcengine ASR code ${data.code}`));
        }

        const text = extractText(data);
        if (text) {
          bestText = text;
          const definite = data?.result?.utterances?.some(u => u.definite === true) || parsed.sequence < 0;
          if (definite) texts.push(text);
        }

        if (parsed.sequence < 0 && (bestText || texts.length)) {
          done(bestText || texts.join(''));
        }
      } catch (e) {
        reject(e);
      }
    });

    ws.on('error', err => reject(err));
    ws.on('close', () => {
      if (!finished) {
        clearTimeout(timeout);
        if (bestText || texts.length) resolve(bestText || texts.join(''));
        else reject(new Error('Volcengine ASR closed without result'));
      }
    });
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (process.env.VOLCENGINE_MOCK_TEXT) {
      return res.status(200).json({ text: process.env.VOLCENGINE_MOCK_TEXT, provider: 'mock' });
    }

    const raw = await collectRequest(req);
    const { fields, files } = parseMultipart(raw, req.headers['content-type']);
    const audio = files.audio;
    if (!audio?.buffer?.length) throw new Error('Missing audio file');

    const text = await transcribeBySaucV3(audio.buffer, fields || {});
    return res.status(200).json({ text, provider: 'volcengine-sauc-v3' });
  } catch (err) {
    console.error('[transcribe-volc] error', err);
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
