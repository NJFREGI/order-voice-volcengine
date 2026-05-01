// Vercel Serverless Function: /api/transcribe-volc
// V24: Volcengine/Doubao SAUC ASR debug adapter for NJF voice order.
// Adds detailed handshake/close diagnostics for HTTP 400/403 and supports old/new auth headers.

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
    const next = buffer.indexOf(boundary, pos + boundary.length);
    if (next === -1) break;
    let part = buffer.slice(pos + boundary.length, next);
    if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
    if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
    if (!part.length || part.slice(0, 2).toString() === '--') { pos = next; continue; }
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

function uuid() { return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'); }
function envFirst(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}
function safeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/key|token|authorization|secret/i.test(k)) out[k] = '[hidden]';
    else out[k] = String(v);
  }
  return out;
}
function shortJson(obj, max = 3000) {
  try {
    const s = JSON.stringify(obj, null, 2);
    return s.length > max ? s.slice(0, max) + '...<truncated>' : s;
  } catch { return String(obj); }
}

// Volc protocol frame helper. Header: version/header_size, message_type/flags, serialization/compression, reserved, payload_size, payload.
function buildFrame(messageType, flags, serialization, compression, payload) {
  const header = Buffer.from([(0x01 << 4) | 0x01, (messageType << 4) | flags, (serialization << 4) | compression, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, Buffer.from(payload)]);
}

function parseServerFrame(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 4) return { rawHex: buf.toString('hex'), data: null };
  const byte1 = buf.readUInt8(1);
  const byte2 = buf.readUInt8(2);
  const msgType = (byte1 >> 4) & 0x0f;
  const flags = byte1 & 0x0f;
  const serialization = (byte2 >> 4) & 0x0f;
  const compression = byte2 & 0x0f;

  // Error response often uses type 0x0f.
  if (msgType === 0x0f) {
    let code = 0, message = '';
    try {
      code = buf.length >= 8 ? buf.readUInt32BE(4) : 0;
      const msgSize = buf.length >= 12 ? buf.readUInt32BE(8) : Math.max(0, buf.length - 12);
      message = buf.slice(12, 12 + msgSize).toString('utf8');
    } catch {}
    return { error: true, code, message: message || `Volcengine server error ${code}`, msgType, flags, serialization, compression, rawHex: buf.toString('hex').slice(0, 400) };
  }

  let offset = 4;
  let sequence = null;
  // Some response frames include sequence when flags indicate sequence. Keep tolerant parsing.
  if (buf.length >= 12) {
    try { sequence = buf.readInt32BE(offset); offset += 4; } catch {}
  }
  if (buf.length < offset + 4) return { msgType, flags, sequence, data: null, rawHex: buf.toString('hex').slice(0, 400) };
  let payloadSize = 0;
  try { payloadSize = buf.readUInt32BE(offset); offset += 4; } catch { return { msgType, flags, sequence, data: null }; }
  let payload = buf.slice(offset, offset + payloadSize);
  try { if (compression === 0x01 && payload.length) payload = gunzipSync(payload); } catch (e) { return { error: true, message: 'Failed to gunzip server payload: ' + e.message, rawHex: buf.toString('hex').slice(0, 400) }; }
  const str = payload.toString('utf8');
  let data = null;
  try { data = JSON.parse(str || '{}'); } catch { data = { text: str }; }
  return { msgType, flags, sequence, serialization, compression, data, rawText: str.slice(0, 2000) };
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
    throw new Error('Expected WAV audio. Please upload latest index.html from v23 package.');
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
  const audioFormat = fmt.readUInt16LE(0), channels = fmt.readUInt16LE(2), sampleRate = fmt.readUInt32LE(4), bits = fmt.readUInt16LE(14);
  if (audioFormat !== 1 || bits !== 16) throw new Error(`Only PCM16 WAV is supported, got format=${audioFormat}, bits=${bits}`);
  if (channels !== 1) throw new Error(`Only mono WAV is supported, got channels=${channels}`);
  return { pcm: data, sampleRate, bits, channels };
}

