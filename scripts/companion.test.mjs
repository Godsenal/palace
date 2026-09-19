import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, chmod, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const { startCompanion } = require('../out/companion-server/companion-service.cjs')
const assets = resolve('out/companion')
async function availablePort() {
  const server = createServer()
  await new Promise((accept) => server.listen(0, '127.0.0.1', accept))
  const port = server.address().port
  await new Promise((accept) => server.close(accept))
  return port
}
async function eventually(check, timeout = 20000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await delay(100)
  }
  throw new Error('Timed out waiting for observable state')
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cmux-omp-regression-'))
  const root = join(directory, 'state')
  const repository = join(directory, 'repository')
  await mkdir(repository)
  const git = (...args) => execFileSync('git', ['-C', repository, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Companion regression')
  git('config', 'user.email', 'companion@example.invalid')
  await writeFile(join(repository, 'tracked.txt'), 'original\n')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  const executable = join(directory, 'deterministic-agent')
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
emit({type:'ready',protocolVersion:1});
readline.createInterface({input:process.stdin}).on('line', line => {
  const q = JSON.parse(line);
  if(q.type === 'prompt') {
    emit({type:'response',id:q.id,command:q.type,success:true,data:{agentInvoked:true}});
    if(q.message.includes('hold-open')) { setInterval(() => {}, 1000); return; }
    const count = fs.existsSync('attempt-count') ? Number(fs.readFileSync('attempt-count','utf8')) + 1 : 1;
    fs.writeFileSync('attempt-count', String(count));
    emit({type:'agent_end'});
  } else if(q.type === 'abort') process.exit(0);
  else emit({type:'response',id:q.id,command:q.type,success:true,data:q.type === 'get_state' ? {} : {text:'deterministic result'}});
});
`)
  await chmod(executable, 0o700)
  const port = await availablePort()
  let service = await startCompanion({ root, port, assets, publicUrl: 'https://companion.example.ts.net' })
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }) })
  const token = JSON.parse(await readFile(join(root, 'pairing-token.json'), 'utf8'))
  const api = async (method, args = []) => {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args })
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error)
    return payload.result
  }
  const snapshot = () => service.core.snapshot()
  let current = await snapshot()
  await api('saveSettings', [{ ...current.settings, projectPaths: { fixture: repository }, ompCommand: executable }])
  const save = async (id, extra = {}) => {
    await api('saveLoop', [{ id, name: id, project: 'fixture', mission: 'modify fixture', trigger: { kind: 'manual' }, model: 'auto', checks: [], maxAttempts: 2, timeoutMinutes: 1, enabled: true, ...extra }])
    await api('approveLoop', [id])
  }
  return { root, port, token, api, snapshot, save, repository,
    async restart() { await service.close(); service = await startCompanion({ root, port, assets, publicUrl: 'https://companion.example.ts.net' }) },
    async stop() { await service.close() }
  }
}

test('HTTP boundary requires token, exact origins and allowlisted operations; rotation revokes devices', async (t) => {
  const f = await fixture(t)
  const call = (headers = {}, payload = { method: 'snapshot', args: [] }, path = '/api') => fetch(`http://127.0.0.1:${f.port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload)
  })
  assert.equal((await call()).status, 401)
  assert.equal((await call({}, undefined, `/api?token=${f.token}`)).status, 401)
  assert.equal((await call({ Authorization: `Bearer ${f.token}`, Origin: 'https://attacker.invalid' })).status, 403)
  const hostileHostStatus = await new Promise((accept, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: f.port, path: '/api', method: 'POST',
      headers: { Host: 'attacker.invalid', Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json' }
    }, (response) => { response.resume(); response.on('end', () => accept(response.statusCode)) })
    request.on('error', reject)
    request.end(JSON.stringify({ method: 'snapshot', args: [] }))
  })
  assert.equal(hostileHostStatus, 403)
  assert.equal((await call({ Authorization: `Bearer ${f.token}` }, { method: 'ide.createSession', args: [] })).status, 400)
  assert.equal((await call({ Authorization: `Bearer ${f.token}`, Origin: 'https://companion.example.ts.net' })).status, 200)
  const page = await fetch(`http://127.0.0.1:${f.port}/`)
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.ok(!(await page.text()).includes(f.token))
  assert.equal((await fetch(`http://127.0.0.1:${f.port}/pairing-token.json`)).status, 404)
  execFileSync(process.execPath, ['out/companion-server/companion-service.cjs', 'rotate-token'], { env: { ...process.env, CMUX_OMP_HOME: f.root } })
  assert.equal((await call({ Authorization: `Bearer ${f.token}` })).status, 401)
})

