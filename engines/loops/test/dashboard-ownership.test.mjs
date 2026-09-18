import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dashboard = fileURLToPath(new URL('../dashboard-server.mjs', import.meta.url));

test('dispatcher cleanup preserves other-instance and unknown-owner tabs with identical titles', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'palace-dashboard-ownership-'));
  const engine = join(root, 'engine');
  const state = join(root, 'workspaces.json');
  const cli = join(root, 'cmux');
  let child;
  try {
    await Promise.all([mkdir(join(engine, 'bin'), { recursive: true }), mkdir(join(root, 'other'))]);
    await symlink(engine, join(root, 'engine-alias'));
    await writeFile(state, JSON.stringify([
      { ref: 'workspace:10', current_directory: join(root, 'engine-alias') },
      { ref: 'workspace:99', current_directory: join(root, 'other') },
      { ref: 'workspace:98', current_directory: null }
    ]));
    await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = process.env.CMUX_PROOF_STATE;
const workspaces = JSON.parse(fs.readFileSync(path, 'utf8'));
if (args[0] === '--json') console.log(JSON.stringify({workspaces}));
else if (args[0] === 'list-workspaces') console.log(workspaces.map(w => w.ref + ' 🔁 loops dispatcher').join('\\n'));
else if (args[0] === 'close-workspace') fs.writeFileSync(path, JSON.stringify(workspaces.filter(w => w.ref !== args[args.indexOf('--workspace') + 1])));
else if (args[0] === 'read-screen') console.log('finished dispatcher shell');
else if (args[0] === 'identify') console.log(JSON.stringify({caller:{workspace_ref:'workspace:2'}}));
`, { mode: 0o755 });
    await writeFile(join(engine, 'bin', 'spawn-panel.sh'), '#!/bin/zsh\nprintf "workspace:12\\n"\n', { mode: 0o755 });
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
    let output = '';
    let startupError;
    child = spawn(process.execPath, [dashboard], {
      env: { ...process.env, LOOPS_HOME: engine, CMUX_BIN: cli, CMUX_PROOF_STATE: state, PALACE_LOOPS_PORT: String(port), LOOPS_HOST_TOKEN: 'local-test', LOOPS_REMOTE: '0', LINEAR_API_KEY: '', TELEGRAM_BOT_TOKEN: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.on('error', error => { startupError = error; });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    const deadline = Date.now() + 5_000;
    while (!output.includes('Loops dashboard →')) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || Date.now() >= deadline) throw new Error(`Dashboard did not start: ${output}`);
      await delay(25);
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer local-test', 'x-palace-engine-proxy': '1' },
      body: JSON.stringify({ action: 'start' }), signal: AbortSignal.timeout(5_000)
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    const remaining = JSON.parse(await readFile(state, 'utf8'));
    assert.deepEqual(remaining.map(workspace => workspace.ref), ['workspace:99', 'workspace:98']);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});