function buildVolcHeaders() {
  const apiKey = envFirst('VOLCENGINE_ASR_API_KEY', 'DOUBAO_ASR_API_KEY');
  const appId = envFirst('VOLCENGINE_ASR_APP_ID', 'DOUBAO_APP_ID', 'VOLCENGINE_APP_KEY');
  const accessToken = envFirst('VOLCENGINE_ASR_ACCESS_TOKEN', 'DOUBAO_ACCESS_TOKEN', 'VOLCENGINE_ACCESS_TOKEN');
  const secretKey = envFirst('VOLCENGINE_ASR_SECRET_KEY', 'DOUBAO_SECRET_KEY');
  const resourceId = envFirst('VOLCENGINE_ASR_RESOURCE_ID', 'DOUBAO_ASR_RESOURCE_ID', 'VOLCENGINE_RESOURCE_ID') || 'volc.seedasr.sauc.duration';
  const requestId = uuid();
  const connectId = uuid();
  const headers = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Connect-Id': connectId,
    'X-Api-Request-Id': requestId,
  };
  // New console: X-Api-Key. Old console: X-Api-App-Key + X-Api-Access-Key.
  if (apiKey) headers['X-Api-Key'] = apiKey;
  else {
    if (!appId || !accessToken) throw new Error('Missing VOLCENGINE_ASR_APP_ID or VOLCENGINE_ASR_ACCESS_TOKEN. If your console provides API Key, set VOLCENGINE_ASR_API_KEY instead.');
    headers['X-Api-App-Key'] = appId;
    headers['X-Api-Access-Key'] = accessToken;
    // Do not send secret key by default; it is kept for future signed-auth interfaces.
    if (process.env.VOLCENGINE_ASR_SEND_SECRET_KEY === '1' && secretKey) headers['X-Api-Secret-Key'] = secretKey;
  }
  return { headers, requestId, connectId, resourceId, authMode: apiKey ? 'X-Api-Key' : 'AppId+AccessToken' };
}

