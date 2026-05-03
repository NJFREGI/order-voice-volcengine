[README_restore_chinese.md](https://github.com/user-attachments/files/27311325/README_restore_chinese.md)
# NJF 订货系统 - 火山引擎中文语音识别恢复版

## 包含文件

- `index.html`：前端完整页面
- `api/transcribe-volc.js`：火山引擎 ASR 后端接口，中文稳定恢复版
- `package.json`：Vercel Node 依赖
- `vercel.json`：Vercel 路由与函数配置
- `.env.example`：环境变量示例

## 部署方法

把本包内所有文件上传/覆盖到 GitHub 仓库根目录：

```text
order-voice-volcengine/
├── index.html
├── package.json
├── vercel.json
├── .env.example
└── api/
    └── transcribe-volc.js
```

然后 Commit，回到 Vercel 重新 Redeploy。

## Vercel 环境变量

请在 Vercel → Environment Variables 设置：

```text
VOLCENGINE_ASR_APP_ID=5522110374
VOLCENGINE_ASR_ACCESS_TOKEN=你的AccessToken
VOLCENGINE_ASR_SECRET_KEY=你的SecretKey
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
VOLCENGINE_ASR_LANGUAGE=zh-CN
```

## 检查接口

部署后打开：

```text
https://order-voice-volcengine.vercel.app/api/transcribe-volc
```

看到 JSON 返回说明接口正常。

## 测试语音

中文测试：

```text
干豆腐三袋，豆腐四条
```

## 说明

这个包是中文识别稳定恢复版。日语识别暂时不走火山，避免影响中文稳定性。
