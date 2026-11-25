import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fetchSources } from './fetch.js';

let base: string;
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, stdio: 'pipe' });

// A bare repo at <base>/<repo>.git with one commit on `branch`.
function fixture(repo: string, branch: string, files: Record<string, string>) {
  const work = mkdtempSync(join(base, 'work-'));
  git(work, 'init', '-q', `--initial-branch=${branch}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  const bare = join(base, `${repo}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  git(base, 'clone', '-q', '--bare', work, bare);
}

const urlFor = (repo: string) => join(base, `${repo}.git`);

function app(sources: unknown): string {
  const root = mkdtempSync(join(base, 'app-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x', lunega: { sources } }));
  return root;
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => !p.endsWith('.git')).sort();

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'fetch-test-'));
  fixture('acme/content', 'main', { 'docs/a.md': 'A', 'docs/sub/b.md': 'B', 'other/c.md': 'C', 'root.txt': 'R' });
  fixture('acme/more', 'main', { 'x.txt': 'X' });
  fixture('acme/plant', 'main', { 'docs/x.txt': 'X' });
  // links: docs/rel -> a.md (relative), escape -> an absolute folder, docs2/up -> ../docs
  fixture('acme/links', 'main', { 'docs/a.md': 'A', 'docs/sub/s.txt': 'S', 'other/o.txt': 'O' });
  const w = mkdtempSync(join(base, 'links-'));
  git(w, 'clone', '-q', join(base, 'acme/links.git'), '.');
  symlinkSync('a.md', join(w, 'docs/rel'));
  symlinkSync(tmpdir(), join(w, 'escape'));
  symlinkSync('../other', join(w, 'docs/up'));
  symlinkSync('.', join(w, 'loop'));
  git(w, 'add', '-A');
  git(w, 'commit', '-q', '-m', 'links');
  git(w, 'push', '-q', 'origin', 'HEAD:main');
  fixture('-evil/-repo', '-dash', { '-dir/f.txt': 'F', 'keep.txt': 'K' });
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('fetchSources', () => {
  test('no sources gives an empty list', async () => {
    expect(await fetchSources(app(undefined), { urlFor })).toEqual([]);
    expect(await fetchSources(app([]), { urlFor })).toEqual([]);
  });

  test('no package.json gives an empty list', async () => {
    expect(await fetchSources(mkdtempSync(join(base, 'empty-')), { urlFor })).toEqual([]);
  });

  test('places only dir at into', async () => {
    const root = app([{ repo: 'acme/content', branch: 'main', dir: 'docs', into: 'content' }]);
    expect(await fetchSources(root, { urlFor })).toEqual(['content']);
    expect(tree(join(root, 'content'))).toEqual(['a.md', 'sub', 'sub/b.md']);
    expect(readFileSync(join(root, 'content/sub/b.md'), 'utf8')).toBe('B');
    expect(existsSync(join(root, 'other'))).toBe(false);
  });

  test('replaces an existing into', async () => {
    const root = app([{ repo: 'acme/content', branch: 'main', dir: 'docs', into: 'content/docs' }]);
    mkdirSync(join(root, 'content/docs'), { recursive: true });
    writeFileSync(join(root, 'content/docs/stale.md'), 'old');
    writeFileSync(join(root, 'content/mine.md'), 'mine');
    await fetchSources(root, { urlFor });
    expect(tree(join(root, 'content'))).toEqual(['docs', 'docs/a.md', 'docs/sub', 'docs/sub/b.md', 'mine.md']);
  });

  test('dir "." takes the whole repo without .git', async () => {
    const root = app([{ repo: 'acme/content', branch: 'main', dir: '.', into: 'all' }]);
    await fetchSources(root, { urlFor });
    expect(tree(join(root, 'all'))).toEqual(['docs', 'docs/a.md', 'docs/sub', 'docs/sub/b.md', 'other', 'other/c.md', 'root.txt']);
    expect(existsSync(join(root, 'all/.git'))).toBe(false);
  });

  test('only limits to one repo, case-insensitively', async () => {
    const root = app([
      { repo: 'acme/content', branch: 'main', dir: 'docs', into: 'one' },
      { repo: 'acme/more', branch: 'main', dir: '.', into: 'two' },
    ]);
    expect(await fetchSources(root, { urlFor, only: 'ACME/More' })).toEqual(['two']);
    expect(existsSync(join(root, 'one'))).toBe(false);
    expect(readFileSync(join(root, 'two/x.txt'), 'utf8')).toBe('X');
  });

  test('only with no matching source throws', async () => {
    const root = app([{ repo: 'acme/content', branch: 'main', dir: 'docs', into: 'one' }]);
    await expect(fetchSources(root, { urlFor, only: 'acme/nope' })).rejects.toThrow('no source');
  });

  test('a missing dir in the repo throws and leaves into alone', async () => {
    const root = app([{ repo: 'acme/content', branch: 'main', dir: 'nope', into: 'content' }]);
    mkdirSync(join(root, 'content'));
    writeFileSync(join(root, 'content/keep.md'), 'k');
    await expect(fetchSources(root, { urlFor })).rejects.toThrow('nope');
    expect(readFileSync(join(root, 'content/keep.md'), 'utf8')).toBe('k');
  });

  test('a missing branch throws', async () => {
    const root = app([{ repo: 'acme/content', branch: 'nope', dir: 'docs', into: 'content' }]);
    await expect(fetchSources(root, { urlFor })).rejects.toThrow();
    expect(existsSync(join(root, 'content'))).toBe(false);
  });
});

