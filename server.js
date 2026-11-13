'use strict';
const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));

// ۱۔ ہوم اور ہیلتھ چیک روٹ
app.get('/', (req, res) => {
  res.json({
    ok: true,
    brand: 'Zaidi Tech API Hub',
    endpoints: {
      movies: '/movies/search یا /stream/:subjectId',
      youtube: '/api/youtube/download?url=...',
      sports: '/sports/list'
    }
  });
});

// ۲. مووی باکس API کو یہاں ماؤنٹ کریں (जो آپ کے پاس پہلے سے ہے)
try {
  const movieboxModule = require('./moviebox-final');
  // اگر moviebox-final خود express app ہے تو اسے ماؤنٹ کریں:
  app.use('/', movieboxModule.app || movieboxModule);
  console.log('✅ MovieBox API mounted successfully.');
} catch (e) {
  console.error('❌ MovieBox mount failed:', e.message);
}

// ۳. اگر آپ کے پاس یوٹیوب ڈاؤنلوڈر یا دیگر اسکریپٹس ہیں، تو انہیں اس طرح جوڑیں:
try {
  const youtubeRouter = require('./routes/youtube');
  app.use('/api/youtube', youtubeRouter);
  console.log('✅ YouTube Downloader API mounted successfully.');
} catch (e) {
  console.log('ℹ️ YouTube router not found yet (add it in routes/youtube.js when ready).');
}

// سرور لسننگ
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`🚀 Zaidi API Hub is running live on port ${PORT}`);
});
