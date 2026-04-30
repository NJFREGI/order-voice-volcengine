// Vercel Serverless Function: /api/transcribe-volc
// Volcengine / Doubao ASR adapter for NJF order voice input.
// IMPORTANT:
// 1) Do NOT put any key in index.html.
// 2) For Volcengine AUC recording-file API, the audio must be accessible by a public URL.
//    This function supports either:
//    A. VOLCENGINE_ASR_PROXY_URL: forward the browser-recorded file to your own ASR proxy.
//    B. VOLCENGINE_AUDIO_UPLOAD_URL: upload the audio file to your storage service, then submit the returned URL to Volcengine AUC.
//    C. audio_url field: submit an existing public audio URL to Volcengine AUC.
//    D. VOLCENGINE_MOCK_TEXT: testing only.

export const config = { maxDuration: 60 };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function collectRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseContentDisposition(header) {
  const out = {};
  const parts = String(header || '').split(';').map(s => s.trim());
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq > -1) {
      const key = p.slice(0, eq).trim().toLowerCase();
      let val = p.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      out[key] = val;
    }
  }
  return out;
}

function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:(?:"([^"]+)")|([^;]+))/i.exec(contentType || '');
  if (!m) throw new Error('Missing multipart boundary');
  const boundary = Buffer.from('--' + (m[1] || m[2]));
  const fields = {};
  const files = {};
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
      if (disp.filename) {
        files[disp.name] = { filename: disp.filename, contentType: headers['content-type'] || 'application/octet-stream', buffer: body };
      } else {
        fields[disp.name] = body.toString('utf8');
      }
    }
    pos = next;
  }
  return { fields, files };
}

async function forwardToProxy({ audio, fields }) {
  const endpoint = process.env.VOLCENGINE_ASR_PROXY_URL;
  if (!endpoint) return null;
  const form = new FormData();
  const blob = new Blob([audio.buffer], { type: audio.contentType || 'audio/webm' });
  form.append('audio', blob, audio.filename || 'voice_order.webm');
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  const headers = {};
  if (process.env.VOLCENGINE_ASR_PROXY_AUTH_HEADER && process.env.VOLCENGINE_ASR_PROXY_AUTH_VALUE) {
    headers[process.env.VOLCENGINE_ASR_PROXY_AUTH_HEADER] = process.env.VOLCENGINE_ASR_PROXY_AUTH_VALUE;
  }
  const resp = await fetch(endpoint, { method: 'POST', headers, body: form });
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { text: raw }; }
  if (!resp.ok) throw new Error(data?.error || data?.message || raw || `Proxy HTTP ${resp.status}`);
  return data.text || data.transcript || data.result?.text || '';
}

async function uploadAudioToPublicUrl(audio, fields) {
  const endpoint = process.env.VOLCENGINE_AUDIO_UPLOAD_URL;
  if (!endpoint) return null;
  const form = new FormData();
  const blob = new Blob([audio.buffer], { type: audio.contentType || 'audio/webm' });
  form.append('audio', blob, audio.filename || 'voice_order.webm');
  for (const [k, v] of Object.entries(fields || {})) form.append(k, v);
  const headers = {};
  if (process.env.VOLCENGINE_AUDIO_UPLOAD_AUTH_HEADER && process.env.VOLCENGINE_AUDIO_UPLOAD_AUTH_VALUE) {
    headers[process.env.VOLCENGINE_AUDIO_UPLOAD_AUTH_HEADER] = process.env.VOLCENGINE_AUDIO_UPLOAD_AUTH_VALUE;
  }
  const resp = await fetch(endpoint, { method: 'POST', headers, body: form });
  const raw = await resp.text();
  let data;
  try { data = JSON.parse(raw); } catch { data = { url: raw }; }
  if (!resp.ok) throw new Error(data?.error || data?.message || raw || `Upload HTTP ${resp.status}`);
  return data.url || data.audio_url || data.file_url;
}

