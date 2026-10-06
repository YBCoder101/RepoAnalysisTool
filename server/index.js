'use strict';

const path = require('path');
const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');

app.use(express.json({ limit: '10mb' }));

// Frontend (static dashboard served from /public)
app.use(express.static(path.join(ROOT, 'public')));

// Chart.js UMD build served straight from node_modules (no bundler/build step)
app.use(
  '/vendor/chart.js',
  express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist'))
);

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'RAT',
    version: require(path.join(ROOT, 'package.json')).version,
  });
});

app.listen(PORT, () => {
  console.log(`[RAT] Repo Analysis Tool listening on http://localhost:${PORT}`);
});
