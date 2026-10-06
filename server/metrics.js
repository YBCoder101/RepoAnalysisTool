'use strict';

/**
 * Metric engine: computes file / directory / repository / commit-set / author
 * metrics for a parsed repository (see server/store.js for the data model).
 *
 * Definitions follow the COMS3011A specification:
 *   l+ added lines, l- removed lines, growth d = l+ - l-, churn A = l+ + l-,
 *   modifications n (commits with churn > 0 on the object),
 *   modification frequency eta = n / |H|, churn rate rho = A / |H|,
 *   author modifications n_a, author churn A_a, ownership w_a = A_a / A.
 */

const DAY = 86400;

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

/** Lazily built hash -> commit index map (full hashes). */
function hashIndex(repo) {
  if (!repo._hashIndex) {
    const m = new Map();
    for (let i = 0; i < repo.commits.length; i++) m.set(repo.commits[i].hash, i);
    repo._hashIndex = m;
  }
  return repo._hashIndex;
}

/** Resolve an author id through manual merge groups (Stage 4). */
function groupOf(repo, authorId) {
  const merged = repo.mergedInto;
  if (!merged || !merged.size) return authorId;
  let a = authorId;
  const guard = new Set();
  while (merged.has(a) && merged.get(a) !== a && !guard.has(a)) {
    guard.add(a);
    a = merged.get(a);
  }
  return a;
}

function resolveAuthor(repo, q) {
  if (!q.author || q.author === 'all') return null;
  const id = Number(q.author);
  if (!Number.isInteger(id) || !repo.authors[id]) throw badRequest('unknown author: ' + q.author);
  return groupOf(repo, id);
}

/** Parse and validate filter parameters for the metrics endpoints. */
function parseFilters(repo, q) {
  let path = String(q.path || '').replace(/^\/+|\/+$/g, '');
  let pathType = 'repo';
  if (path) {
    if (repo.fileId.has(path)) pathType = 'file';
    else if (repo.dirs.has(path)) pathType = 'dir';
    else throw badRequest('unknown file or directory: ' + path);
  }

  const authorId = resolveAuthor(repo, q);

  let mode = 'all';
  let from = null;
  let to = null;
  let hashes = null;
  if (q.hashes !== undefined) {
    mode = 'manual';
    hashes = String(q.hashes).split(',').map((s) => s.trim()).filter(Boolean);
    if (!hashes.length || hashes.length > 20000) throw badRequest('hashes must contain between 1 and 20000 commit hashes');
  } else if ((q.from !== undefined && q.from !== '') || (q.to !== undefined && q.to !== '')) {
    mode = 'period';
    from = q.from !== undefined && q.from !== '' ? Number(q.from) : null;
    to = q.to !== undefined && q.to !== '' ? Number(q.to) : null;
    if (from !== null && !Number.isFinite(from)) throw badRequest('from must be a unix timestamp');
    if (to !== null && !Number.isFinite(to)) throw badRequest('to must be a unix timestamp');
  }

  return { path, pathType, authorId, mode, from, to, hashes };
}

/** Commit indices of H: the commit set defined by the filters. */
function selectCommits(repo, f) {
  const out = [];
  const { commits } = repo;
  if (f.mode === 'manual') {
    const map = hashIndex(repo);
    const seen = new Set();
    for (const h of f.hashes) {
      const i = map.get(h);
      if (i === undefined || seen.has(i)) continue;
      if (f.authorId !== null && groupOf(repo, commits[i].authorId) !== f.authorId) continue;
      seen.add(i);
      out.push(i);
    }
    return out;
  }
  const from = f.mode === 'period' && f.from !== null ? f.from : -Infinity;
  const to = f.mode === 'period' && f.to !== null ? f.to : Infinity;
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (c.ct < from || c.ct >= to) continue;
    if (f.authorId !== null && groupOf(repo, c.authorId) !== f.authorId) continue;
    out.push(i);
  }
  return out;
}

function bucketStart(ct, granularity) {
  if (granularity === 'day') return Math.floor(ct / DAY) * DAY;
  if (granularity === 'week') return Math.floor(ct / (7 * DAY)) * (7 * DAY);
  const d = new Date(ct * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000);
}

function pickGranularity(idx, commits) {
  if (!idx.length) return 'day';
  const span = commits[idx[idx.length - 1]].ct - commits[idx[0]].ct;
  if (span <= 120 * DAY) return 'day';
  if (span <= 730 * DAY) return 'week';
  return 'month';
}

/**
 * The main aggregation. Scans the operations of the selected commits once and
 * accumulates the scope object, its immediate children, the author breakdown
 * and the activity timeline in a single pass.
 */
