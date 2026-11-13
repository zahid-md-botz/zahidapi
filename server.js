'use strict';
const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

// ۱۔ ہوم اور ہیلتھ چیک روٹس (کوئی اینڈ پوائنٹ بلاک نہیں ہوگا)
app.get('/', (req, res) => {
  res.json({
    ok: true,
    brand: 'Zaidi Tech API Hub',
    endpoints: {
      movies: '/movies/search یا /stream/:subjectId',
      sports: '/sports/list'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'moviebox-single' });
});

// ۲. مووی باکس API اور باقی تمام روٹس کو یہاں ماؤنٹ کریں
try {
  const movieboxModule = require('./moviebox-final');
  app.use('/', movieboxModule.app || movieboxModule);
  console.log('✅ MovieBox API mounted successfully.');
} catch (e) {
  console.error('❌ MovieBox mount failed:', e.message);
}

// ۳. پورٹ اور اینٹی سلیپ (Anti-Sleep) سسٹم
const PORT = process.env.PORT || 8787;
// Render کا اپنا لائیو URL خود اٹھا لے گا، ورنہ لوکل ہوسٹ استعمال ہوگا
const APP_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`🚀 Zaidi API Hub is running live on port ${PORT}`);

  // ---------------------------------------------------------
  // اینٹی سلیپ (Anti-Sleep) کیپ-الائیو لوپ
  // ہر 10 منٹ (600,000 ملی سیکنڈ) بعد خود کو پنگ کرے گا تاکہ سرور ایکٹیو رہے
  // ---------------------------------------------------------
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
