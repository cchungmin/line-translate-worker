import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/deploy.mjs', import.meta.url));
function fixture(t) {
	const root = mkdtempSync(join(tmpdir(), 'line-release-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const remote = join(root, 'remote.git');
	const repo = join(root, 'repo');
	const run = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
	run(root, 'init', '--bare', remote);
	run(root, 'init', '-b', 'main', repo);
	run(repo, 'config', 'user.name', 'Release test');
	run(repo, 'config', 'user.email', 'release@example.invalid');
	writeFileSync(join(repo, 'README'), 'initial');
	run(repo, 'add', 'README');
	run(repo, 'commit', '-m', 'initial');
	run(repo, 'remote', 'add', 'origin', remote);
	run(repo, 'push', '-u', 'origin', 'main');
	return { repo, git: (...args) => run(repo, ...args), check: () => spawnSync(process.execPath, [script, '--check'], { cwd: repo, encoding: 'utf8' }) };
}

test('rejects a feature branch before deployment', t => {
	const f = fixture(t);
	f.git('switch', '-c', 'codex/feature');
	const result = f.check();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /requires the main branch/);
});
test('rejects an untracked or dirty main checkout', t => {
	const f = fixture(t);
	writeFileSync(join(f.repo, 'unreviewed'), 'change');
	assert.match(f.check().stderr, /clean working tree/);
});
test('rejects a local main commit that is not on the remote', t => {
	const f = fixture(t);
	f.git('commit', '--allow-empty', '-m', 'unpublished');
	assert.match(f.check().stderr, /must match/);
});
test('allows preflight for clean main matching the remote without deploying', t => {
	const f = fixture(t);
	const result = f.check();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Release commit: [a-f0-9]{40}/);
});
