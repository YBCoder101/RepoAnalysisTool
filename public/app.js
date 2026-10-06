'use strict';

/* RAT dashboard client. Talks to the JSON API in server/index.js:
 *   /api/repos, /api/repos/:id/{metrics,commits,authors,tree,paths}
 * Charts use the Chart.js UMD build served from /vendor/chart.js/chart.umd.js.
 */

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));

const state = {
  repos: [],
  repoId: null,
  loadedRepoId: null,
  tab: 'overview',
  filters: { path: '', author: 'all', mode: 'all', from: '', to: '', hashes: [] },
  authors: [],
  paths: null, // { dirs: Set, files: Set }
  metrics: null,
  commits: { items: [], total: 0, offset: 0, limit: 100, q: '' },
  picker: { items: [], offset: 0, total: 0, q: '', selected: new Set(), pageSize: 1000 },
  mergePicks: new Set(),
  poll: null,
  chart: null,
};

// ---------- tiny helpers ----------------------------------------------------

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtInt = (n) => (n == null || !isFinite(n) ? '–' : Math.round(n).toLocaleString('en-US'));
const fmtSigned = (n) => (n > 0 ? '+' : '') + fmtInt(n);
const fmtRatio = (n, d) => (n == null || !isFinite(n) ? '–' : n.toFixed(d == null ? 2 : d));
const fmtPct = (n) => (n == null || !isFinite(n) ? '–' : (n * 100).toFixed(1) + '%');
const fmtDate = (ct) => (ct == null || !isFinite(ct) ? '–' : new Date(ct * 1000).toISOString().slice(0, 10));
const fmtDateTime = (ct) => (ct == null || !isFinite(ct) ? '–' : new Date(ct * 1000).toISOString().slice(0, 16).replace('T', ' '));

async function api(url, opts) {
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || res.statusText || 'HTTP ' + res.status);
    err.status = res.status;
    throw err;
  }
  return body;
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + (kind || 'error');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast hidden'; }, 6000);
}

const selectedRepo = () => state.repos.find((r) => r.id === state.repoId) || null;

// ---------- navigation (hash router) ----------------------------------------

const TABS = ['overview', 'files', 'authors', 'commits'];
const repoHash = (id, tab) => `#/repo/${id}${tab ? '/' + tab : ''}`;

/** Parse location.hash into { view: 'home' } or { view: 'repo', id, tab }. */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'repo' && parts[1]) {
    return { view: 'repo', id: parts[1], tab: TABS.includes(parts[2]) ? parts[2] : 'overview' };
  }
  return { view: 'home' };
}

