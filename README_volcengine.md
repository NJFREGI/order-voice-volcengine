[README_volcengine.md](https://github.com/user-attachments/files/27226669/README_volcengine.md)
# NJF 订货系统 v20 - 火山引擎流式 ASR 真实识别版

v20 不再需要公网音频 URL。流程为：手机按住说话 → 前端生成 16k 单声道 WAV → 上传到 Vercel `/api/transcribe-volc` → 后端通过 WebSocket 调用火山引擎流式语音识别 → 返回文字 → 前端匹配商品。

## Vercel 环境变量

真实识别时，请删除或留空：

```env
VOLCENGINE_MOCK_TEXT
```

添加：

```env
VOLCENGINE_ASR_APP_ID=火山引擎 APP ID
VOLCENGINE_ASR_ACCESS_TOKEN=火山引擎 Access Token
VOLCENGINE_ASR_SECRET_KEY=火山引擎 Secret Key（当前代码暂不使用，但建议保存）
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
```

如果你的服务是“豆包流式语音识别模型2.0-小时版”，可以把资源 ID 改成：

```env
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
```

保存环境变量后，必须重新部署：Deployments → 最新部署右侧 `...` → Redeploy。

## 重要

- `index.html`、`vercel.json`、`package.json`、`api/` 必须在 GitHub 仓库最外层。
- API Key 不要写进 HTML。
- 浏览器必须用 HTTPS 才能录音。
- 若失败，请查看 Vercel → Logs 中 `/api/transcribe-volc` 的错误。
