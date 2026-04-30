[README_volcengine.md](https://github.com/user-attachments/files/27264434/README_volcengine.md)
# NJF 订货系统 v22 - 火山引擎 ASR 403 修正版

v22 支持两种鉴权：

1. 新版控制台：`VOLCENGINE_ASR_API_KEY`
2. 旧版控制台：`VOLCENGINE_ASR_APP_ID` + `VOLCENGINE_ASR_ACCESS_TOKEN`

推荐先在 Vercel 填：

```text
VOLCENGINE_ASR_API_KEY=你的火山引擎 APP Key / API Key
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
```

如果你确认是模型 2.0 小时版，把资源 ID 改为：

```text
VOLCENGINE_ASR_RESOURCE_ID=volc.seedasr.sauc.duration
```

真实测试时请删除或清空：

```text
VOLCENGINE_MOCK_TEXT
```

修改环境变量后必须重新部署。