/** Navigate: change the hash (hashchange applies the route); re-apply when equal. */
function nav(hash) {
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

function showView(name) {
  $('#view-home').classList.toggle('hidden', name !== 'home');
  $('#view-repo').classList.toggle('hidden', name !== 'repo');
  $('#top-tag').classList.toggle('hidden', name !== 'home');
  $('#top-back').classList.toggle('hidden', name !== 'repo');
}

function showHome() {
  showView('home');
  document.title = 'RAT — Repo Analysis Tool';
}

/** Apply the current hash: the repository manager, or one repository's workspace. */
async function applyRoute() {
  const r = parseRoute();
  if (r.view === 'home') {
    if (location.hash && location.hash !== '#/') history.replaceState(null, '', '#/'); // unknown route
    return showHome();
  }
  const repo = state.repos.find((x) => x.id === r.id);
  if (!repo) {
    history.replaceState(null, '', '#/');
    return showHome();
  }
  const tabChanged = state.tab !== r.tab;
  state.tab = r.tab;
  document.title = 'RAT — ' + repo.name;
  if (repo.id !== state.repoId || state.loadedRepoId !== repo.id) {
    await selectRepo(repo.id);
  } else {
    showWorkspace(repo);
    if (tabChanged) renderActiveTab();
  }
}

// ---------- repositories ----------------------------------------------------

function renderRepos() {
  $('#repo-count').textContent = state.repos.length;
  $('#repo-empty').classList.toggle('hidden', state.repos.length > 0);

  $('#repo-cards').innerHTML = state.repos
    .map((r) => {
      const cls = ['repo-card'];
      if (r.id === state.repoId) cls.push('active');
      if (r.status === 'error') cls.push('failed');
      let body;
      if (r.status === 'ready') {
        const s = r.stats;
        body = `<div class="repo-stats">
            <span><strong>${fmtInt(s.commits)}</strong> commits</span>
            <span><strong>${fmtInt(s.files)}</strong> files</span>
            <span><strong>${fmtInt(s.authors)}</strong> authors</span>
          </div>
          <div class="muted small">${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}</div>`;
      } else if (r.status === 'error') {
        body = `<p class="status-error small">${esc(r.error || 'analysis failed')}</p>`;
      } else {
        const p = r.progress || { parsed: 0, total: 0 };
        const pct = p.total ? Math.round((p.parsed / p.total) * 100) : 0;
        body = `<p class="muted small">${esc(r.phase || 'working')}${p.total ? ` — ${fmtInt(p.parsed)} / ${fmtInt(p.total)} commits (${pct}%)` : ''}</p>
          <div class="progress"><div style="width:${pct}%"></div></div>`;
      }
      const src = r.source.url || r.source.file || '';
      return `<article class="${cls.join(' ')}" data-id="${r.id}" title="${esc(src)}">
        <header class="repo-card-head">
          <h3>${esc(r.name)}</h3>
          <span class="status-badge status-${r.status}">${esc(r.status)}</span>
        </header>
        <p class="repo-src muted small">${esc(src)}</p>
        ${body}
        <div class="repo-actions">
          <button class="primary small-btn" data-open="${r.id}">${r.status === 'ready' ? 'Open dashboard' : 'View'}</button>
          <button class="small-btn ghost" data-del="${r.id}">Remove</button>
        </div>
      </article>`;
    })
    .join('');

  const sel = $('#f-repo');
  sel.innerHTML = state.repos.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  if (state.repos.some((r) => r.id === state.repoId)) sel.value = state.repoId;
}

async function refreshRepos() {
  state.repos = await api('/api/repos');
  renderRepos();
}

function ensurePolling() {
  if (state.poll) return;
  state.poll = setInterval(async () => {
    try {
      await refreshRepos();
      const repo = selectedRepo();
      if (repo && repo.status !== 'ready') renderStatusPanel(repo);
      const busy = state.repos.some((r) => r.status === 'importing');
      if (!busy) {
        clearInterval(state.poll);
        state.poll = null;
        const r = parseRoute();
        if (repo && repo.status === 'ready' && state.loadedRepoId !== repo.id && r.view === 'repo' && r.id === repo.id) loadRepo();
      }
    } catch (e) { /* server briefly unavailable: keep polling */ }
  }, 1500);
}

function renderStatusPanel(repo) {
  const el = $('#repo-status');
  el.classList.remove('hidden');
  $('#analysis-ui').classList.add('hidden');
  if (repo.status === 'error') {
    el.innerHTML = `<h3>${esc(repo.name)} — analysis failed</h3>
      <p class="status-error">${esc(repo.error || 'unknown error')}</p>
      <p class="muted small">Delete this repository and try again (check the URL or that the zip contains a .git folder).</p>`;
    return;
  }
  const p = repo.progress || { parsed: 0, total: 0 };
  const pct = p.total ? Math.round((p.parsed / p.total) * 100) : 0;
  el.innerHTML = `<h3>Analysing “${esc(repo.name)}”…</h3>
    <p>${esc(repo.phase || 'working')}${p.total ? ` — ${fmtInt(p.parsed)} / ${fmtInt(p.total)} commits (${pct}%)` : ''}</p>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <p class="muted small">The dashboard activates automatically when the analysis completes.</p>`;
}

function showWorkspace(repo) {
  showView('repo');
  renderRepoHead(repo || {});
  if (repo && repo.status === 'ready') {
    $('#repo-status').classList.add('hidden');
    $('#analysis-ui').classList.remove('hidden');
  } else {
    renderStatusPanel(repo || {});
  }
}

/** Static facts about the open repository, shown above the filters. */
function renderRepoHead(repo) {
  const src = repo.source ? repo.source.url || repo.source.file || '' : '';
  const s = repo.stats;
  const stats = s
    ? `<div class="repo-head-stats">
        <span><strong>${fmtInt(s.commits)}</strong> commits</span>
        <span><strong>${fmtInt(s.files)}</strong> files</span>
        <span><strong>${fmtInt(s.dirs)}</strong> dirs</span>
        <span><strong>${fmtInt(s.authors)}</strong> authors</span>
        <span>${fmtDate(s.firstDate)} → ${fmtDate(s.lastDate)}</span>
        <span class="mono">${esc((s.head || '').slice(0, 10))}</span>
      </div>`
    : '';
  $('#repo-head').innerHTML = `<div class="repo-head-main">
      <h2>${esc(repo.name || 'repository')}</h2>
      <p class="muted small">${esc(src)}</p>
    </div>
    ${stats}`;
}

async function selectRepo(id) {
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  if (id !== state.repoId) {
    state.repoId = id;
    state.filters = { path: '', author: 'all', mode: 'all', from: '', to: '', hashes: [] };
    state.picker.selected = new Set();
    state.mergePicks.clear();
    state.metrics = null;
    state.loadedRepoId = null;
    state.authors = [];
    state.paths = null;
  }
  renderRepos();
  showWorkspace(repo);
  if (repo.status === 'ready') await loadRepo();
}

async function loadRepo() {
  const repo = selectedRepo();
  if (!repo || repo.status !== 'ready') return;
  state.loadedRepoId = repo.id;
  showWorkspace(repo);
  try {
    const [authors, paths] = await Promise.all([
      api(`/api/repos/${repo.id}/authors`),
      api(`/api/repos/${repo.id}/paths`).catch(() => null),
    ]);
    state.authors = authors.sort((a, b) => b.commits - a.commits);
    state.paths = paths ? { dirs: new Set(paths.dirs), files: new Set(paths.files) } : null;
    buildAuthorSelect();
    buildPathOptions();
  } catch (e) {
    toast('Could not load repository: ' + e.message);
    return;
  }
  syncFilterControls();
  await refreshMetrics();
}

async function deleteRepo(id) {
  const repo = state.repos.find((r) => r.id === id);
  if (!repo) return;
  if (!confirm(`Remove “${repo.name}” and its cached analysis?`)) return;
  try {
    await api(`/api/repos/${id}`, { method: 'DELETE' });
  } catch (e) {
    return toast('Delete failed: ' + e.message);
  }
  if (state.repoId === id) {
    state.repoId = null;
    state.loadedRepoId = null;
  }
  await refreshRepos();
  await applyRoute(); // falls back to the manager page when the open repo was removed
}

// ---------- filters ---------------------------------------------------------

function buildAuthorSelect() {
  const memberCount = new Map();
  for (const a of state.authors) memberCount.set(a.group, (memberCount.get(a.group) || 0) + 1);
  const opts = ['<option value="all">All authors</option>'];
  for (const a of state.authors) {
    if (a.group !== a.id) continue; // only canonical identities in the filter
    const n = memberCount.get(a.id) || 1;
    opts.push(`<option value="${a.id}">${esc(a.name)} — ${esc(a.email)}${n > 1 ? ` (+${n - 1} merged)` : ''}</option>`);
  }
  $('#f-author').innerHTML = opts.join('');
  $('#f-author').value = state.filters.author;
}

function buildPathOptions() {
  if (!state.paths) { $('#path-options').innerHTML = ''; return; }
  const list = [];
  for (const d of state.paths.dirs) { if (list.length >= 20000) break; list.push(d); }
  for (const f of state.paths.files) { if (list.length >= 20000) break; list.push(f); }
  $('#path-options').innerHTML = list.map((p) => `<option value="${esc(p)}"></option>`).join('');
}

function fillDateInputs() {
  const from = state.filters.from ? new Date(Number(state.filters.from) * 1000).toISOString().slice(0, 10) : '';
  const to = state.filters.to ? new Date((Number(state.filters.to) - 86400) * 1000).toISOString().slice(0, 10) : '';
  $('#f-from').value = from;
  $('#f-to').value = to;
}

function updateManualCount() {
  const n = state.filters.hashes.length;
  $('#manual-count').textContent = n ? `${fmtInt(n)} commit${n === 1 ? '' : 's'} selected` : 'nothing selected';
}

function syncFilterControls() {
  $('#f-path').value = state.filters.path;
  if (state.authors.length) {
    const a = state.authors.find((x) => String(x.id) === state.filters.author);
    state.filters.author = a ? String(a.group) : 'all';
    $('#f-author').value = state.filters.author;
  }
  $$('input[name="cmode"]').forEach((r) => { r.checked = r.value === state.filters.mode; });
  $('#period-controls').classList.toggle('hidden', state.filters.mode !== 'period');
  $('#manual-controls').classList.toggle('hidden', state.filters.mode !== 'manual');
  fillDateInputs();
  updateManualCount();
}

function setPath(p) {
  // A trailing slash is kept: it selects the directory variant when a path
  // is both a file and a directory somewhere in the history (e.g. "git-gui").
  state.filters.path = String(p || '').replace(/^\/+/, '');
  $('#f-path').value = state.filters.path;
  refreshMetrics();
}

function setAuthor(id) {
  const a = state.authors.find((x) => x.id === Number(id));
  state.filters.author = String(a ? a.group : id);
  if ($('#f-author').querySelector(`option[value="${state.filters.author}"]`)) $('#f-author').value = state.filters.author;
  refreshMetrics();
}

function resetFilters() {
  state.filters = { path: '', author: 'all', mode: 'all', from: '', to: '', hashes: [] };
  syncFilterControls();
  refreshMetrics();
}

function filterParams() {
  const f = state.filters;
  const p = new URLSearchParams();
  if (f.path) p.set('path', f.path);
  if (f.author !== 'all') p.set('author', f.author);
  if (f.mode === 'period') {
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
  }
  if (f.mode === 'manual' && f.hashes.length) p.set('hashes', f.hashes.join(','));
  return p;
}

// ---------- metrics + tabs --------------------------------------------------

async function refreshMetrics() {
  const repo = selectedRepo();
  if (!repo || repo.status !== 'ready' || state.loadedRepoId !== repo.id) return;
  if (state.filters.mode === 'manual' && !state.filters.hashes.length) {
    state.metrics = null;
    renderActiveTab();
    return;
  }
  try {
    const qs = filterParams().toString();
    state.metrics = await api(`/api/repos/${repo.id}/metrics${qs ? '?' + qs : ''}`);
    renderActiveTab();
  } catch (e) {
    toast('Metrics: ' + e.message);
    $('#f-path').value = state.filters.path;
  }
}

function renderActiveTab() {
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + state.tab));
  if (state.tab === 'overview') renderOverview();
  else if (state.tab === 'files') renderFiles();
  else if (state.tab === 'authors') renderAuthors();
  else if (state.tab === 'commits') renderCommits();
}

