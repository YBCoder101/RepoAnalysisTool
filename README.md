# RAT — Repo Analysis Tool

COMS3011A Test (Wits) — a **web dashboard** that measures **file, directory, repository, commit-set and author metrics** for Git repositories, filterable by repository, author, file/directory and commit set (time period or manually selected commits).

**AI Declaration:** Claude Web (Opus 5.5) - reviewed

## Requirements

- Node.js 16+ (developed on Node 18)
- Git (the tool shells out to `git` for cloning and analysis)
- `unzip` is used when available (falls back to a pure-JS extractor if absent)

## Run

```bash
./start.sh
```

or manually:

```bash
npm install
npm start
```

Then open **http://localhost:3000** (set `PORT` to change the port, e.g. `PORT=8080 ./start.sh`).

## Using the tool

1. **Manage repositories** on the home page (`#/`): each repository is a card with its status (ready / importing with progress / failed) and stats. Click a card (or *Open dashboard*) to enter its workspace. The URL routes the app — `#/` is the repository manager and `#/repo/<id>/<tab>` is one repository's workspace — so browser back/forward and deep links (even refreshing on a tab) work.
2. **Add a repository**:
   - *Add from URL* — deep-clones any `https://`, `git://`, `ssh://` or `file://` clone URL.
   - *Upload zip* — a zip containing the repository **including its `.git` folder** (the repo may be wrapped in a folder).
   - Multiple repositories can be loaded at once; a progress indicator is shown while cloning/parsing, and results are cached on disk so a restart does not re-parse.
3. **Filter** with the bar above the tabs:
   - *Repository* — switch between loaded repositories.
   - *File / directory* — the scope of the metrics; type a path (autocomplete) or click names in the **Files** tab.
   - *Author* — restrict to one author (merged identities included).
   - *Commit set H* — **All commits**, a **time period** (inclusive dates), or a **manual selection** picked from the commit picker (search by hash prefix, tick commits, apply).
4. **Explore** the tabs:
   - **Overview** — metric cards (l+, l−, δ, λ, n, η, ρ), activity timeline chart, top children by churn λ, and ownership ω per author.
   - **Files** — browse the repository; every file/directory row shows its metrics for the current filters. Click a name to scope the metrics to it.
   - **Authors** — per-author commits, modifications n, churn λ and ownership ω.
   - **Commits** — the commit list (newest first) with paging and hash search.
5. **Author merging**:
   - A repository's `.mailmap` is applied automatically during analysis.
   - Identities can also be merged **manually** in the Authors tab: tick two or more authors, choose the target and click *Merge authors*. Merges are persistent and reversible with the ✕ on a merged member row.

## Metric definitions

| Metric | Definition |
| --- | --- |
| l+ | lines added |
| l− | lines removed |
| δ growth | l+ − l− |
| λ churn | l+ + l− |
| n modifications | number of commits in H that changed the object (churn > 0) |
| η modification frequency | n / \|H\| |
| ρ churn rate | λ / \|H\| |
| n<sub>a</sub> author modifications | commits by author a in H that changed the object |
| A<sub>a</sub> author churn | lines changed by author a in H |
| ω<sub>a</sub> ownership | A<sub>a</sub> / λ |

Measurement rules: only **non-merge commits reachable from HEAD** are counted; **renames are followed** (≥ 50% similarity is the rename threshold); **binary files are not measured**; **file deletions count as lines removed**.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/repos` | list repositories (with status/stats) |
| `POST /api/repos/url` | add a repo from a clone URL (JSON body `{ "url": … }`) |
| `POST /api/repos/zip` | add a repo from a zip (multipart field `file`) |
| `DELETE /api/repos/:id` | remove a repository |
| `GET /api/repos/:id/metrics` | metrics for `path` (file/dir/repo) × `author` × commit set (`from`/`to` unix seconds, or `hashes`) |
| `GET /api/repos/:id/commits` | paged commit list (`limit`, `offset`, `q`, `author`, `from`, `to`) |
| `GET /api/repos/:id/authors` | author list with merge groups |
| `POST /api/repos/:id/authors/merge` | merge authors (JSON `{ "ids": […], "into": id }`) |
| `POST /api/repos/:id/authors/unmerge` | undo one merge (JSON `{ "id": … }`) |
| `GET /api/repos/:id/tree?path=` | immediate children of a directory |
| `GET /api/repos/:id/paths` | all files and directories (autocomplete) |

## Architecture

- `server/index.js` — Express app, REST routes, static dashboard hosting.
- `server/gitparse.js` — streaming parser for `git log --no-merges --numstat -z -M50%` (uses `%aN`/`%aE`, so `.mailmap` is honoured).
- `server/ingest.js` — zip extraction / URL deep clone and the parse pipeline (with progress reporting).
- `server/store.js` — in-memory store (interned files/authors, flattened per-commit ops) with a JSON snapshot cache on disk.
- `server/metrics.js` — the metric engine: filter parsing, commit-set selection, single-pass aggregation of object/children/author/timeline metrics, author merge groups.
- `public/` — dashboard UI (vanilla JS + Chart.js, no build step): hash-routed home and workspace views, SVG logo/favicon (`logo.svg`), filter bar and tab panels.

## Performance

Measured on the development machine (Node 18, deep clones over the network):

| Repository | Commits | Files | Authors | Analysis (parse + index) | Metrics request (repo-wide) |
| --- | --- | --- | --- | --- | --- |
| cJSON | 955 | 250 | 107 | 0.24 s | ~5 ms |
| Redis | 11,874 | 2,881 | 1,035 | 8.8 s | ~24 ms |
| Git | 61,101 | 7,380 | 2,498 | 27.5 s | ~80 ms |

A single parse pipeline streams `git log` output; the resulting snapshot is cached on disk (13 MB for the Git repository), so a server restart reloads all repositories without re-parsing. Repository-wide metrics scan every selected commit in one pass; commit pages, tree and path lookups are served in milliseconds.


## Test repositories

- cJSON — https://github.com/DaveGamble/cJSON.git
- Redis — https://github.com/redis/redis.git
- Git — https://github.com/git/git.git