test('checks drive bounded repair; absent checks require review and original checkout stays unchanged', { timeout: 60000 }, async (t) => {
  const f = await fixture(t)
  await f.save('repair', { checks: ['test "$(cat attempt-count)" -eq 2'] })
  const repair = await f.api('runLoop', ['repair'])
  const completed = await eventually(async () => {
    const run = (await f.api('runDetail', [repair.id])).run
    return ['succeeded', 'failed'].includes(run.status) && run
  })
  assert.equal(completed.status, 'succeeded', completed.error)
  assert.equal(completed.attempt, 2)
  assert.equal(await readFile(join(completed.worktree, 'attempt-count'), 'utf8'), '2')
  assert.equal(execFileSync('git', ['-C', f.repository, 'status', '--porcelain'], { encoding: 'utf8' }), '')
  await f.save('review')
  const review = await f.api('runLoop', ['review'])
  await eventually(async () => (await f.api('runDetail', [review.id])).run.status === 'needs-review')
  await f.save('exhausted', { checks: ['test -f never-created'], maxAttempts: 1 })
  const exhausted = await f.api('runLoop', ['exhausted'])
  const failed = await eventually(async () => { const r = (await f.api('runDetail', [exhausted.id])).run; return r.status === 'failed' && r })
  assert.equal(failed.attempt, 1)
})

test('busy scheduled slots coalesce, cancellation stops execution and overdue schedules survive restart', { timeout: 60000 }, async (t) => {
  const f = await fixture(t)
  await f.save('periodic', { mission: 'hold-open', trigger: { kind: 'interval', seconds: 10 } })
  let state = await f.snapshot()
  await f.api('saveSettings', [{ ...state.settings, armed: true }])
  const run = await f.api('runLoop', ['periodic'])
  const firstDue = await eventually(async () => (await f.snapshot()).schedules?.['interval:periodic'])
  await eventually(async () => Date.parse((await f.snapshot()).schedules['interval:periodic']) > Date.parse(firstDue), 16000)
  state = await f.snapshot()
  assert.equal(state.runs.filter((r) => r.loopId === 'periodic').length, 1)
  assert.equal(state.runs[0].id, run.id)
  await f.api('cancelRun', [run.id])
  await eventually(async () => (await f.api('runDetail', [run.id])).run.status === 'cancelled')
  await f.api('saveSettings', [{ ...state.settings, armed: false }])
  await f.stop()
  // Simulate time passing while offline using the actual persisted schedule, not a running clock mock.
  const storedPath = join(f.root, 'state.json')
  const stored = JSON.parse(await readFile(storedPath, 'utf8'))
  stored.schedules['interval:periodic'] = new Date(Date.now() - 60000).toISOString()
  await writeFile(storedPath, JSON.stringify(stored), { mode: 0o600 })
  await f.restart()
  state = await f.snapshot()
  assert.equal(state.runs[0].status, 'cancelled')
  assert.equal(state.approved.periodic, true)
  await f.api('saveSettings', [{ ...state.settings, armed: true }])
  await eventually(async () => (await f.snapshot()).runs.length === 2)
  state = await f.snapshot()
  assert.ok(Date.parse(state.schedules['interval:periodic']) > Date.now())
  await f.api('saveLoop', [{ ...state.profile.loops[0], mission: 'changed mission' }])
  assert.equal((await f.snapshot()).approved.periodic, false)
})

