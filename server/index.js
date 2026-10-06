'use strict';

const path = require('path');
const express = require('express');
const multer = require('multer');

const { Store } = require('./store');
const { startUrlIngest, startZipIngest } = require('./ingest');
const { computeMetrics, listCommits, listAuthors, listTree, listPaths } = require('./metrics');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const CACHE = path.join(ROOT, '.cache');

const store = new Store(CACHE);
store.loadAll();

const app = express();
app.use(express.json({ limit: '10mb' }));

const upload = multer({
  dest: path.join(CACHE, 'uploads'),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// --- API --------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    app: 'RAT',
    version: require(path.join(ROOT, 'package.json')).version,
    repos: store.repos.size,
  });
});

app.get('/api/repos', (req, res) => {
  res.json(store.list());
});

app.get('/api/repos/:id', (req, res) => {
  const repo = store.get(req.params.id);
  if (!repo) return res.status(404).json({ error: 'unknown repository' });
  res.json(store.summary(repo));
});

app.post('/api/repos/url', (req, res) => {
  const url = String((req.body && req.body.url) || '').trim();
  if (!url) return res.status(400).json({ error: 'url is required' });
  const repo = store.create('repository', { type: 'url', url });
  startUrlIngest(store, repo, url);
  res.status(201).json(store.summary(repo));
});

app.post('/api/repos/zip', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field "file")' });
  const original = req.file.originalname || 'repository.zip';
  const name = original.replace(/\.[Zz][Ii][Pp]$/, '') || 'repository';
  const repo = store.create(name, { type: 'zip', file: original });
  startZipIngest(store, repo, req.file.path, original);
  res.status(201).json(store.summary(repo));
});

app.delete('/api/repos/:id', async (req, res) => {
  const ok = await store.remove(req.params.id);
  if (!ok) return res.status(404).json({ error: 'unknown repository' });
  res.status(204).end();
});

// --- metrics API ------------------------------------------------------------

const requireReadyRepo = (req, res, next) => {
  const repo = store.get(req.params.id);
  if (!repo) return res.status(404).json({ error: 'unknown repository' });
  if (repo.status !== 'ready') {
    return res.status(409).json({ error: 'repository is not ready yet', status: repo.status, phase: repo.phase });
  }
  req.repo = repo;
  next();
};

app.get('/api/repos/:id/commits', requireReadyRepo, (req, res) => {
  res.json(listCommits(req.repo, req.query));
});

app.get('/api/repos/:id/metrics', requireReadyRepo, (req, res) => {
  res.json(computeMetrics(req.repo, req.query));
});

app.get('/api/repos/:id/authors', requireReadyRepo, (req, res) => {
  res.json(listAuthors(req.repo));
});

app.get('/api/repos/:id/tree', requireReadyRepo, (req, res) => {
  res.json(listTree(req.repo, req.query.path || ''));
});

app.get('/api/repos/:id/paths', requireReadyRepo, (req, res) => {
  res.json(listPaths(req.repo));
});

// --- static dashboard -------------------------------------------------------

app.use(express.static(path.join(ROOT, 'public')));
// Chart.js UMD build served straight from node_modules (no bundler/build step)
app.use('/vendor/chart.js', express.static(path.join(ROOT, 'node_modules', 'chart.js', 'dist')));

// --- error handler ----------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error('[RAT]', err.message || err);
  const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
  const message = err.code === 'LIMIT_FILE_SIZE' ? 'uploaded file is too large' : err.message || 'internal error';
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`[RAT] Repo Analysis Tool listening on http://localhost:${PORT}`);
});