function describeCommitSet(cs) {
  if (cs.mode === 'all') return 'all commits';
  if (cs.mode === 'period') {
    const from = cs.from != null ? fmtDate(cs.from) : 'beginning';
    const to = cs.to != null ? fmtDate(cs.to - 1) : 'now';
    return `period ${from} → ${to}`;
  }
  return `manual selection`;
}

function metricCells(m) {
  const growthCls = m.growth > 0 ? 'pos' : m.growth < 0 ? 'neg' : '';
  return `<td class="num">${fmtInt(m.added)}</td>
    <td class="num">${fmtInt(m.removed)}</td>
    <td class="num ${growthCls}">${fmtSigned(m.growth)}</td>
    <td class="num">${fmtInt(m.churn)}</td>
    <td class="num">${fmtInt(m.mods)}</td>
    <td class="num">${fmtRatio(m.modFreq, 3)}</td>
    <td class="num">${fmtRatio(m.churnRate, 2)}</td>`;
}

const METRIC_HEAD =
  '<thead><tr><th>Object</th><th class="num">l+</th><th class="num">l−</th><th class="num">δ</th>' +
  '<th class="num">λ</th><th class="num">n</th><th class="num">η</th><th class="num">ρ</th></tr></thead>';

// ---------- overview tab ----------------------------------------------------

