import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Config } from './config.js';

type Source = NonNullable<Config['sources']>[number];

export interface FetchOptions {
  /** Fetch only the source whose repo equals this (case-insensitive). */
  only?: string;
  /** The URL git clones a repo from; https://github.com/<repo> by default. */
  urlFor?: (repo: string) => string;
  /** Runs git with these arguments in `cwd`. */
  git?: (args: string[], cwd: string) => Promise<void>;
}

// Copies of launcher's contracts/rules.json (sourceRepo, sourceBranch, sourcePath).
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,255}(?<!\/)$/;
const PATH =
  /^(\.|(?!\/)(?!.*\/\/)(?!.*(^|\/)\.(\/|$))(?!.*(^|\/)\.\.(\/|$))(?!.*(^|\/)\.git(\/|$))[A-Za-z0-9._/-]{1,200}(?<!\/))$/;

export function runGit(args: string[], cwd: string): Promise<void> {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, env: process.env }, (err, _out, stderr) =>
      err ? fail(new Error(`git ${args[0]} failed: ${stderr.trim() || err.message}`)) : done(),
    );
  });
}

// Extra checks beside the copied rules: names git or the filesystem treats as
// `.git` (case-insensitive and 8.3 forms, trailing dot or space).
function unsafeSegment(seg: string): boolean {
  if (seg === '.') return false;
  const lower = seg.toLowerCase();
  return lower === '.git' || lower === 'git~1' || seg.endsWith('.') || seg.endsWith(' ');
}

function readSources(root: string): Source[] {
  const file = join(root, 'package.json');
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, 'utf8')) as { lunega?: Config };
  const sources: unknown = json.lunega?.sources;
  if (sources === undefined) return [];
  if (!Array.isArray(sources)) throw new Error('sources: must be a list');
  return sources.map((s, i) => check(s, i));
}

function check(s: unknown, i: number): Source {
  const at = `sources[${i}]`;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) throw new Error(`${at}: must be an object`);
  const { repo, branch, dir, into } = s as Record<string, unknown>;
  const str = (v: unknown, name: string, rule: RegExp) => {
    if (typeof v !== 'string' || !rule.test(v)) throw new Error(`${at}.${name}: invalid`);
    return v;
  };
  str(repo, 'repo', REPO);
  // The name half of "owner/name" would make the URL point elsewhere as "." or "..".
  if (/\/\.\.?$/.test(repo as string)) throw new Error(`${at}.repo: invalid`);
  str(branch, 'branch', BRANCH);
  str(dir, 'dir', PATH);
  str(into, 'into', PATH);
  for (const [name, value] of [['dir', dir], ['into', into]] as const) {
    if ((value as string).split('/').some(unsafeSegment)) throw new Error(`${at}.${name}: invalid`);
  }
  if (into === '.') throw new Error(`${at}.into: invalid`);
  return { repo, branch, dir, into } as Source;
}

/**
 * Replaces each source's `into` (relative to `root`) with its `dir` from the
 * head of its branch. Uses the caller's own git credentials. Returns the
 * `into`s written.
 */
export async function fetchSources(root: string, opts: FetchOptions = {}): Promise<string[]> {
  const urlFor = opts.urlFor ?? ((repo: string) => `https://github.com/${repo}`);
  const git = opts.git ?? runGit;
  let sources = readSources(root);
  if (opts.only !== undefined) {
    const only = opts.only.toLowerCase();
    sources = sources.filter((s) => s.repo.toLowerCase() === only);
    if (sources.length === 0) throw new Error(`no source ${opts.only} in package.json`);
  }

  const written: string[] = [];
  for (const source of sources) {
    await fetchOne(root, source, urlFor(source.repo), git);
    written.push(source.into);
  }
  return written;
}

async function fetchOne(
  root: string,
  { branch, dir, into }: Source,
  url: string,
  git: (args: string[], cwd: string) => Promise<void>,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), 'lunega-fetch-'));
  try {
    // Every value that came from package.json is either a separate argument
    // after `--`, part of the URL, or part of a `refs/heads/` name, so git
    // never reads one as an option.
    await git(['init', '-q'], tmp);
    await git(['remote', 'add', 'origin', url], tmp);
    if (dir !== '.') await git(['sparse-checkout', 'set', '--cone', '--', dir], tmp);
    await git(['fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', `refs/heads/${branch}`], tmp);
    await git(['checkout', '-q', 'FETCH_HEAD'], tmp);

    const realTmp = realpathSync(tmp);
    const from = join(realTmp, dir);
    if (!existsSync(from) || !statSync(from).isDirectory()) {
      throw new Error(`${url}: no folder ${dir} on ${branch}`);
    }
    // A symlink in the checkout (dir or an ancestor) would copy what it points to.
    const realFrom = realpathSync(from);
    if (realFrom !== from || !inside(realTmp, realFrom)) throw new Error(`${dir}: is or passes a symlink`);
    const target = checkTarget(root, into);
    const staged = `${target}.fetching`;
    rmSync(staged, { recursive: true, force: true });
    mkdirSync(dirname(target), { recursive: true });
    cpSync(from, staged, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => !(dir === '.' && src === join(from, '.git')),
    });
    rmSync(target, { recursive: true, force: true });
    renameSync(staged, target);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function inside(parent: string, path: string): boolean {
  const rel = relative(parent, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

// Run right before each source's write: an earlier source may have planted a link.
// Refuses a symlink anywhere between root and the target's parent, and a
// parent that lies in root/.git (compared case-insensitively).
function checkTarget(root: string, into: string): string {
  const realRoot = realpathSync(root);
  const target = join(realRoot, into);
  let current = realRoot;
  for (const part of dirname(into) === '.' ? [] : dirname(into).split('/')) {
    current = join(current, part);
    if (!existsSync(current) && !isLink(current)) break;
    if (isLink(current)) throw new Error(`into ${into}: ${relative(realRoot, current)} is a symlink`);
  }
  if (existsSync(dirname(target))) {
    const parent = realpathSync(dirname(target)).toLowerCase();
    const git = join(realRoot, '.git').toLowerCase();
    if (parent === git || parent.startsWith(git + sep) || join(parent, '').startsWith(git + sep)) {
      throw new Error(`into ${into}: inside .git`);
    }
  }
  if (target === realRoot || !inside(realRoot, target)) throw new Error(`into ${into}: outside the app`);
  return target;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