test('skill destinations stay isolated and reviewed updates preserve local files and symlink boundaries', { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'cmux-omp-skills-'))
  const home = join(directory, 'home')
  const root = join(directory, 'state')
  const source = join(directory, 'source')
  const project = join(directory, 'project')
  const linkedProject = join(directory, 'linked-project')
  const outside = join(directory, 'outside')
  await Promise.all([home, project, linkedProject, outside, join(source, 'skills', 'scope-fixture')].map((path) => mkdir(path, { recursive: true })))
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.name', 'Companion regression')
  git('config', 'user.email', 'companion@example.invalid')
  const manifest = '---\nname: scope-fixture\ndescription: Isolated installation boundary fixture.\n---\nRead notes.txt for the current fixture revision.\n'
  await writeFile(join(source, 'skills/scope-fixture/SKILL.md'), manifest)
  await writeFile(join(source, 'skills/scope-fixture/notes.txt'), 'revision-one\n')
  git('add', '.')
  git('commit', '-qm', 'first skill revision')
  const revisionOne = git('rev-parse', 'HEAD').toString().trim()
  const port = await availablePort()
  const child = spawn(process.execPath, [resolve('out/companion-server/companion-service.cjs')], {
    env: { ...process.env, HOME: home, CMUX_OMP_HOME: root, CMUX_OMP_PORT: String(port), CMUX_OMP_PUBLIC_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16000) })
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-16000) })
  const exited = new Promise((accept) => child.once('exit', accept))
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
    await rm(directory, { recursive: true, force: true })
  })
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error(`Skill fixture service exited: ${output}`)
    return fetch(`http://127.0.0.1:${port}/health`).then((response) => response.ok).catch(() => false)
  })
  const token = JSON.parse(await readFile(join(root, 'pairing-token.json'), 'utf8'))
  const api = async (method, args = []) => {
    const response = await fetch(`http://127.0.0.1:${port}/api`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, args })
    })
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error)
    return payload.result
  }
  const settings = (await api('snapshot')).automation.settings
  await api('saveSettings', [{ ...settings, projectPaths: { fixture: project, linked: linkedProject } }])
  const globalTarget = { scope: 'global' }
  const projectTarget = { scope: 'project', project: 'fixture' }
  const preview = () => api('skills.preview', [source, 'scope-fixture'])
  const install = (target, revision) => api('skills.install', [target, source, 'scope-fixture', revision])
  await assert.rejects(api('skills.list', [{ scope: 'global', project: 'fixture' }]))
  await assert.rejects(install(globalTarget, revisionOne))
  const reviewed = await preview()
  const globalSkill = await install(globalTarget, reviewed.revision)
  assert.equal(await readFile(join(globalSkill.path, 'notes.txt'), 'utf8'), 'revision-one\n')
  assert.equal(await realpath(globalSkill.path), await realpath(join(home, '.agents/skills/scope-fixture')))
  assert.deepEqual(await api('skills.list', [projectTarget]), [])
  await preview()
  const projectSkill = await install(projectTarget, reviewed.revision)
  assert.equal(await realpath(projectSkill.path), await realpath(join(project, '.agent/skills/scope-fixture')))
  await writeFile(join(globalSkill.path, 'notes.txt'), 'user-owned changes\n')
  assert.equal((await api('skills.list', [globalTarget]))[0].modified, true)
  await preview()
  await assert.rejects(api('skills.update', [globalTarget, 'scope-fixture', reviewed.revision]))
  await assert.rejects(api('skills.remove', [globalTarget, 'scope-fixture']))
  assert.equal(await readFile(join(globalSkill.path, 'notes.txt'), 'utf8'), 'user-owned changes\n')
  await api('skills.remove', [projectTarget, 'scope-fixture'])
  assert.equal(await readFile(join(globalSkill.path, 'notes.txt'), 'utf8'), 'user-owned changes\n')
  await assert.rejects(readFile(join(projectSkill.path, 'SKILL.md')), { code: 'ENOENT' })
  await writeFile(join(globalSkill.path, 'notes.txt'), 'revision-one\n')
  await writeFile(join(source, 'skills/scope-fixture/notes.txt'), 'revision-two\n')
  git('add', '.')
  git('commit', '-qm', 'second skill revision')
  const secondPreview = await preview()
  assert.notEqual(secondPreview.revision, reviewed.revision)
  await api('skills.update', [globalTarget, 'scope-fixture', secondPreview.revision])
  assert.equal(await readFile(join(globalSkill.path, 'notes.txt'), 'utf8'), 'revision-two\n')
  await api('skills.remove', [globalTarget, 'scope-fixture'])
  await mkdir(globalSkill.path, { recursive: true })
  await writeFile(join(globalSkill.path, 'SKILL.md'), 'An existing unmanaged skill.\n')
  await preview()
  await assert.rejects(install(globalTarget, secondPreview.revision))
  assert.equal(await readFile(join(globalSkill.path, 'SKILL.md'), 'utf8'), 'An existing unmanaged skill.\n')
  await mkdir(join(linkedProject, '.agent'))
  await symlink(outside, join(linkedProject, '.agent/skills'))
  await preview()
  await assert.rejects(install({ scope: 'project', project: 'linked' }, secondPreview.revision))
  await assert.rejects(readFile(join(outside, 'scope-fixture/SKILL.md')), { code: 'ENOENT' })
})
