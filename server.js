'use strict';
const express = require('express');
const path = require('path');
const { scrapeVideo } = require('./yt-downloader'); // یوٹیوب ڈاؤنلوڈر ماڈیول امپورٹ

const app = express();
app.use(express.json({ limit: '10mb' }));

// سٹیटिक ایچ ٹی ایم ایل ڈیش بورڈ ماؤنٹ کرنا
app.use(express.static(path.join(__dirname, 'public')));

// ۱. ہوم اور ہیلتھ چیک روٹس
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'zaidi-api-hub', status: 'Active' });
});

// ۲. یوٹیوب ڈاؤنلوڈر API اینڈپॉइंट (HTML فرنٹ اینڈ اور بوٹ دونوں کے لیے)
app.get('/api/youtube', async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ ok: false, error: 'URL parameter is required' });
  }
  try {
    const result = await scrapeVideo(videoUrl);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ۳. مووی باکس API اور باقی تمام روٹس کو ماؤنٹ کرنا
try {
  const movieboxModule = require('./moviebox-final');
  app.use('/', movieboxModule.app || movieboxModule);
  console.log('✅ MovieBox API mounted successfully.');
} catch (e) {
  console.error('❌ MovieBox mount failed:', e.message);
}

// ۴. پورٹ اور اینٹی سلیپ (Anti-Sleep) سسٹم
const PORT = process.env.PORT || 8787;
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`🚀 Zaidi API Hub is running live on port ${PORT}`);

  // اینٹی سلیپ کیپ-الائیو لوپ (ہر 10 منٹ بعد)
  const PING_INTERVAL = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      const response = await fetch(`${APP_URL}/health`);
      console.log(`[Anti-Sleep] Self ping successful! Status: ${response.status}`);
    } catch (error) {
      console.error('[Anti-Sleep] Self ping failed:', error.message);
    }
  }, PING_INTERVAL);
});