function renderOverview() {
  const m = state.metrics;
  if (!m) {
    $('#overview-scope').textContent = 'No commit set selected — use “Select commits…” in the Commit set filter.';
    $('#cards').innerHTML = '';
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    $('#timeline-note').textContent = '';
    $('#children-table').innerHTML = '';
    $('#ownership-list').innerHTML = '';
    return;
  }
  const mm = m.metrics;
  const cs = m.commitSet;
  $('#overview-scope').innerHTML =
    `Scope: <strong>${esc(m.object.path || 'repository root')}</strong> (${m.object.type})` +
    ` · H = ${fmtInt(cs.size)} commits · ${esc(describeCommitSet(cs))}` +
    (state.filters.author !== 'all' ? ` · author: ${esc(($('#f-author').selectedOptions[0] || {}).textContent || '')}` : '');

  const cards = [
    ['|H| commits', fmtInt(cs.size), 'commits in the selected set'],
    ['l+ added', fmtInt(mm.added), 'lines added'],
    ['l− removed', fmtInt(mm.removed), 'lines removed'],
    ['δ growth', `<span class="${mm.growth > 0 ? 'pos' : mm.growth < 0 ? 'neg' : ''}">${fmtSigned(mm.growth)}</span>`, 'l+ − l−'],
    ['λ churn', fmtInt(mm.churn), 'l+ + l−'],
    ['n modifications', fmtInt(mm.mods), 'commits changing the object'],
    ['η frequency', fmtRatio(mm.modFreq, 3), 'n / |H|'],
    ['ρ churn rate', fmtRatio(mm.churnRate, 2), 'λ / |H|'],
  ];
  $('#cards').innerHTML = cards
    .map(([label, val, hint]) => `<div class="card"><div class="card-label">${label}</div><div class="card-val">${val}</div><div class="card-hint">${hint}</div></div>`)
    .join('');

  renderTimeline(m.timeline, cs);
  renderChildrenTable(m.children);
  renderOwnership(m.authors);
}

function renderTimeline(rows, cs) {
  const note = $('#timeline-note');
  if (!rows.length) {
    note.textContent = 'No line activity in the selected commit set (all selected commits only rename files or are empty).';
    if (state.chart) { state.chart.destroy(); state.chart = null; }
    return;
  }
  note.textContent = `${fmtInt(cs.size)} commits in H · timeline bucketed per ${cs.granularity}`;
  if (typeof Chart === 'undefined') return; // Chart.js failed to load (offline)
  Chart.defaults.color = '#9aa5ce';
  Chart.defaults.borderColor = 'rgba(154, 165, 206, .14)';
  if (state.chart) state.chart.destroy();
  state.chart = new Chart($('#timeline-chart'), {
    data: {
      labels: rows.map((r) => fmtDate(r.t)),
      datasets: [
        { type: 'bar', label: 'l+ added', data: rows.map((r) => r.added), backgroundColor: 'rgba(158, 206, 106, .8)', stack: 'lines' },
        { type: 'bar', label: 'l− removed', data: rows.map((r) => r.removed), backgroundColor: 'rgba(247, 118, 142, .8)', stack: 'lines' },
        { type: 'line', label: 'commits', data: rows.map((r) => r.commits), borderColor: '#7aa2f7', backgroundColor: '#7aa2f7', yAxisID: 'y2', tension: .25, pointRadius: rows.length > 60 ? 0 : 2 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true },
        y: { stacked: true, title: { display: true, text: 'lines' } },
        y2: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, title: { display: true, text: 'commits' }, ticks: { precision: 0 } },
      },
    },
  });
}