function computeMetrics(repo, q) {
  const f = parseFilters(repo, q);
  const idx = selectCommits(repo, f);
  const H = idx.length;
  const { ops, files, commits } = repo;

  const isRepo = f.pathType === 'repo';
  const isDir = f.pathType === 'dir';
  const prefix = isDir ? f.path + '/' : null;
  const granularity = pickGranularity(idx, commits);

  let added = 0;
  let removed = 0;
  let mods = 0;
  const perAuthor = new Map(); // group author id -> { mods, churn }
  const children = new Map(); // child path -> { added, removed, mods }
  const timeline = new Map(); // bucket -> { added, removed, commits }
  const touchedChildren = new Map(); // per-commit: child path -> true

  for (const ci of idx) {
    const c = commits[ci];
    const author = groupOf(repo, c.authorId);
    let commitAdded = 0;
    let commitRemoved = 0;
    let commitTouched = false;
    touchedChildren.clear();

    for (let k = c.start; k < c.start + c.len; k++) {
      const p = files[ops.f[k]];
      if (isDir ? !p.startsWith(prefix) : f.pathType === 'file' && p !== f.path) continue;
      const a = ops.a[k];
      const r = ops.r[k];
      const churn = a + r;

      added += a;
      removed += r;
      commitAdded += a;
      commitRemoved += r;
      if (churn > 0) commitTouched = true;

      if (isRepo || isDir) {
        let childPath;
        if (isRepo) {
          const slash = p.indexOf('/');
          childPath = slash === -1 ? p : p.slice(0, slash);
        } else {
          const rest = p.slice(prefix.length);
          const slash = rest.indexOf('/');
          childPath = slash === -1 ? p : prefix + rest.slice(0, slash);
        }
        let ch = children.get(childPath);
        if (!ch) {
          ch = { added: 0, removed: 0, mods: 0 };
          children.set(childPath, ch);
        }
        ch.added += a;
        ch.removed += r;
        if (churn > 0 && !touchedChildren.get(childPath)) {
          touchedChildren.set(childPath, true);
          ch.mods += 1;
        }
      }

      let pa = perAuthor.get(author);
      if (!pa) {
        pa = { mods: 0, churn: 0 };
        perAuthor.set(author, pa);
      }
      pa.churn += churn;
    }

    if (commitTouched) {
      mods += 1;
      let pa = perAuthor.get(author);
      if (!pa) {
        pa = { mods: 0, churn: 0 };
        perAuthor.set(author, pa);
      }
      pa.mods += 1;
      const b = bucketStart(c.ct, granularity);
      let tb = timeline.get(b);
      if (!tb) {
        tb = { added: 0, removed: 0, commits: 0 };
        timeline.set(b, tb);
      }
      tb.added += commitAdded;
      tb.removed += commitRemoved;
      tb.commits += 1;
    }
  }

  const churn = added + removed;

  const authorRows = Array.from(perAuthor.entries())
    .map(([id, v]) => {
      const a = repo.authors[id];
      return {
        id,
        name: a.name,
        email: a.email,
        mods: v.mods,
        churn: v.churn,
        ownership: churn ? v.churn / churn : 0,
        commits: a.commits,
      };
    })
    .filter((r) => r.churn > 0 || r.mods > 0)
    .sort((x, y) => y.churn - x.churn);

  const childRows = isRepo || isDir
    ? Array.from(children.entries())
        .map(([p, v]) => {
          const childChurn = v.added + v.removed;
          return {
            path: p,
            name: p.split('/').pop(),
            type: repo.dirs.has(p) ? 'dir' : 'file',
            added: v.added,
            removed: v.removed,
            growth: v.added - v.removed,
            churn: childChurn,
            mods: v.mods,
            modFreq: H ? v.mods / H : 0,
            churnRate: H ? childChurn / H : 0,
          };
        })
        .sort((x, y) => y.churn - x.churn)
    : [];

  const timelineRows = Array.from(timeline.entries())
    .map(([t, v]) => ({
      t,
      added: v.added,
      removed: v.removed,
      churn: v.added + v.removed,
      commits: v.commits,
    }))
    .sort((x, y) => x.t - y.t);

  return {
    object: { path: f.path, type: f.pathType },
    commitSet: { mode: f.mode, from: f.from, to: f.to, size: H, granularity },
    metrics: {
      added,
      removed,
      growth: added - removed,
      churn,
      mods,
      modFreq: H ? mods / H : 0,
      churnRate: H ? churn / H : 0,
    },
    authors: authorRows,
    children: childRows,
    timeline: timelineRows,
  };
}

/** Paginated commit list (newest first) for the commit picker / manual sets. */
function listCommits(repo, q) {
  const authorId = resolveAuthor(repo, q);
  const from = q.from !== undefined && q.from !== '' ? Number(q.from) : -Infinity;
  const to = q.to !== undefined && q.to !== '' ? Number(q.to) : Infinity;
  const query = String(q.q || '').toLowerCase();
  const limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 2000);
  const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

  const out = [];
  let matched = 0;
  for (let i = repo.commits.length - 1; i >= 0; i--) {
    const c = repo.commits[i];
    if (authorId !== null && groupOf(repo, c.authorId) !== authorId) continue;
    if (c.ct < from || c.ct >= to) continue;
    if (query && !c.hash.startsWith(query)) continue;
    matched += 1;
    if (matched <= offset || out.length >= limit) continue;
    const a = repo.authors[c.authorId];
    out.push({
      hash: c.hash,
      ct: c.ct,
      authorId: c.authorId,
      author: a.name,
      email: a.email,
      added: c.added,
      removed: c.removed,
      churn: c.added + c.removed,
    });
  }
  return { total: matched, offset, limit, commits: out };
}

/** Author list (Stage 4 adds manual merging on top of this). */
function listAuthors(repo) {
  return repo.authors.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    commits: a.commits,
    group: groupOf(repo, a.id),
  }));
}

/** Immediate children of a directory (fast, no metrics) for tree navigation. */
function listTree(repo, rawPath) {
  const p = String(rawPath || '').replace(/^\/+|\/+$/g, '');
  if (p && !repo.dirs.has(p)) {
    if (repo.fileId.has(p)) return { path: p, type: 'file', children: [] };
    throw badRequest('unknown directory: ' + p);
  }
  const node = repo.dirs.get(p) || { files: [], dirs: [] };
  const children = [
    ...node.dirs.map((d) => ({ name: d.split('/').pop(), path: d, type: 'dir' })),
    ...node.files.map((fid) => ({ name: repo.files[fid].split('/').pop(), path: repo.files[fid], type: 'file' })),
  ];
  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: p, type: 'dir', children };
}

module.exports = { computeMetrics, listCommits, listAuthors, listTree };
