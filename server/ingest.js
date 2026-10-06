'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { parseRepo, countCommits } = require('./gitparse');

const URL_RE = /^(https?:\/\/|git:\/\/|ssh:\/\/|git@|file:\/\/)/;

function tailLines(text, n) {
  const lines = text.split(/[\r\n]+/).map((l) => l.trim()).filter(Boolean);
  return lines.slice(-n).join(' | ');
}

function deriveName(url) {
  const clean = url.replace(/\/+$/, '').replace(/\.git$/, '');
  const last = clean.split(/[/:]/).pop();
  return last || 'repository';
}

function cloneRepo(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const child = spawn('git', ['clone', '--progress', '--', url, dest], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let err = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      err = (err + s).slice(-20000);
      const lines = s.split(/[\r\n]+/).filter(Boolean);
      if (lines.length && onProgress) onProgress(lines[lines.length - 1].trim());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(tailLines(err, 4) || `git clone exited with ${code}`));
    });
  });
}

function extractZip(zipPath, dest) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    const child = spawn('unzip', ['-q', '-o', zipPath, '-d', dest]);
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      if (e.code === 'ENOENT') {
        // No unzip binary on this system: fall back to the pure-JS extractor.
        try {
          const AdmZip = require('adm-zip');
          new AdmZip(zipPath).extractAllTo(dest, true);
          resolve();
        } catch (e2) {
          reject(new Error('Could not extract zip: ' + e2.message));
        }
      } else {
        reject(e);
      }
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error('unzip failed: ' + (tailLines(err, 3) || `exit code ${code}`)));
    });
  });
}

/** Find the directory containing the .git entry (zip may wrap the repo in a folder). */
function findRepoRoot(dest) {
  const hasGit = (d) => {
    try {
      return fs.existsSync(path.join(d, '.git'));
    } catch (e) {
      return false;
    }
  };
  if (hasGit(dest)) return dest;
  let entries = [];
  try {
    entries = fs.readdirSync(dest, { withFileTypes: true });
  } catch (e) {
    entries = [];
  }
  for (const ent of entries) {
    if (ent.isDirectory()) {
      const nested = path.join(dest, ent.name);
      if (hasGit(nested)) return nested;
    }
  }
  throw new Error('No .git directory found in the uploaded zip (upload a zip of the repo including its .git)');
}

/** Clone/measure phases shared by both ingestion modes. */
async function analyse(store, repo, workPath) {
  repo.phase = 'reading history';
  const total = await countCommits(workPath);
  if (!total) throw new Error('repository has no commits (nothing to analyse)');
  repo.progress = { parsed: 0, total };
  repo.phase = 'parsing history';
  const started = Date.now();
  const commits = await parseRepo(workPath, (parsed) => {
    repo.progress.parsed = parsed;
  });
  if (!commits.length) throw new Error('repository has no commits (nothing to analyse)');
  repo.phase = 'aggregating';
  store.assemble(repo, commits);
  repo.stats.parseMs = Date.now() - started;
  repo.workPath = workPath;
  await store.persist(repo);
}

function fail(repo, e) {
  repo.status = 'error';
  repo.phase = 'error';
  repo.error = String((e && e.message) || e).slice(0, 500);
  console.error('[RAT] ingestion failed for repo', repo.id, '-', repo.error);
}

/** Start (fire and forget) ingestion of a remote repository URL. */
async function startUrlIngest(store, repo, url) {
  try {
    if (!URL_RE.test(url)) {
      throw new Error('Invalid repository URL (expected https://, git://, ssh://, git@ or file://)');
    }
    repo.name = repo.name && repo.name !== 'repository' ? repo.name : deriveName(url);
    const dest = store.workDir(repo.id);
    repo.phase = 'cloning';
    await cloneRepo(url, dest, (line) => {
      repo.phase = 'cloning: ' + line;
    });
    await analyse(store, repo, dest);
  } catch (e) {
    fail(repo, e);
  }
}

/** Start (fire and forget) ingestion of an uploaded zip file. */
async function startZipIngest(store, repo, filePath, originalName) {
  try {
    repo.phase = 'extracting zip';
    const dest = store.workDir(repo.id);
    await extractZip(filePath, dest);
    const root = findRepoRoot(dest);
    if (root !== dest && (!repo.name || repo.name === 'repository')) {
      repo.name = path.basename(root);
    }
    await analyse(store, repo, root);
  } catch (e) {
    fail(repo, e);
  } finally {
    fs.promises.rm(filePath, { force: true }).catch(() => {});
  }
}

module.exports = { startUrlIngest, startZipIngest };
