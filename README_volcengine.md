[README_v31_frontend_patch.txt](https://github.com/user-attachments/files/27270488/README_v31_frontend_patch.txt)
// v31 frontend patch for index.html
// Add this language field to the FormData before calling /api/transcribe-volc:
//
// const voiceLang = currentLang === 'ja' ? 'ja-JP' : 'zh-CN';
// formData.append('language', voiceLang);
//
// If your voice modal has its own language selector, use:
// formData.append('language', document.getElementById('voiceAsrLang')?.value || (currentLang === 'ja' ? 'ja-JP' : 'zh-CN'));
//
// Recommended UI selector:
// <select id="voiceAsrLang">
//   <option value="zh-CN">中文</option>
//   <option value="ja-JP">日本語</option>
//   <option value="auto">自动</option>
// </select>
