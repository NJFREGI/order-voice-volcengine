// api/transcribe-volc.js
// v28: Volcengine SAUC Bigmodel ASR binary protocol version
// Changed file only.
// Fixes "unsupported protocol version 7" caused by sending JSON frames directly.

export const config = {
  api: {
    bodyParser: false
  }
};

import zlib from 'zlib';

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.end(JSON.stringify(data, null, 2));
}

function getEnv(name, fallback = '') {
  return process.env[name] || fallback;
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=([^;]+)/i.exec(contentType || '');
  if (!match) return { fields: {}, files: [] };

  const boundary = '--' + match[1];
  const raw = buffer.toString('binary');
  const parts = raw.split(boundary).slice(1, -1);

  const fields = {};
  const files = [];

  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const sep = cleaned.indexOf('\r\n\r\n');
    if (sep < 0) continue;

    const headerText = cleaned.slice(0, sep);
    const bodyBinary = cleaned.slice(sep + 4);
    const nameMatch = /name="([^"]+)"/i.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerText);
    const name = nameMatch ? nameMatch[1] : '';

    const bodyBuffer = Buffer.from(bodyBinary, 'binary');

    if (filenameMatch) {
      files.push({
        name,
        filename: filenameMatch[1] || 'audio.wav',
        contentType: typeMatch ? typeMatch[1] : 'application/octet-stream',
        buffer: bodyBuffer
      });
    } else if (name) {
      fields[name] = bodyBuffer.toString('utf8').trim();
    }
  }

  return { fields, files };
}

function int32BE(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

function uint32BE(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function gzip(buf) {
  return zlib.gzipSync(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
}

function gunzipMaybe(buf) {
  try {
    return zlib.gunzipSync(buf);
  } catch {
    return buf;
  }
}

// Volcengine binary protocol constants
const PROTOCOL_VERSION = 0x1;
const DEFAULT_HEADER_SIZE = 0x1; // 4 bytes

const MSG_FULL_CLIENT_REQUEST = 0x1;
const MSG_AUDIO_ONLY_REQUEST = 0x2;
const MSG_FULL_SERVER_RESPONSE = 0x9;
const MSG_SERVER_ACK = 0xB;
const MSG_SERVER_ERROR = 0xF;

const FLAG_NO_SEQUENCE = 0x0;
const FLAG_POS_SEQUENCE = 0x1;
const FLAG_NEG_SEQUENCE = 0x2;
const FLAG_NEG_SEQUENCE_1 = 0x3;

const SERIAL_NONE = 0x0;
const SERIAL_JSON = 0x1;

const COMP_NONE = 0x0;
const COMP_GZIP = 0x1;

function makeHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00
  ]);
}

function makeFullClientRequest(obj) {
  const payload = gzip(Buffer.from(JSON.stringify(obj), 'utf8'));
  return Buffer.concat([
    makeHeader(MSG_FULL_CLIENT_REQUEST, FLAG_NO_SEQUENCE, SERIAL_JSON, COMP_GZIP),
    uint32BE(payload.length),
    payload
  ]);
}

function makeAudioRequest(seq, pcmChunk, isLast) {
  const compressed = gzip(pcmChunk);
  // For the final audio packet Volcengine expects a negative sequence flag with sequence field.
  // Use FLAG_NEG_SEQUENCE_1 (0x3), otherwise the server may treat the negative sequence as body size.
  const flags = isLast ? FLAG_NEG_SEQUENCE_1 : FLAG_POS_SEQUENCE;
  const sendSeq = isLast ? -seq : seq;

  return Buffer.concat([
    makeHeader(MSG_AUDIO_ONLY_REQUEST, flags, SERIAL_NONE, COMP_GZIP),
    int32BE(sendSeq),
    uint32BE(compressed.length),
    compressed
  ]);
}

function extractPcmFromWav(input) {
  const buf = Buffer.from(input);

  if (buf.length < 44) return buf;
  const riff = buf.slice(0, 4).toString('ascii');
  const wave = buf.slice(8, 12).toString('ascii');
  if (riff !== 'RIFF' || wave !== 'WAVE') return buf;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.slice(offset, offset + 4).toString('ascii');
    const chunkSize = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;

    if (chunkId === 'data') {
      return buf.slice(dataStart, dataStart + chunkSize);
    }

    offset = dataStart + chunkSize + (chunkSize % 2);
  }

  return buf;
}

