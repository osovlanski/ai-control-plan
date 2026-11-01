import { createRequire } from 'node:module';
import { URL } from 'node:url';
import process from 'node:process';
// Local runtime-drive fixture: loaded only into the API process by NODE_OPTIONS.
if (process.argv[1]?.endsWith('/src/index.ts') || process.argv[1] === 'src/index.ts') {
  const { register } = await import(createRequire(new URL('../../api/package.json', import.meta.url)).resolve('tsx/esm/api'));
  register();
  const { FakeAdapter } = await import('../../../packages/adapters/src/fake.ts');
  const start = FakeAdapter.prototype.start;
  FakeAdapter.prototype.start = function(run) {
    this.script = { ok: true, delayMs: 200, events: [
      { type: 'message', summary: 'Fake drive started', payload: { text: 'Fake drive started' } },
      { type: 'usage.updated', summary: 'Measured fake cost', payload: { inputTokens: 1200, outputTokens: 450, costUsd: 0.025 } },
      { type: 'message', summary: 'Fake drive completed', payload: { text: 'Fake drive completed' } },
    ] };
    return start.call(this, run);
  };
}
