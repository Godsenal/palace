import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('../bin/spawn-panel.sh', import.meta.url));

test('a lost create response never closes a concurrent user workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palace-cmux-ownership-'));
  const cli = join(root, 'cmux');
  const state = join(root, 'workspaces.json');
  try {
    await writeFile(state, JSON.stringify(['workspace:1']));
    await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const state = process.env.CMUX_PROOF_STATE;
const args = process.argv.slice(2);
let refs = JSON.parse(fs.readFileSync(state, 'utf8'));
if (args[0] === 'new-workspace') {
  refs.push('workspace:99'); // A user opens an ordinary terminal during this request.
  fs.writeFileSync(state, JSON.stringify(refs));
  console.error('Error: Command timed out');
  process.exit(1);
}
if (args[0] === 'list-workspaces') console.log(refs.join('\\n'));
else if (args[0] === 'workspace' && args[1] === 'list') console.log(JSON.stringify({workspaces:refs.map(ref=>({ref,current_directory:process.env.CMUX_PROOF_CWD,has_custom_title:false}))}));
else if (args[0] === 'close-workspace') {
  refs = refs.filter(ref => ref !== args[args.indexOf('--workspace') + 1]);
  fs.writeFileSync(state, JSON.stringify(refs));
}
`, { mode: 0o755 });
    await assert.rejects(run('/bin/zsh', [helper, root, 'true', 'Owned launch'], {
      env: { ...process.env, LOOPS_HOME: root, CMUX_BIN: cli, CMUX_PROOF_STATE: state, CMUX_PROOF_CWD: root },
      timeout: 10_000
    }), error => error.code === 1);
    assert.deepEqual(JSON.parse(await readFile(state, 'utf8')), ['workspace:1', 'workspace:99']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('long commands execute intact through a bounded terminal input line', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palace-cmux-long-command-'));
  const cli = join(root, 'cmux');
  const output = join(root, 'result');
  const payload = 'verified-long-command-'.repeat(200);
  try {
    await writeFile(cli, `#!${process.execPath}
const {spawnSync} = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'new-workspace') {
  const command = args[args.indexOf('--command') + 1];
  spawnSync('/bin/zsh', ['-c', command.slice(0, 1024)], {cwd:args[args.indexOf('--cwd') + 1],stdio:'ignore'});
  console.log('workspace:99');
} else if (args[0] === 'list-workspaces') console.log('workspace:99');
else if (args[0] === 'read-screen') console.log('terminal ready');
`, { mode: 0o755 });
    await run('/bin/zsh', [helper, root, `printf '%s' '${payload}' > '${output}'`, 'Long command'], {
      env: { ...process.env, LOOPS_HOME: root, CMUX_BIN: cli },
      timeout: 10_000
    });
    assert.equal(await readFile(output, 'utf8'), payload);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a visible shell without command execution is not reported as a started panel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'palace-cmux-start-ack-'));
  const cli = join(root, 'cmux');
  const state = join(root, 'workspaces.json');
  try {
    await writeFile(state, JSON.stringify(['workspace:1', 'workspace:99']));
    await writeFile(cli, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const state = process.env.CMUX_PROOF_STATE;
if (args[0] === 'new-workspace') console.log('workspace:99');
else if (args[0] === 'read-screen') console.log('shell ready; requested command never ran');
else if (args[0] === 'list-workspaces') console.log(JSON.parse(fs.readFileSync(state,'utf8')).join('\\n'));
else if (args[0] === 'close-workspace') fs.writeFileSync(state,JSON.stringify(['workspace:1']));
`, { mode: 0o755 });
    await assert.rejects(run('/bin/zsh', [helper, root, 'true', 'Missing command'], {
      env: { ...process.env, LOOPS_HOME: root, CMUX_BIN: cli, CMUX_PROOF_STATE: state, LOOPS_SPAWN_QUIET: '1' },
      timeout: 15_000
    }), error => error.code === 1);
    assert.deepEqual(JSON.parse(await readFile(state, 'utf8')), ['workspace:1']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
