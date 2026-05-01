// api/transcribe-volc.js
// v27: safer Vercel function wrapper for Volcengine ASR
// - GET returns health check instead of crashing
// - POST errors return JSON instead of Vercel 500 page
// - dynamic ws import to avoid top-level crash
// - supports multipart/form-data upload from browser

export const config = {
  api: {
    bodyParser: false
  }
};

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
        filename: filenameMatch[1] || 'audio.webm',
        contentType: typeMatch ? typeMatch[1] : 'application/octet-stream',
        buffer: bodyBuffer
      });
    } else if (name) {
      fields[name] = bodyBuffer.toString('utf8').trim();
    }
  }

  return { fields, files };
}

function safeBase64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

/**
 * NOTE:
 * This function keeps the Volcengine call wrapped and debuggable.
 * The exact binary protocol may still need adjustment depending on
 * your Volcengine service version. This version prevents crashes and
 * returns useful diagnostics to the frontend.
 */
async function callVolcengineASR(audioBuffer, debugInfo = {}) {
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
    throw new Error('Missing dependency "ws". Please make sure package.json includes "ws". Original: ' + err.message);
  }

  const requestId = 'njf-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  const headers = {
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': requestId,
    'X-Api-Connect-Id': requestId
  };

  // Old console credentials
  if (appId && accessToken) {
    headers['X-Api-App-Key'] = appId;
    headers['X-Api-Access-Key'] = accessToken;
  }

  // New console API key
  if (apiKey) {
    headers['X-Api-Key'] = apiKey;
  }

  return await new Promise((resolve, reject) => {
    const diagnostics = {
      wsUrl,
      resourceId,
      language,
      requestId,
      authMode: apiKey ? 'api_key' : 'app_id_access_token',
      audioBytes: audioBuffer.length,
      serverFrames: [],
      close: null
    };

    const ws = new WebSocket(wsUrl, { headers });

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Volcengine ASR timeout. diagnostics=' + JSON.stringify(diagnostics)));
    }, 30000);

    ws.on('open', () => {
      try {
        // Many Volcengine SAUC examples use a binary protocol.
        // To avoid sending invalid corpus/context, v27 sends a minimal JSON control packet first,
        // then raw audio as a separate binary frame. If your service requires the strict binary
        // protocol, the returned diagnostics will show the exact server error.
        const startPayload = {
          user: { uid: 'njf-regi' },
          audio: {
            format: 'wav',
            codec: 'raw',
            rate: 16000,
            bits: 16,
            channel: 1,
            language
          },
          request: {
            model_name: 'bigmodel',
            enable_itn: true,
            enable_punc: true,
            result_type: 'full'
          }
        };

        ws.send(JSON.stringify(startPayload));
        ws.send(audioBuffer);
        ws.send(JSON.stringify({ end: true }));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });

    ws.on('message', (data) => {
      const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
      diagnostics.serverFrames.push(text.slice(0, 1000));

      try {
        const obj = JSON.parse(text);
        const resultText =
          obj.text ||
          obj.result?.text ||
          obj.result?.[0]?.text ||
          obj.payload_msg?.result?.text ||
          obj.payload_msg?.text ||
          '';

        if (resultText) {
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve({ text: resultText, diagnostics: debug ? diagnostics : undefined });
        }

        if (obj.error || obj.code || obj.message) {
          // Do not reject immediately because some APIs send intermediate messages.
          diagnostics.lastParsed = obj;
        }
      } catch {
        // Keep raw server frame for diagnostics.
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      diagnostics.close = { code, reason: reason ? reason.toString() : '' };

      const joined = diagnostics.serverFrames.join('\n');
      const maybeText = extractLikelyText(joined);
      if (maybeText) {
        resolve({ text: maybeText, diagnostics: debug ? diagnostics : undefined });
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

function extractLikelyText(raw) {
  if (!raw) return '';
  try {
    const matches = [...raw.matchAll(/"text"\s*:\s*"([^"]+)"/g)];
    if (matches.length) return matches.map(m => m[1]).join('');
  } catch {}
  return '';
}

export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'NJF REGI Volcengine ASR endpoint',
        method: 'POST',
        message: 'Function is alive. Send multipart/form-data with an audio file field named audio.',
        env: {
          hasAppId: !!process.env.VOLCENGINE_ASR_APP_ID,
          hasAccessToken: !!process.env.VOLCENGINE_ASR_ACCESS_TOKEN,
          hasApiKey: !!process.env.VOLCENGINE_ASR_API_KEY,
          resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID || '',
          wsUrl: process.env.VOLCENGINE_ASR_WS_URL || '',
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
    let audioUrl = '';

    if (contentType.includes('multipart/form-data')) {
      const parsed = parseMultipart(raw, contentType);
      audioFile = parsed.files.find(f => f.name === 'audio') || parsed.files[0] || null;
      audioUrl = parsed.fields.audio_url || '';
    } else if (contentType.includes('application/json')) {
      const body = JSON.parse(raw.toString('utf8') || '{}');
      audioUrl = body.audio_url || '';
      if (body.audio_base64) {
        audioFile = {
          name: 'audio',
          filename: 'audio.wav',
          contentType: 'audio/wav',
          buffer: Buffer.from(body.audio_base64, 'base64')
        };
      }
    }

    if (!audioFile && !audioUrl) {
      return json(res, 400, {
        ok: false,
        error: 'No audio found. Send multipart/form-data with field "audio", or JSON with audio_base64/audio_url.'
      });
    }

    if (audioUrl) {
      return json(res, 501, {
        ok: false,
        error: 'audio_url mode is not implemented in this endpoint. Please upload audio file as multipart field "audio".'
      });
    }

    if (!audioFile.buffer || audioFile.buffer.length < 800) {
      return json(res, 400, {
        ok: false,
        error: 'Audio is too short or empty.',
        audioBytes: audioFile.buffer ? audioFile.buffer.length : 0
      });
    }

    const result = await callVolcengineASR(audioFile.buffer, {
      filename: audioFile.filename,
      contentType: audioFile.contentType
    });

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