describe('symlinks and case', () => {
  const src = (over: Record<string, unknown>) => ({ repo: 'acme/content', branch: 'main', dir: 'docs', into: 'content', ...over });

  test('a symlinked parent of into is refused and nothing outside root is touched', async () => {
    const root = app([src({ into: 'content/docs' })]);
    const outside = mkdtempSync(join(base, 'outside-'));
    mkdirSync(join(outside, 'docs'));
    writeFileSync(join(outside, 'docs/keep.txt'), 'k');
    symlinkSync(outside, join(root, 'content'));
    await expect(fetchSources(root, { urlFor })).rejects.toThrow('symlink');
    expect(readFileSync(join(outside, 'docs/keep.txt'), 'utf8')).toBe('k');
  });

  test('a link planted by an earlier source is refused for the next one', async () => {
    const root = app([
      { repo: 'acme/links', branch: 'main', dir: '.', into: 'first' },
      { repo: 'acme/content', branch: 'main', dir: 'docs', into: 'first/escape/docs' },
    ]);
    const before = readdirSync(tmpdir()).includes('docs');
    await expect(fetchSources(root, { urlFor })).rejects.toThrow('symlink');
    expect(existsSync(join(tmpdir(), 'docs'))).toBe(before);
  });

  test('a symlinked dir is refused', async () => {
    const root = app([{ repo: 'acme/links', branch: 'main', dir: 'escape', into: 'out' }]);
    await expect(fetchSources(root, { urlFor })).rejects.toThrow('symlink');
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  test('a dir under a symlinked ancestor is refused', async () => {
    const root = app([{ repo: 'acme/links', branch: 'main', dir: 'loop/loop', into: 'out' }]);
    await expect(fetchSources(root, { urlFor })).rejects.toThrow('symlink');
    expect(existsSync(join(root, 'out'))).toBe(false);
  });

  test('relative symlinks inside fetched content stay relative', async () => {
    const root = app([{ repo: 'acme/links', branch: 'main', dir: 'docs', into: 'out' }]);
    await fetchSources(root, { urlFor });
    expect(lstatSync(join(root, 'out/rel')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'out/rel'))).toBe('a.md');
    expect(readlinkSync(join(root, 'out/up'))).toBe('../other');
  });

  test.each([
    ['into .GIT/hooks', { into: '.GIT/hooks' }],
    ['into x/.Git', { into: 'x/.Git' }],
    ['dir .Git', { dir: '.Git' }],
    ['dir a/.GIT/b', { dir: 'a/.GIT/b' }],
    ['into ending in dot', { into: 'x/git.' }],
    ['into ending in dot (segment)', { into: 'a./b' }],
    ['dir ending in dot', { dir: 'docs.' }],
    ['into ending in space', { into: 'x /y' }],
    ['dir ending in space', { dir: 'docs ' }],
    ['into git~1', { into: 'GIT~1/hooks' }],
    ['dir git~1', { dir: 'git~1' }],
  ])('%s throws before git runs', async (_n, over) => {
    const calls: string[][] = [];
    await expect(fetchSources(app([src(over)]), { urlFor, git: async (a) => void calls.push(a) })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('a target whose parent resolves into root/.git is refused', async () => {
    const root = app([src({ into: 'ok/x' })]);
    mkdirSync(join(root, '.git/hooks'), { recursive: true });
    // ok is a real folder here, so only the .git check could stop a link; use a link-free guard: ok -> .git is a symlink
    symlinkSync(join(root, '.git'), join(root, 'ok'));
    await expect(fetchSources(root, { urlFor })).rejects.toThrow();
    expect(readdirSync(join(root, '.git'))).toEqual(['hooks']);
  });
});

describe('validation', () => {
  const bad = (over: Record<string, unknown>) => ({ repo: 'acme/content', branch: 'main', dir: 'docs', into: 'content', ...over });

  test.each([
    ['into ..', { into: '../x' }],
    ['into nested ..', { into: 'a/../../x' }],
    ['into absolute', { into: '/etc' }],
    ['into .', { into: '.' }],
    ['into empty', { into: '' }],
    ['into .git', { into: '.git' }],
    ['into inside .git', { into: 'a/.git/b' }],
    ['into dot segment', { into: 'a/./b' }],
    ['into trailing slash', { into: 'a/' }],
    ['dir ..', { dir: '..' }],
    ['dir absolute', { dir: '/etc' }],
    ['dir .git', { dir: '.git' }],
    ['dir empty', { dir: '' }],
    ['repo without owner', { repo: 'content' }],
    ['repo with extra slash', { repo: 'a/b/c' }],
    ['repo name ..', { repo: 'a/..' }],
    ['repo with url', { repo: 'https://evil.example/x' }],
    ['branch with ..', { branch: 'a..b' }],
    ['branch with space', { branch: 'a b' }],
    ['branch empty', { branch: '' }],
  ])('%s throws before touching disk', async (_name, over) => {
    const root = app([bad({}), bad(over)]);
    const calls: string[][] = [];
    await expect(fetchSources(root, { urlFor, git: async (args) => void calls.push(args) })).rejects.toThrow();
    expect(calls).toEqual([]);
    expect(existsSync(join(root, 'content'))).toBe(false);
    expect(existsSync(join(root, 'x'))).toBe(false);
  });

  test('a source that is not an object throws', async () => {
    await expect(fetchSources(app(['acme/content']), { urlFor })).rejects.toThrow();
    await expect(fetchSources(app('x'), { urlFor })).rejects.toThrow('sources');
  });
});

describe('git argument injection', () => {
  test('values starting with a dash are never read as options', async () => {
    const root = app([{ repo: '-evil/-repo', branch: '-dash', dir: '-dir', into: 'out' }]);
    const calls: string[][] = [];
    const real = await import('./fetch.js');
    await real.fetchSources(root, {
      urlFor,
      git: async (args, cwd) => {
        calls.push(args);
        await real.runGit(args, cwd);
      },
    });
    expect(readFileSync(join(root, 'out/f.txt'), 'utf8')).toBe('F');
    expect(existsSync(join(root, 'out/keep.txt'))).toBe(false);
    for (const args of calls) {
      for (const [i, arg] of args.entries()) {
        if (arg.includes('-dash') || arg.includes('-dir') || arg.includes('-repo')) {
          // Either part of a refs/heads/ name, or after a `--`, or inside a value that does not start with "-".
          const afterSeparator = args.indexOf('--') !== -1 && args.indexOf('--') < i;
          expect(afterSeparator || !arg.startsWith('-')).toBe(true);
        }
      }
    }
  });

  test('the url is the full github url by default and the branch is a full ref', async () => {
    const root = app([{ repo: 'acme/content', branch: '-b', dir: '-d', into: 'out' }]);
    const calls: string[][] = [];
    await fetchSources(root, { git: async (args) => void calls.push(args) }).catch(() => {});
    const flat = calls.flat();
    expect(flat).toContain('https://github.com/acme/content');
    expect(flat).toContain('refs/heads/-b');
    expect(flat).not.toContain('-b');
    const sparse = calls.find((a) => a[0] === 'sparse-checkout')!;
    expect(sparse.indexOf('--')).toBeGreaterThan(-1);
    expect(sparse.indexOf('-d')).toBeGreaterThan(sparse.indexOf('--'));
    expect(calls.filter((a) => a[0] !== 'sparse-checkout').flat()).not.toContain('-d');
  });
});