function makeHeaders(taskId, xTtLogid) {
  const appKey = process.env.VOLCENGINE_APP_KEY;
  const accessKey = process.env.VOLCENGINE_ACCESS_KEY;
  if (!appKey || !accessKey) throw new Error('Missing VOLCENGINE_APP_KEY or VOLCENGINE_ACCESS_KEY');
  const headers = {
    'Content-Type': 'application/json',
    'X-Api-App-Key': appKey,
    'X-Api-Access-Key': accessKey,
    'X-Api-Resource-Id': process.env.VOLCENGINE_RESOURCE_ID || 'volc.bigasr.auc',
    'X-Api-Request-Id': taskId,
  };
  if (xTtLogid) headers['X-Tt-Logid'] = xTtLogid;
  else headers['X-Api-Sequence'] = '-1';
  return headers;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function extractTextFromVolc(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (data.text) return data.text;
  if (data.transcript) return data.transcript;
  if (data.result?.text) return data.result.text;
  if (Array.isArray(data.result?.utterances)) return data.result.utterances.map(u => u.text || '').join('');
  if (Array.isArray(data.utterances)) return data.utterances.map(u => u.text || '').join('');
  if (Array.isArray(data.result)) return data.result.map(x => x.text || x.sentence || '').join('');
  // Some responses are nested under data.result / data.audio_info etc.
  try {
    const all = [];
    JSON.stringify(data, (k, v) => {
      if ((k === 'text' || k === 'utterance' || k === 'sentence') && typeof v === 'string') all.push(v);
      return v;
    });
    return [...new Set(all)].join('');
  } catch { return ''; }
}

async function transcribeByAuc(audioUrl, fields) {
  const submitUrl = process.env.VOLCENGINE_SUBMIT_URL || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit';
  const queryUrl = process.env.VOLCENGINE_QUERY_URL || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query';
  const taskId = uuid();
  const submitBody = {
    user: { uid: process.env.VOLCENGINE_UID || process.env.VOLCENGINE_APP_KEY || 'njf_voice_order' },
    audio: { url: audioUrl },
    request: {
      model_name: process.env.VOLCENGINE_MODEL_NAME || 'bigmodel',
      corpus: fields.product_hint ? { context: String(fields.product_hint).slice(0, 2500) } : undefined,
    },
  };
  const submitResp = await fetch(submitUrl, {
    method: 'POST',
    headers: makeHeaders(taskId),
    body: JSON.stringify(submitBody),
  });
  const submitText = await submitResp.text();
  const statusCode = submitResp.headers.get('X-Api-Status-Code');
  const message = submitResp.headers.get('X-Api-Message');
  const xTtLogid = submitResp.headers.get('X-Tt-Logid') || '';
  if (!submitResp.ok || (statusCode && statusCode !== '20000000')) {
    throw new Error(`Volcengine submit failed: ${statusCode || submitResp.status} ${message || submitText}`);
  }

  const maxPoll = Number(process.env.VOLCENGINE_QUERY_MAX || 12);
  const interval = Number(process.env.VOLCENGINE_QUERY_INTERVAL_MS || 1200);
  for (let i = 0; i < maxPoll; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 500 : interval));
    const queryResp = await fetch(queryUrl, {
      method: 'POST',
      headers: makeHeaders(taskId, xTtLogid),
      body: JSON.stringify({}),
    });
    const raw = await queryResp.text();
    let data;
    try { data = JSON.parse(raw || '{}'); } catch { data = { text: raw }; }
    const qCode = queryResp.headers.get('X-Api-Status-Code');
    const qMsg = queryResp.headers.get('X-Api-Message');
    if (qCode === '20000000') return extractTextFromVolc(data);
    if (qCode === '20000001' || qCode === '20000002') continue;
    if (!qCode && queryResp.ok) {
      const text = extractTextFromVolc(data);
      if (text) return text;
    }
    throw new Error(`Volcengine query failed: ${qCode || queryResp.status} ${qMsg || raw}`);
  }
  throw new Error('Volcengine query timeout');
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

    if (audio) {
      const proxyText = await forwardToProxy({ audio, fields });
      if (proxyText != null) return res.status(200).json({ text: proxyText, provider: 'volcengine-proxy' });
    }

    let audioUrl = fields.audio_url || fields.url || '';
    if (!audioUrl && audio) audioUrl = await uploadAudioToPublicUrl(audio, fields);
    if (!audioUrl) {
      return res.status(501).json({
        error: 'Volcengine AUC requires a public audio URL. Set VOLCENGINE_ASR_PROXY_URL, or set VOLCENGINE_AUDIO_UPLOAD_URL to upload audio and return {url}, or send audio_url.',
      });
    }

    const text = await transcribeByAuc(audioUrl, fields);
    return res.status(200).json({ text, provider: 'volcengine-auc' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || String(err) });
  }
}
