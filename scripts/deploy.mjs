import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
	if (git('branch', '--show-current') !== 'main') throw new Error('Release requires the main branch. Review and merge both PRs first.');
	if (git('status', '--porcelain')) throw new Error('Release requires a clean working tree.');
	git('fetch', 'origin', 'main');
	if (git('rev-parse', 'HEAD') !== git('rev-parse', 'FETCH_HEAD')) throw new Error('Local main must match the current origin/main.');
	console.log(`Release commit: ${git('rev-parse', 'HEAD')}`);
	if (!process.argv.includes('--check')) {
		// The queue must be provisioned deliberately with the documented retention.
		execFileSync('pnpm', ['exec', 'wrangler', 'queues', 'info', 'line-translate-events'], { stdio: 'inherit' });
		execFileSync('pnpm', ['exec', 'wrangler', 'deploy'], { stdio: 'inherit' });
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : 'Release preflight failed.');
	process.exitCode = 1;
}
