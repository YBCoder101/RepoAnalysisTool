# RAT — Repo Analysis Tool

COMS3011A Test (Wits) — a **web dashboard** that measures **file, directory, repository, commit-set and author metrics** for Git repositories, filterable by repository, author, file/directory and commit set (time period or manually selected commits).

**AI Declaration:** Claude Web (Opus 5.5) - reviewed

## Requirements

- Node.js 16+ (developed on Node 18)
- Git (the tool shells out to `git` for cloning and analysis)

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

## Progress

- [x] Stage 0 — scaffold: Express server, `start.sh`, README
- [x] Stage 1 — ingestion: clone from URL / zip upload, multi-repo support
- [x] Stage 2 — metrics engine + API (all metric categories, filtering)
- [ ] Stage 3 — dashboard UI
- [ ] Stage 4 — author merging (mailmap + manual)
- [ ] Stage 5 — polish, performance, final verification

## Test repositories

- cJSON — https://github.com/DaveGamble/cJSON.git
- Redis — https://github.com/redis/redis.git
- Git — https://github.com/git/git.git