function renderChildrenTable(children) {
  const table = $('#children-table');
  if (!children.length) {
    table.innerHTML = '<tbody><tr><td class="muted">No file or directory changes in the selected commit set.</td></tr></tbody>';
    return;
  }
  const body = children
    .slice(0, 15)
    .map(
      (c) => `<tr class="clickable">
        <td><span class="obj-name" data-scope="${esc(c.path)}${c.type === 'dir' ? '/' : ''}" title="Scope metrics to ${esc(c.path)}">${c.type === 'dir' ? '📁' : '📄'} ${esc(c.name)}</span></td>
        ${metricCells(c)}
      </tr>`
    )
    .join('');
  table.innerHTML = METRIC_HEAD + `<tbody>${body}</tbody>`;
}

function renderOwnership(authors) {
  const el = $('#ownership-list');
  if (!authors.length) {
    el.innerHTML = '<p class="muted small">No author activity in the selected commit set.</p>';
    return;
  }
  el.innerHTML = authors
    .slice(0, 15)
    .map(
      (a) => `<div class="own-row" data-author="${a.id}" title="Filter by ${esc(a.name)}">
        <div class="own-head"><span class="own-name">${esc(a.name)}</span>
          <span class="own-val">λ ${fmtInt(a.churn)} · ω ${fmtPct(a.ownership)}</span></div>
        <div class="own-bar"><div style="width:${(a.ownership * 100).toFixed(1)}%"></div></div>
      </div>`
    )
    .join('');
}

// ---------- files tab -------------------------------------------------------

function buildBreadcrumb(rawPath) {
  const path = String(rawPath || '').replace(/\/+$/, '');
  if (!path) return '<span class="here">⌂ repo root</span>';
  const segs = path.split('/');
  const parts = ['<button data-nav="" title="Back to repository root">⌂ repo root</button>'];
  let acc = '';
  segs.forEach((s, i) => {
    acc = acc ? acc + '/' + s : s;
    parts.push('<span class="sep">/</span>');
    if (i === segs.length - 1) parts.push(`<span class="here">${esc(s)}</span>`);
    else parts.push(`<button data-nav="${esc(acc)}">${esc(s)}</button>`);
  });
  return parts.join('');
}

async function renderFiles() {
  const repo = selectedRepo();
  const path = state.filters.path;
  $('#breadcrumb').innerHTML = buildBreadcrumb(path);
  const table = $('#files-table');
  const m = state.metrics;
  if (!m) {
    table.innerHTML = '<tbody><tr><td class="muted">No commit set selected — use “Select commits…” in the Commit set filter.</td></tr></tbody>';
    return;
  }

  let rows;
  if (m.object.type === 'file') {
    rows = [{ path, name: path.split('/').pop(), type: 'file', m: m.metrics }];
  } else {
    let treeKids = null;
    try {
      const t = await api(`/api/repos/${repo.id}/tree?path=${encodeURIComponent(path)}`);
      treeKids = t.children;
    } catch (e) { /* fall back to metrics children only */ }
    const metricBy = new Map(m.children.map((c) => [c.type + '\0' + c.path, c]));
    if (treeKids) rows = treeKids.map((k) => ({ path: k.path, name: k.name, type: k.type, m: metricBy.get(k.type + '\0' + k.path) || null }));
    else rows = m.children.map((c) => ({ path: c.path, name: c.name, type: c.type, m: c }));
  }

  table.innerHTML =
    METRIC_HEAD +
    '<tbody>' +
    rows
      .map(
        (r) => `<tr class="clickable${r.m ? '' : ' no-activity'}">
          <td><span class="obj-name" data-scope="${esc(r.path)}${r.type === 'dir' ? '/' : ''}" title="Scope metrics to ${esc(r.path)}">${r.type === 'dir' ? '📁' : '📄'} ${esc(r.name)}</span></td>
          ${r.m ? metricCells(r.m) : '<td class="num">–</td>'.repeat(7)}
        </tr>`
      )
      .join('') +
    '</tbody>';
}

// ---------- authors tab -----------------------------------------------------

