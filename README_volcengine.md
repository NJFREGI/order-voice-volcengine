[README_v34_replace.txt](https://github.com/user-attachments/files/27277760/README_v34_replace.txt)
v34 changed files

Replace only:
- api/transcribe-volc.js

Purpose:
- Apply Doubao bilingual ASR guidance:
  language: ja-JP,zh-CN
  sample_rate: 16000
  format: wav
  crosslingual / cross_language: true
  caption_type: speech
  sdk_version: 2
  hot_words for Chinese/Japanese ordering words and product names

Recommended Vercel env:
VOLCENGINE_ASR_LANGUAGE=ja-JP,zh-CN
VOLCENGINE_ASR_WS_URL=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream
VOLCENGINE_ASR_RESOURCE_ID=volc.bigasr.sauc.duration

Redeploy after replacing.