function parseServerFrame(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buf.length < 4) {
    return { rawText: buf.toString('utf8') };
  }

  const b0 = buf[0];
  const b1 = buf[1];
  const b2 = buf[2];

  const version = b0 >> 4;
  const headerSize = (b0 & 0x0f) * 4;
  const messageType = b1 >> 4;
  const flags = b1 & 0x0f;
  const serialization = b2 >> 4;
  const compression = b2 & 0x0f;

  let offset = headerSize;
  let sequence = null;
  let errorCode = null;

  if (flags === FLAG_POS_SEQUENCE || flags === FLAG_NEG_SEQUENCE || flags === FLAG_NEG_SEQUENCE_1) {
    if (offset + 4 <= buf.length) {
      sequence = buf.readInt32BE(offset);
      offset += 4;
    }
  }

  if (messageType === MSG_SERVER_ERROR) {
    if (offset + 4 <= buf.length) {
      errorCode = buf.readInt32BE(offset);
      offset += 4;
    }
  }

  let payloadSize = null;
  if (offset + 4 <= buf.length) {
    payloadSize = buf.readUInt32BE(offset);
    offset += 4;
  }

  let payload = buf.slice(offset);
  if (payloadSize !== null && payloadSize >= 0 && offset + payloadSize <= buf.length) {
    payload = buf.slice(offset, offset + payloadSize);
  }

  if (compression === COMP_GZIP && payload.length) {
    payload = gunzipMaybe(payload);
  }

  let text = payload.toString('utf8');
  let jsonPayload = null;

  if (serialization === SERIAL_JSON || text.trim().startsWith('{') || text.trim().startsWith('[')) {
    try {
      jsonPayload = JSON.parse(text);
    } catch {}
  }

  return {
    version,
    headerSize,
    messageType,
    flags,
    serialization,
    compression,
    sequence,
    errorCode,
    payloadSize,
    text,
    json: jsonPayload
  };
}

function getTranscriptFromJson(obj) {
  if (!obj) return '';

  const candidates = [
    obj.text,
    obj.result?.text,
    obj.result?.utterances?.map(u => u.text).join(''),
    obj.result?.[0]?.text,
    obj.payload_msg?.text,
    obj.payload_msg?.result?.text,
    obj.payload_msg?.result?.utterances?.map(u => u.text).join('')
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
  }

  // Deep search fallback
  const found = [];
  function walk(x) {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (k === 'text' && typeof v === 'string' && v.trim()) found.push(v.trim());
      else if (typeof v === 'object') walk(v);
    }
  }
  walk(obj);
  return found.join('').trim();
}

