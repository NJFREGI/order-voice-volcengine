[README_volcengine.md](https://github.com/user-attachments/files/27246787/README_volcengine.md)
# NJF 订货系统 v23 - 火山引擎 SAUC v3 官方协议版

## 上传到 GitHub
请把这些文件放到仓库最外层：

- index.html
- api/transcribe-volc.js
- package.json
- vercel.json
- .env.example
- README_volcengine.md

不要再多一层文件夹。

## Vercel 环境变量

推荐先填写：

```txt
VOLCENGINE_ASR_APP_ID=5522110374
VOLCENGINE_ASR_ACCESS_TOKEN=你的 Access Token
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
```

如果你的新版控制台只有 X-Api-Key，则填写：

```txt
VOLCENGINE_ASR_API_KEY=你的 X-Api-Key
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
```

如果还保留 `VOLCENGINE_MOCK_TEXT`，会一直返回模拟文字，不会调用火山引擎。

## 重要

每次修改环境变量后，必须在 Vercel 的 Deployments 里 Redeploy。

## v23 修复点

- 按火山引擎官方 SAUC v3 二进制协议发包。
- 增加 `X-Api-Request-Id` 和 `X-Api-Sequence`。
- 最后一包改成“带音频数据的最后一包”，不再发送空音频最后包。
- 默认使用 `bigmodel_nostream`，更适合按住说话、松开后识别。
