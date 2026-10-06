'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

/**
 * Count the non-merge commits reachable from HEAD (used for progress bars).
 */
function countCommits(repoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repoPath, 'rev-list', '--count', '--no-merges', 'HEAD']);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `git rev-list exited with ${code}`));
      resolve(parseInt(out.trim(), 10) || 0);
    });
  });
}

const HEADER_PREFIX = '@@@';
const SEP = '\x01';
const ENTRY_RE = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/**
 * Stream `git log --numstat -z` for a repository and return structured commits.
 *
 * Git's -z numstat wire format (verified empirically):
 *   header:  @@@<hash> \x01 <parents> \x01 <author> \x01 <email> \x01 <unix time> \n
 *   entry:   <added>\t<removed>\t<path>\0
 *   rename:  <added>\t<removed>\t\0<old path>\0<new path>\0
 *   commits are separated by an extra \0
 * Binary files are reported as "-\t-\t" and are returned with null add/rem.
 * %aN/%aE are the mailmap-respecting variants, so author identities arrive
 * already merged when the repository provides a .mailmap.
 */
function parseRepo(repoPath, onCommit) {
  return new Promise((resolve, reject) => {
    const args = [
      '-C', repoPath,
      'log',
      '--no-merges',
      '--numstat',
      '-z',
      '-M50%',
      '--pretty=format:@@@%H\x01%P\x01%aN\x01%aE\x01%ct',
    ];
    const child = spawn('git', args);
    const decoder = new StringDecoder('utf8');
    const commits = [];
    let current = null;
    let pendingRename = null; // { add, rem, old } while reading a rename's two paths
    let carry = '';
    let err = '';

    const pushEntry = (add, rem, path, oldPath) => {
      if (!current) return;
      current.entries.push({
        path,
        oldPath,
        add: add === '-' ? null : parseInt(add, 10),
        rem: rem === '-' ? null : parseInt(rem, 10),
      });
    };

    const handleEntry = (token) => {
      const m = ENTRY_RE.exec(token);
      if (!m) return; // stray token, ignore defensively
      const [, add, rem, p] = m;
      if (p === '') {
        pendingRename = { add, rem, old: null };
        return;
      }
      pushEntry(add, rem, p, null);
    };

    const finalize = () => {
      if (current) {
        commits.push(current);
        current = null;
        if (onCommit) onCommit(commits.length);
      }
    };

    const handleToken = (token) => {
      if (token.startsWith(HEADER_PREFIX)) {
        finalize();
        const nl = token.indexOf('\n');
        const head = nl === -1 ? token : token.slice(0, nl);
        const rest = nl === -1 ? '' : token.slice(nl + 1);
        const f = head.split(SEP);
        current = {
          hash: f[0].slice(HEADER_PREFIX.length),
          parents: (f[1] || '').split(' ').filter(Boolean),
          name: f[2] || '',
          email: f[3] || '',
          ct: parseInt(f[4], 10) || 0,
          entries: [],
        };
        pendingRename = null;
        if (rest) handleEntry(rest);
        return;
      }
      if (pendingRename) {
        if (pendingRename.old === null) {
          pendingRename.old = token;
        } else {
          pushEntry(pendingRename.add, pendingRename.rem, token, pendingRename.old);
          pendingRename = null;
        }
        return;
      }
      if (token === '') return; // commit separator
      handleEntry(token);
    };

    child.stdout.on('data', (chunk) => {
      carry += decoder.write(chunk);
      const parts = carry.split('\0');
      carry = parts.pop();
      for (const part of parts) handleToken(part);
    });
    child.stderr.on('data', (chunk) => {
      err += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `git log exited with ${code}`));
      finalize();
      resolve(commits);
    });
  });
}

module.exports = { parseRepo, countCommits };
