# NJF 订货系统 v19 - 火山引擎语音订货版

## 这版包含

- `index.html`：完整前端页面，语音订货按钮为“按住说话，松开识别”。
- `api/transcribe-volc.js`：Vercel 后端接口，不在前端暴露 Key。
- `vercel.json`：Vercel 部署配置。
- `.env.example`：环境变量示例。

## 重要说明

火山引擎大模型录音文件识别 AUC 的标准接口通常是：

1. 提交任务：`https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit`
2. 查询结果：`https://openspeech.bytedance.com/api/v3/auc/bigmodel/query`

AUC 方式需要音频文件的公网 URL。因此这个后端提供三种方式：

### 方式 A：先用 Mock 测试前端

在 Vercel 环境变量里设置：

```env
VOLCENGINE_MOCK_TEXT=干豆腐三袋，鸡腿肉两包，豆腐皮一份
```

### 方式 B：使用自己的 ASR Proxy

如果你已经有一个火山引擎 ASR 后端接口，可以设置：

```env
VOLCENGINE_ASR_PROXY_URL=https://your-asr-proxy.example.com/transcribe
```

前端录音文件会转发到这个 Proxy。

### 方式 C：上传音频到公网 URL 后调用火山 AUC

你需要准备一个上传接口，返回：

```json
{"url":"https://example.com/audio.webm"}
```

然后在 Vercel 设置：

```env
VOLCENGINE_AUDIO_UPLOAD_URL=https://your-upload-service.example.com/upload
VOLCENGINE_APP_KEY=你的APP ID
VOLCENGINE_ACCESS_KEY=你的Access Token
VOLCENGINE_RESOURCE_ID=volc.bigasr.auc
```

## 前端 API 地址

部署 Vercel 后，前端语音弹窗里的 API 地址填：

```text
https://你的项目.vercel.app/api/transcribe-volc
```

如果 `index.html` 也部署在同一个 Vercel 项目，默认 `/api/transcribe-volc` 即可。