async function transcribeByVolcSauc(audioBuffer, fields) {
  const wsUrl = envFirst('VOLCENGINE_ASR_WS_URL') || 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
  const { pcm, sampleRate } = parseWavPcm(audioBuffer);
  const { headers, requestId, connectId, resourceId, authMode } = buildVolcHeaders();
  const debug = process.env.VOLCENGINE_ASR_DEBUG === '1' || String(fields.debug || '') === '1';

  return await new Promise((resolve, reject) => {
    const diagnostics = {
      wsUrl,
      resourceId,
      authMode,
      requestId,
      connectId,
      audio: { bytes: audioBuffer.length, pcmBytes: pcm.length, sampleRate },
      sentHeaders: safeHeaders(headers),
      serverFrames: []
    };

    const ws = new WebSocket(wsUrl, { headers, perMessageDeflate: false, handshakeTimeout: 15000 });
    const texts = [];
    let bestText = '';
    let finished = false;

    const timeout = setTimeout(() => {
      try { ws.close(); } catch {}
      const err = new Error('Volcengine ASR timeout');
      err.diagnostics = diagnostics;
      reject(err);
    }, Number(process.env.VOLCENGINE_ASR_TIMEOUT_MS || 45000));

    function finish(text) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { ws.close(); } catch {}
      resolve({ text: text || bestText || texts.join(''), diagnostics });
    }

    ws.on('unexpected-response', (req, res) => {
      let body = '';
      res.on('data', chunk => { body += chunk.toString('utf8'); });
      res.on('end', () => {
        const err = new Error(`Volcengine WebSocket handshake failed HTTP ${res.statusCode}: ${body || res.statusMessage || ''}`.trim());
        diagnostics.handshake = { statusCode: res.statusCode, statusMessage: res.statusMessage, headers: safeHeaders(res.headers), body: body.slice(0, 3000) };
        err.diagnostics = diagnostics;
        reject(err);
      });
    });

    ws.on('open', () => {
      // v24: removed productHint/corpus from init payload to avoid corpusCtx JSON parse error.
      const initPayload = {
        user: { uid: process.env.VOLCENGINE_UID || 'njf_voice_order' },
        audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
        request: {
          model_name: process.env.VOLCENGINE_ASR_MODEL_NAME || 'bigmodel',
          model_version: process.env.VOLCENGINE_ASR_MODEL_VERSION || undefined,
          enable_punc: true,
          enable_itn: true,
          enable_ddc: true,
          show_utterances: true
        }
      };
      diagnostics.initPayload = initPayload;
      const init = gzipSync(Buffer.from(JSON.stringify(initPayload), 'utf8'));
      ws.send(buildFrame(0x01, 0x00, 0x01, 0x01, init));

      const chunkSize = Number(process.env.VOLCENGINE_ASR_CHUNK_BYTES || 6400);
      const delayMs = Number(process.env.VOLCENGINE_ASR_CHUNK_DELAY_MS || 80);
      let pos = 0;
      const sendNext = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (pos >= pcm.length) {
          ws.send(buildFrame(0x02, 0x02, 0x00, 0x01, gzipSync(Buffer.alloc(0))));
          return;
        }
        const chunk = pcm.slice(pos, Math.min(pos + chunkSize, pcm.length));
        pos += chunk.length;
        ws.send(buildFrame(0x02, 0x00, 0x00, 0x01, gzipSync(chunk)));
        setTimeout(sendNext, delayMs);
      };
      sendNext();
    });

    ws.on('message', msg => {
      try {
        const parsed = parseServerFrame(msg);
        diagnostics.serverFrames.push(JSON.parse(JSON.stringify(parsed, (k, v) => k === 'rawHex' && String(v).length > 300 ? String(v).slice(0, 300) + '...' : v)));
        if (diagnostics.serverFrames.length > 8) diagnostics.serverFrames.shift();
        if (parsed.error) {
          const err = new Error(`${parsed.code || ''} ${parsed.message || 'Volcengine ASR server error'}`.trim());
          err.diagnostics = diagnostics;
          return reject(err);
        }
        const data = parsed.data;
        if (data?.code && Number(data.code) !== 20000000) {
          const err = new Error(data.message || `Volcengine ASR code ${data.code}`);
          err.diagnostics = diagnostics;
          return reject(err);
        }
        const text = extractText(data);
        if (text) {
          bestText = text;
          const definite = data?.result?.utterances?.some(u => u.definite === true) || parsed.sequence < 0;
          if (definite) texts.push(text);
        }
        if (parsed.sequence < 0 && (bestText || texts.length)) finish(bestText || texts.join(''));
      } catch (e) {
        e.diagnostics = diagnostics;
        reject(e);
      }
    });

    ws.on('error', err => {
      if (!err.diagnostics) err.diagnostics = diagnostics;
      reject(err);
    });

    ws.on('close', (code, reason) => {
      diagnostics.close = { code, reason: Buffer.from(reason || '').toString('utf8') };
      if (!finished) {
        clearTimeout(timeout);
        if (bestText || texts.length) resolve({ text: bestText || texts.join(''), diagnostics });
        else {
          const err = new Error(`Volcengine ASR closed without result. code=${code}, reason=${diagnostics.close.reason || ''}`);
          err.diagnostics = diagnostics;
          reject(err);
        }
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
    const { text, diagnostics } = await transcribeByVolcSauc(audio.buffer, fields || {});
    return res.status(200).json({ text, provider: 'volcengine-sauc-stream-v24', debug: process.env.VOLCENGINE_ASR_DEBUG === '1' ? diagnostics : undefined });
  } catch (err) {
    const diagnostics = err?.diagnostics;
    return res.status(500).json({
      error: err?.message || String(err),
      provider: 'volcengine-sauc-stream-v24',
      diagnostics,
      hint: 'v24 已移除 corpus/context 热词参数。如果仍失败，请把 diagnostics.serverFrames 截图发给我。'
    });
  }
}