async function callVolcengineASR(audioBuffer) {
  const appId = getEnv('VOLCENGINE_ASR_APP_ID');
  const accessToken = getEnv('VOLCENGINE_ASR_ACCESS_TOKEN');
  const apiKey = getEnv('VOLCENGINE_ASR_API_KEY');
  const resourceId = getEnv('VOLCENGINE_ASR_RESOURCE_ID', 'volc.bigasr.sauc.duration');
  const wsUrl = getEnv('VOLCENGINE_ASR_WS_URL', 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel');
  const language = getEnv('VOLCENGINE_ASR_LANGUAGE', 'zh-CN');
  const debug = getEnv('VOLCENGINE_ASR_DEBUG', '') === '1';

  if (!apiKey && (!appId || !accessToken)) {
    throw new Error('Missing Volcengine credentials. Set VOLCENGINE_ASR_APP_ID + VOLCENGINE_ASR_ACCESS_TOKEN, or VOLCENGINE_ASR_API_KEY.');
  }

  let WebSocket;
  try {
    const wsModule = await import('ws');
    WebSocket = wsModule.default || wsModule.WebSocket;
  } catch (err) {
    throw new Error('Missing dependency "ws". package.json must include "ws". Original: ' + err.message);
  }

  const requestId = 'njf-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const headers = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': requestId,
    'Host': 'openspeech.bytedance.com'
  };

  if (appId && accessToken) {
    headers['X-Api-App-Key'] = appId;
    headers['X-Api-Access-Key'] = accessToken;
  }
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  const pcm = extractPcmFromWav(audioBuffer);

  const startRequest = {
    app: {
      appid: appId || 'default',
      token: accessToken || apiKey || ''
    },
    user: {
      uid: 'njf-regi'
    },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16000,
      bits: 16,
      channel: 1,
      language
    },
    request: {
      reqid: requestId,
      workflow: 'audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate',
      show_utterances: true,
      result_type: 'full',
      sequence: 1
    }
  };

  return await new Promise((resolve, reject) => {
    const diagnostics = {
      wsUrl,
      resourceId,
      language,
      requestId,
      authMode: apiKey ? 'api_key' : 'app_id_access_token',
      wavBytes: audioBuffer.length,
      pcmBytes: pcm.length,
      serverFrames: [],
      parsedFrames: [],
      close: null
    };

    const ws = new WebSocket(wsUrl, { headers });

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Volcengine ASR timeout. diagnostics=' + JSON.stringify(diagnostics)));
    }, 30000);

    let finalText = '';

    ws.on('open', () => {
      try {
        ws.send(makeFullClientRequest(startRequest));

        // 100ms chunks: 16kHz * 16bit mono = 32000 bytes/s, 100ms = 3200 bytes.
        const chunkSize = 3200;
        // The initial full-client-request is counted by Volcengine as sequence 1.
        // Therefore audio chunks must start from sequence 2.
        let seq = 2;
        for (let offset = 0; offset < pcm.length; offset += chunkSize) {
          const chunk = pcm.slice(offset, Math.min(offset + chunkSize, pcm.length));
          const isLast = offset + chunkSize >= pcm.length;
          ws.send(makeAudioRequest(seq, chunk, isLast));
          seq += 1;
        }
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    ws.on('message', (data) => {
      const parsed = parseServerFrame(data);
      diagnostics.parsedFrames.push({
        messageType: parsed.messageType,
        flags: parsed.flags,
        sequence: parsed.sequence,
        errorCode: parsed.errorCode,
        text: parsed.text ? parsed.text.slice(0, 1000) : ''
      });

      if (parsed.text) diagnostics.serverFrames.push(parsed.text.slice(0, 1000));

      if (parsed.messageType === MSG_SERVER_ERROR || parsed.errorCode) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error('Volcengine server error: ' + (parsed.text || '') + ' diagnostics=' + JSON.stringify(diagnostics)));
        return;
      }

      const text = getTranscriptFromJson(parsed.json);
      if (text) finalText = text;

      // Usually negative sequence or final response indicates completion.
      if (parsed.sequence !== null && parsed.sequence < 0 && finalText) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({ text: finalText, diagnostics: debug ? diagnostics : undefined });
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      diagnostics.close = { code, reason: reason ? reason.toString() : '' };

      if (finalText) {
        resolve({ text: finalText, diagnostics: debug ? diagnostics : undefined });
        return;
      }

      reject(new Error('Volcengine WebSocket closed without transcript. diagnostics=' + JSON.stringify(diagnostics)));
    });

    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error('Volcengine WebSocket error: ' + err.message + ' diagnostics=' + JSON.stringify(diagnostics)));
    });
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'NJF REGI Volcengine ASR endpoint v28',
        method: 'POST',
        message: 'Function is alive. Send multipart/form-data with an audio file field named audio.',
        env: {
          hasAppId: !!process.env.VOLCENGINE_ASR_APP_ID,
          hasAccessToken: !!process.env.VOLCENGINE_ASR_ACCESS_TOKEN,
          hasApiKey: !!process.env.VOLCENGINE_ASR_API_KEY,
          resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID || '',
          wsUrl: process.env.VOLCENGINE_ASR_WS_URL || '',
          language: process.env.VOLCENGINE_ASR_LANGUAGE || '',
          debug: process.env.VOLCENGINE_ASR_DEBUG || ''
        }
      });
    }

    if (req.method !== 'POST') {
      return json(res, 405, { ok: false, error: 'Only GET and POST are supported.' });
    }

    if (process.env.VOLCENGINE_MOCK_TEXT && process.env.VOLCENGINE_MOCK_TEXT.trim()) {
      return json(res, 200, {
        ok: true,
        text: process.env.VOLCENGINE_MOCK_TEXT.trim(),
        mock: true
      });
    }

    const contentType = req.headers['content-type'] || '';
    const raw = await readRawBody(req);

    let audioFile = null;

    if (contentType.includes('multipart/form-data')) {
      const parsed = parseMultipart(raw, contentType);
      audioFile = parsed.files.find(f => f.name === 'audio') || parsed.files[0] || null;
    } else if (contentType.includes('application/json')) {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      if (body.audio_base64) {
        audioFile = {
          name: 'audio',
          filename: 'audio.wav',
          contentType: 'audio/wav',
          buffer: Buffer.from(body.audio_base64, 'base64')
        };
      }
    }

    if (!audioFile) {
      return json(res, 400, {
        ok: false,
        error: 'No audio found. Send multipart/form-data with field "audio", or JSON with audio_base64.'
      });
    }

    if (!audioFile.buffer || audioFile.buffer.length < 800) {
      return json(res, 400, {
        ok: false,
        error: 'Audio is too short or empty.',
        audioBytes: audioFile.buffer ? audioFile.buffer.length : 0
      });
    }

    const result = await callVolcengineASR(audioFile.buffer);

    return json(res, 200, {
      ok: true,
      text: result.text || '',
      diagnostics: result.diagnostics
    });
  } catch (err) {
    return json(res, 500, {
      ok: false,
      error: err && err.message ? err.message : String(err),
      stack: process.env.VOLCENGINE_ASR_DEBUG === '1' && err && err.stack ? err.stack : undefined
    });
  }
}