function renderAuthors() {
  const m = state.metrics;
  const inSet = new Map(((m && m.authors) || []).map((a) => [a.id, a]));
  const byId = new Map(state.authors.map((a) => [a.id, a]));
  const groups = new Map(); // canonical id -> { canon, members[], commits }
  for (const a of state.authors) {
    let g = groups.get(a.group);
    if (!g) { g = { canon: byId.get(a.group), members: [], commits: 0 }; groups.set(a.group, g); }
    g.members.push(a);
    g.commits += a.commits;
  }
  const rows = Array.from(groups.values()).map((g) => {
    const s = inSet.get(g.canon.id);
    return { g, mods: s ? s.mods : 0, churn: s ? s.churn : 0, ownership: s ? s.ownership : 0, active: !!s };
  });
  rows.sort((x, y) => y.churn - x.churn || y.g.commits - x.g.commits || x.g.canon.name.localeCompare(y.g.canon.name));

  const body = rows
    .map((r) => {
      const c = r.g.canon;
      const others = r.g.members.filter((a) => a.id !== c.id).sort((a, b) => b.commits - a.commits);
      const badge = others.length ? ` <span class="group-badge">${r.g.members.length} identities</span>` : '';
      let html = `<tr class="${r.active ? '' : 'no-activity'}">
        <td><input type="checkbox" data-pick="${c.id}" ${state.mergePicks.has(c.id) ? 'checked' : ''} title="Select for manual merge"></td>
        <td><span class="obj-name" data-author="${c.id}" title="Filter by this author">${esc(c.name)}</span>${badge}</td>
        <td class="muted">${esc(c.email)}</td>
        <td class="num">${fmtInt(r.g.commits)}</td>
        <td class="num">${r.active ? fmtInt(r.mods) : '–'}</td>
        <td class="num">${r.active ? fmtInt(r.churn) : '–'}</td>
        <td class="num">${r.active ? fmtPct(r.ownership) : '–'}</td>
        <td></td>
      </tr>`;
      html += others
        .map(
          (a) => `<tr class="no-activity member-row">
          <td></td>
          <td><span class="member-name">↳</span> <span class="obj-name" data-author="${a.id}" title="Filter by this author">${esc(a.name)}</span></td>
          <td class="muted">${esc(a.email)}</td>
          <td class="num">${fmtInt(a.commits)}</td>
          <td class="num">–</td>
          <td class="num">–</td>
          <td class="num">–</td>
          <td><button class="icon-btn" data-unmerge="${a.id}" title="Unmerge from ${esc(c.name)}">✕</button></td>
        </tr>`
        )
        .join('');
      return html;
    })
    .join('');

  $('#authors-table').innerHTML =
    '<thead><tr><th></th><th>Author</th><th>Email</th><th class="num">commits</th><th class="num">n</th><th class="num">λ</th><th class="num">ω</th><th></th></tr></thead><tbody>' +
    body +
    '</tbody>';
  renderMergeBar();
}

function renderMergeBar() {
  const picks = Array.from(state.mergePicks).filter((id) => state.authors.some((a) => a.id === id && a.group === a.id));
  const bar = $('#merge-bar');
  if (picks.length < 2) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const picked = state.authors.filter((a) => picks.includes(a.id)).sort((a, b) => b.commits - a.commits);
  $('#merge-info').textContent = `${picks.length} authors selected`;
  const prev = Number($('#merge-target').value);
  $('#merge-target').innerHTML = picked
    .map((a) => `<option value="${a.id}">${esc(a.name)} — ${esc(a.email)} (${fmtInt(a.commits)} commits)</option>`)
    .join('');
  if (picked.some((a) => a.id === prev)) $('#merge-target').value = String(prev);
}

