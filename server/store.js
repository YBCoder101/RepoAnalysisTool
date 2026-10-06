'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Build the directory map: dirPath -> immediate child files (ids) and
 * immediate child directories. The root directory is ''.
 */
function buildDirs(files) {
  const dirs = new Map();
  const ensureDir = (d) => {
    let n = dirs.get(d);
    if (!n) {
      n = { files: [], dirs: [], fileSet: new Set(), dirSet: new Set() };
      dirs.set(d, n);
    }
    return n;
  };
  ensureDir('');
  for (let id = 0; id < files.length; id++) {
    const segs = files[id].split('/');
    segs.pop();
    let cur = '';
    for (const s of segs) {
      const child = cur === '' ? s : cur + '/' + s;
      const node = ensureDir(cur);
      if (!node.dirSet.has(child)) {
        node.dirSet.add(child);
        node.dirs.push(child);
      }
      ensureDir(child);
      cur = child;
    }
    const node = ensureDir(cur);
    if (!node.fileSet.has(id)) {
      node.fileSet.add(id);
      node.files.push(id);
    }
  }
  for (const n of dirs.values()) {
    delete n.fileSet;
    delete n.dirSet;
  }
  return dirs;
}

/** Rebuild lookup maps that are not persisted (derived from the file list). */
function attachDerived(repo, data) {
  repo.files = data.files;
  repo.authors = data.authors;
  repo.commits = data.commits;
  repo.ops = data.ops;
  repo.fileId = new Map(data.files.map((p, i) => [p, i]));
  repo.authorKey = new Map(data.authors.map((a) => [a.name + '\x00' + a.email, a.id]));
  repo.dirs = buildDirs(data.files);
}

/**
 * In-memory registry of analysed repositories, with a JSON mirror on disk so
 * that a server restart does not require re-parsing the git history.
 */
class Store {
  constructor(cacheDir) {
    this.cacheDir = cacheDir;
    this.repos = new Map();
  }

  newId() {
    let id;
    do {
      id = crypto.randomBytes(4).toString('hex');
    } while (this.repos.has(id));
    return id;
  }

  create(name, source, id) {
    const repo = {
      id: id || this.newId(),
      name: name || 'repository',
      source, // { type: 'url'|'zip', url?, file? }
      status: 'importing', // importing | ready | error
      phase: 'starting',
      progress: { parsed: 0, total: 0 },
      error: null,
      createdAt: Date.now(),
      // filled in by assemble()/attachDerived():
      commits: [],
      files: [],
      authors: [],
      dirs: new Map(),
      ops: null,
      stats: null,
      mergedInto: new Map(), // manual author merges: authorId -> canonical authorId
    };
    this.repos.set(repo.id, repo);
    return repo;
  }

  repoDir(id) {
    return path.join(this.cacheDir, 'repos', id);
  }

  workDir(id) {
    return path.join(this.repoDir(id), 'work');
  }

  /**
   * Build interning tables, the author list, the directory tree and the
   * flattened per-commit operation arrays from freshly parsed commits.
   */
  assemble(repo, parsedCommits) {
    const files = [];
    const fileId = new Map();
    const internFile = (p) => {
      let id = fileId.get(p);
      if (id === undefined) {
        id = files.length;
        files.push(p);
        fileId.set(p, id);
      }
      return id;
    };

    const authorKey = new Map();
    const authors = [];
    const internAuthor = (name, email) => {
      const key = name + '\x00' + email;
      let id = authorKey.get(key);
      if (id === undefined) {
        id = authors.length;
        authors.push({ id, name, email, commits: 0 });
        authorKey.set(key, id);
      }
      return id;
    };

    // Oldest first for stable indices.
    const ordered = parsedCommits.slice().reverse();

    const commits = [];
    const of = [];
    const oa = [];
    const or = [];
    let opIndex = 0;

    for (const c of ordered) {
      const authorId = internAuthor(c.name, c.email);
      authors[authorId].commits += 1;
      const start = opIndex;
      let iAdd = 0;
      let iRem = 0;
      for (const e of c.entries) {
        const fid = internFile(e.path);
        if (e.oldPath) internFile(e.oldPath); // keep rename sources selectable
        if (e.add === null || e.rem === null) continue; // binary: not measured
        of.push(fid);
        oa.push(e.add);
        or.push(e.rem);
        iAdd += e.add;
        iRem += e.rem;
        opIndex += 1;
      }
      commits.push({
        hash: c.hash,
        parents: c.parents,
        authorId,
        ct: c.ct,
        start,
        len: opIndex - start,
        added: iAdd,
        removed: iRem,
      });
    }

    attachDerived(repo, { files, authors, commits, ops: { f: of, a: oa, r: or } });

    const last = commits[commits.length - 1] || null;
    repo.stats = {
      commits: commits.length,
      files: files.length,
      dirs: Math.max(repo.dirs.size - 1, 0),
      authors: authors.length,
      firstDate: commits[0] ? commits[0].ct : null,
      lastDate: last ? last.ct : null,
      head: last ? last.hash : null,
    };
    repo.status = 'ready';
    repo.phase = 'done';
    repo.error = null;
  }

  summary(repo) {
    return {
      id: repo.id,
      name: repo.name,
      source: repo.source,
      status: repo.status,
      phase: repo.phase,
      progress: repo.progress,
      error: repo.error,
      createdAt: repo.createdAt,
      stats: repo.stats,
    };
  }

  list() {
    return Array.from(this.repos.values()).map((r) => this.summary(r));
  }

  get(id) {
    return this.repos.get(id) || null;
  }

  async remove(id) {
    const repo = this.repos.get(id);
    if (!repo) return false;
    this.repos.delete(id);
    await fs.promises.rm(this.repoDir(id), { recursive: true, force: true }).catch(() => {});
    return true;
  }

  /** Persist a parsed repository to disk (best effort, never throws). */
  persist(repo) {
    if (!repo.ops) return Promise.resolve();
    const snapshot = {
      meta: {
        id: repo.id,
        name: repo.name,
        source: repo.source,
        createdAt: repo.createdAt,
        stats: repo.stats,
        phase: repo.phase,
        merges: Array.from(repo.mergedInto || []),
      },
      files: repo.files,
      authors: repo.authors,
      commits: repo.commits,
      ops: repo.ops,
    };
    const file = path.join(this.repoDir(repo.id), 'store.json');
    return fs.promises
      .mkdir(path.dirname(file), { recursive: true })
      .then(() => fs.promises.writeFile(file, JSON.stringify(snapshot)))
      .catch(() => {});
  }

  /** Load previously persisted repositories at boot. */
  loadAll() {
    let ids = [];
    try {
      ids = fs.readdirSync(path.join(this.cacheDir, 'repos'));
    } catch (e) {
      return;
    }
    for (const id of ids) {
      const file = path.join(this.cacheDir, 'repos', id, 'store.json');
      let snap;
      try {
        snap = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        continue;
      }
      const repo = this.create(snap.meta.name, snap.meta.source, id);
      repo.createdAt = snap.meta.createdAt || repo.createdAt;
      attachDerived(repo, {
        files: snap.files,
        authors: snap.authors,
        commits: snap.commits,
        ops: snap.ops,
      });
      repo.stats = snap.meta.stats;
      repo.mergedInto = new Map(snap.meta.merges || []);
      repo.status = 'ready';
      repo.phase = 'loaded';
      repo.error = null;
      repo.progress = { parsed: repo.commits.length, total: repo.commits.length };
    }
  }
}

module.exports = { Store };
