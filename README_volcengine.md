[README_v33_replace.txt](https://github.com/user-attachments/files/27270786/README_v33_replace.txt)
v33 changed files

Replace only:
- api/transcribe-volc.js

Reason:
- Add top-level language: ja-JP
- Add sdk_version: "2"
- Keep bigmodel_nostream support

Recommended Vercel env for Japanese test:
VOLCENGINE_ASR_LANGUAGE=ja-JP
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration

After replacing, redeploy Vercel.