async function doMerge() {
  const repo = selectedRepo();
  const picks = Array.from(state.mergePicks);
  if (!repo || picks.length < 2) return;
  const into = Number($('#merge-target').value);
  const target = state.authors.find((a) => a.id === into);
  if (!target) return;
  let authors;
  try {
    authors = await api(`/api/repos/${repo.id}/authors/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: picks, into }),
    });
  } catch (e) {
    return toast('Merge failed: ' + e.message);
  }
  afterAuthorsChanged(authors);
  toast(`Merged ${picks.length} identities into “${target.name}”`, 'ok');
}

async function doUnmerge(id) {
  const repo = selectedRepo();
  if (!repo) return;
  let authors;
  try {
    authors = await api(`/api/repos/${repo.id}/authors/unmerge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
  } catch (e) {
    return toast('Unmerge failed: ' + e.message);
  }
  afterAuthorsChanged(authors);
}

function afterAuthorsChanged(authors) {
  state.authors = authors.sort((a, b) => b.commits - a.commits);
  state.mergePicks.clear();
  buildAuthorSelect();
  syncFilterControls();
  renderAuthors();
  refreshMetrics();
}

// ---------- commits tab -----------------------------------------------------

async function renderCommits() {
  const repo = selectedRepo();
  const c = state.commits;
  const p = new URLSearchParams();
  p.set('limit', String(c.limit));
  p.set('offset', String(c.offset));
  if (c.q) p.set('q', c.q);
  if (state.filters.author !== 'all') p.set('author', state.filters.author);
  try {
    const data = await api(`/api/repos/${repo.id}/commits?${p.toString()}`);
    c.items = data.commits;
    c.total = data.total;
  } catch (e) {
    return toast('Commits: ' + e.message);
  }
  $('#commits-table').innerHTML =
    '<thead><tr><th>Commit</th><th>Date (UTC)</th><th>Author</th><th class="num">l+</th><th class="num">l−</th><th class="num">λ</th></tr></thead><tbody>' +
    c.items
      .map(
        (x) => `<tr>
          <td class="mono" title="${x.hash}">${x.hash.slice(0, 10)}</td>
          <td class="mono">${fmtDateTime(x.ct)}</td>
          <td>${esc(x.author)}</td>
          <td class="num">${fmtInt(x.added)}</td>
          <td class="num">${fmtInt(x.removed)}</td>
          <td class="num">${fmtInt(x.churn)}</td>
        </tr>`
      )
      .join('') +
    '</tbody>';
  const start = c.total ? c.offset + 1 : 0;
  const end = Math.min(c.offset + c.limit, c.total);
  $('#commit-total').textContent = `showing ${fmtInt(start)}–${fmtInt(end)} of ${fmtInt(c.total)} commits`;
  $('#commits-prev').disabled = c.offset <= 0;
  $('#commits-next').disabled = c.offset + c.limit >= c.total;
}

// ---------- commit picker modal ---------------------------------------------

async function pickerLoad(more) {
  const repo = selectedRepo();
  const pk = state.picker;
  if (!more) { pk.items = []; pk.offset = 0; }
  const p = new URLSearchParams();
  p.set('limit', String(pk.pageSize));
  p.set('offset', String(pk.offset));
  if (pk.q) p.set('q', pk.q);
  try {
    const data = await api(`/api/repos/${repo.id}/commits?${p.toString()}`);
    pk.items = pk.items.concat(data.commits);
    pk.total = data.total;
    pk.offset += data.commits.length;
  } catch (e) {
    return toast('Commits: ' + e.message);
  }
  renderPicker();
}

function renderPicker() {
  const pk = state.picker;
  $('#picker-table').innerHTML =
    '<thead><tr><th></th><th>Commit</th><th>Date (UTC)</th><th>Author</th><th class="num">l+</th><th class="num">l−</th></tr></thead><tbody>' +
    pk.items
      .map(
        (x) => `<tr class="clickable" data-hash="${x.hash}">
          <td><input type="checkbox" ${pk.selected.has(x.hash) ? 'checked' : ''}></td>
          <td class="mono" title="${x.hash}">${x.hash.slice(0, 10)}</td>
          <td class="mono">${fmtDateTime(x.ct)}</td>
          <td>${esc(x.author)}</td>
          <td class="num">${fmtInt(x.added)}</td>
          <td class="num">${fmtInt(x.removed)}</td>
        </tr>`
      )
      .join('') +
    '</tbody>';
  updatePickerCount();
  $('#picker-more').classList.toggle('hidden', pk.items.length >= pk.total);
}

function updatePickerCount() {
  const n = state.picker.selected.size;
  $('#picker-count').textContent = `${fmtInt(n)} selected · ${fmtInt(state.picker.items.length)} of ${fmtInt(state.picker.total)} commits shown`;
}

function openPicker() {
  state.picker.selected = new Set(state.filters.hashes);
  state.picker.q = '';
  $('#picker-search').value = '';
  $('#picker').classList.remove('hidden');
  pickerLoad(false);
}

// ---------- wiring ----------------------------------------------------------

function wireEvents() {
  // repository list / selectors
  $('#f-repo').addEventListener('change', (e) => nav(repoHash(e.target.value, state.tab)));
  $('#top-back').addEventListener('click', () => nav('#/'));
  $('#f-author').addEventListener('change', (e) => setAuthor(e.target.value));
  $('#reset-filters').addEventListener('click', resetFilters);
  $('#pick-commits').addEventListener('click', openPicker);

  // object path input (validated against the known paths)
  const applyPath = () => {
    const raw = $('#f-path').value.trim().replace(/^\/+|\/+$/g, '');
    if (!raw) return setPath('');
    if (state.paths && !state.paths.dirs.has(raw) && !state.paths.files.has(raw)) {
      toast('Unknown file or directory: ' + raw);
      $('#f-path').value = state.filters.path;
      return;
    }
    setPath(raw);
  };
  $('#f-path').addEventListener('change', applyPath);
  $('#f-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); applyPath(); } });

  // commit set mode
  $$('input[name="cmode"]').forEach((r) =>
    r.addEventListener('change', () => {
      state.filters.mode = r.value;
      syncFilterControls();
      refreshMetrics();
    })
  );
  const toTs = (v, endOfDay) => {
    if (!v) return '';
    const t = Date.parse(v + 'T00:00:00Z');
    if (!isFinite(t)) return '';
    return String(Math.floor(t / 1000) + (endOfDay ? 86400 : 0));
  };
  $('#f-from').addEventListener('change', () => { state.filters.from = toTs($('#f-from').value, false); refreshMetrics(); });
  $('#f-to').addEventListener('change', () => { state.filters.to = toTs($('#f-to').value, true); refreshMetrics(); });

  // tabs (each tab is a route: #/repo/<id>/<tab>)
  $$('.tab').forEach((t) => t.addEventListener('click', () => { if (state.repoId) nav(repoHash(state.repoId, t.dataset.tab)); }));

  // commits tab
  let searchTimer = null;
  $('#commit-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.commits.q = e.target.value.trim().toLowerCase();
      state.commits.offset = 0;
      renderCommits();
    }, 250);
  });
  $('#commits-prev').addEventListener('click', () => { state.commits.offset = Math.max(0, state.commits.offset - state.commits.limit); renderCommits(); });
  $('#commits-next').addEventListener('click', () => { state.commits.offset += state.commits.limit; renderCommits(); });

  // picker modal
  $('#picker-close').addEventListener('click', () => $('#picker').classList.add('hidden'));
  $('#picker').addEventListener('click', (e) => { if (e.target === $('#picker')) $('#picker').classList.add('hidden'); });
  $('#picker-more').addEventListener('click', () => pickerLoad(true));
  $('#picker-clear').addEventListener('click', () => { state.picker.selected.clear(); renderPicker(); });
  let pickerTimer = null;
  $('#picker-search').addEventListener('input', (e) => {
    clearTimeout(pickerTimer);
    pickerTimer = setTimeout(() => {
      state.picker.q = e.target.value.trim().toLowerCase();
      pickerLoad(false);
    }, 250);
  });
  $('#picker-table').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-hash]');
    if (!tr) return;
    const hash = tr.getAttribute('data-hash');
    const cb = tr.querySelector('input[type="checkbox"]');
    if (e.target !== cb) cb.checked = !cb.checked;
    if (cb.checked) state.picker.selected.add(hash);
    else state.picker.selected.delete(hash);
    updatePickerCount();
  });
  $('#picker-apply').addEventListener('click', () => {
    const hashes = Array.from(state.picker.selected);
    if (!hashes.length) return toast('Select at least one commit');
    state.filters.hashes = hashes;
    state.filters.mode = 'manual';
    $('#picker').classList.add('hidden');
    syncFilterControls();
    refreshMetrics();
  });

  // authors tab: manual merging
  $('#authors-table').addEventListener('change', (e) => {
    const cb = e.target.closest('input[data-pick]');
    if (!cb) return;
    const id = Number(cb.getAttribute('data-pick'));
    if (cb.checked) state.mergePicks.add(id);
    else state.mergePicks.delete(id);
    renderMergeBar();
  });
  $('#authors-table').addEventListener('click', (e) => {
    const ub = e.target.closest('button[data-unmerge]');
    if (ub) doUnmerge(Number(ub.getAttribute('data-unmerge')));
  });
  $('#merge-do').addEventListener('click', doMerge);
  $('#merge-clear').addEventListener('click', () => { state.mergePicks.clear(); renderAuthors(); });

  // delegated clicks: scope/navigate/author/delete/select-repo
  document.addEventListener('click', (e) => {
    const scope = e.target.closest('[data-scope]');
    if (scope) return setPath(scope.getAttribute('data-scope'));
    const navEl = e.target.closest('[data-nav]');
    if (navEl) return setPath(navEl.getAttribute('data-nav'));
    const au = e.target.closest('[data-author]');
    if (au) return setAuthor(au.getAttribute('data-author'));
    const del = e.target.closest('[data-del]');
    if (del) return deleteRepo(del.getAttribute('data-del'));
    const open = e.target.closest('[data-open]');
    if (open) return nav(repoHash(open.getAttribute('data-open')));
    const rep = e.target.closest('.repo-card');
    if (rep && !e.target.closest('button')) return nav(repoHash(rep.getAttribute('data-id')));
  });

  // add repos
  $('#url-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = $('#url-input').value.trim();
    if (!url) return toast('Enter a repository URL');
    try {
      const repo = await api('/api/repos/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      $('#url-input').value = '';
      await refreshRepos();
      ensurePolling();
      nav(repoHash(repo.id));
    } catch (err) {
      toast('Could not add repository: ' + err.message);
    }
  });

  $('#zip-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const file = $('#zip-input').files[0];
    if (!file) return toast('Choose a .zip file first');
    const btn = $('#zip-btn');
    const original = btn.textContent;
    btn.disabled = true;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/repos/zip');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) btn.textContent = `Uploading ${Math.round((ev.loaded / ev.total) * 100)}%…`;
    };
    xhr.onload = async () => {
      btn.disabled = false;
      btn.textContent = original;
      if (xhr.status !== 201) {
        let msg = 'upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch (err) { /* ignore */ }
        return toast('Could not add repository: ' + msg);
      }
      $('#zip-input').value = '';
      const repo = JSON.parse(xhr.responseText);
      await refreshRepos();
      ensurePolling();
      nav(repoHash(repo.id));
    };
    xhr.onerror = () => {
      btn.disabled = false;
      btn.textContent = original;
      toast('Upload failed (network error)');
    };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

async function boot() {
  wireEvents();
  try {
    await refreshRepos();
  } catch (e) {
    return toast('Cannot reach the server: ' + e.message);
  }
  if (state.repos.some((r) => r.status === 'importing')) ensurePolling();
  await applyRoute();
}

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('hashchange', applyRoute);
