import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * 로그인 셸을 통해 명령을 실행한다. GUI 로 띄운 Electron 은 PATH 가 빈약해서
 * bun / loopctl / brew / tailscale 등을 못 찾는다 → 로그인 셸이 프로필(.zprofile 등)을
 * 로드해 PATH 를 채우게 한다.
 */
export function detectShell(override?: string): string {
  if (override && existsSync(override)) return override
  const env = process.env.SHELL
  if (env && existsSync(env)) return env
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  return '/bin/bash'
}

const PATH_MARKER = '__PALACE_PATH__'

let cachedPath: string | null = null
let priming: Promise<string | null> | null = null

/**
 * 로그인 셸만으로는 부족하다: zsh 는 `-l -c`(로그인·비대화형)에서 ~/.zshrc 를 읽지 않는다.
 * bun / mise / nvm 처럼 zshrc 에서 PATH 에 붙는 도구들은 그래서 통째로 사라진다
 * (`command not found: bun`). → 대화형 로그인 셸을 딱 한 번 띄워 "진짜 PATH" 를 뽑아
 * 캐시하고, 이후 모든 spawn 의 env 에 주입한다. 실행 자체는 계속 비대화형으로 한다
 * (대화형 셸은 스텝마다 느리고 프롬프트/배너 노이즈가 섞인다).
 */
export function primeShellPath(shell?: string): Promise<string | null> {
  if (cachedPath !== null) return Promise.resolve(cachedPath)
  if (priming) return priming
  priming = new Promise<string | null>((resolve) => {
    const sh = detectShell(shell)
    const child = spawn(sh, ['-l', '-i', '-c', `printf '${PATH_MARKER}%s\\n' "$PATH"`], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'] // stdin 없음 → 프로필이 입력을 기다려도 EOF 로 통과
    })
    let out = ''
    const done = (value: string | null): void => {
      clearTimeout(timer)
      cachedPath = value ?? ''
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* noop */
      }
      done(null)
    }, 10_000)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.on('error', () => done(null))
    child.on('close', () => {
      // 대화형 셸은 배너/프롬프트를 섞어 뱉는다 → 마커가 붙은 줄만 취한다.
      const line = out
        .split('\n')
        .reverse()
        .find((l) => l.includes(PATH_MARKER))
      const path = line?.slice(line.indexOf(PATH_MARKER) + PATH_MARKER.length).trim()
      done(path ? path : null)
    })
  })
  return priming
}

/** 캐시된 로그인 PATH 를 얹은 env. 못 구했으면 그냥 현재 env. */
async function shellEnv(shell?: string): Promise<NodeJS.ProcessEnv> {
  const path = await primeShellPath(shell)
  return path ? { ...process.env, PATH: path } : process.env
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 명령을 실행하고 전체 출력을 모아 반환(짧은 점검용: git status, port check, doctor). */
export async function runCapture(
  cmd: string,
  cwd?: string,
  shell?: string,
  timeoutMs = 60_000
): Promise<RunResult> {
  const env = await shellEnv(shell)
  return new Promise((resolve) => {
    const sh = detectShell(shell)
    const child = spawn(sh, ['-l', '-c', cmd], { cwd, env })
    let stdout = ''
    let stderr = ''
    // 타임아웃은 SIGTERM 먼저. git 은 TERM 을 받으면 자기 .git/index.lock 을 지우고 죽지만,
    // SIGKILL 로 바로 죽이면 락이 남아 그 repo 의 이후 pull 이 전부 실패한다.
    let hardKill: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* noop */
      }
      hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* noop */
        }
      }, 3000)
    }, timeoutMs)
    const done = (r: RunResult): void => {
      clearTimeout(timer)
      if (hardKill) clearTimeout(hardKill)
      resolve(r)
    }
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (e) => done({ code: 127, stdout, stderr: stderr + String(e) }))
    child.on('close', (code) => done({ code: code ?? 1, stdout, stderr }))
  })
}

/** 명령을 실행하며 라인 단위로 콜백. install/update 처럼 진행을 보여줘야 하는 스텝용. */
export async function runStreaming(
  cmd: string,
  cwd: string | undefined,
  onLine: (line: string, level: 'info' | 'error') => void,
  shell?: string
): Promise<number> {
  const env = await shellEnv(shell)
  return new Promise((resolve) => {
    const sh = detectShell(shell)
    const child = spawn(sh, ['-l', '-c', cmd], { cwd, env })
    const pump = (level: 'info' | 'error') => {
      let buf = ''
      return (d: Buffer) => {
        buf += d.toString()
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''
        for (const p of parts) onLine(p, level)
      }
    }
    child.stdout.on('data', pump('info'))
    child.stderr.on('data', pump('error'))
    child.on('error', (e) => {
      onLine(String(e), 'error')
      resolve(127)
    })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** 장기 실행 프로세스를 자체 프로세스 그룹으로 spawn(그룹째 kill 가능). */
export async function spawnLongRunning(
  cmd: string,
  cwd: string,
  onLine: (line: string, level: 'info' | 'error') => void,
  shell?: string
): Promise<ChildProcess> {
  const env = await shellEnv(shell)
  const sh = detectShell(shell)
  const child = spawn(sh, ['-l', '-c', cmd], {
    cwd,
    env,
    detached: true // 자체 그룹 리더 → kill(-pid) 로 자식까지 정리
  })
  const pump = (level: 'info' | 'error') => {
    let buf = ''
    return (d: Buffer) => {
      buf += d.toString()
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const p of parts) onLine(p, level)
    }
  }
  child.stdout?.on('data', pump('info'))
  child.stderr?.on('data', pump('error'))
  return child
}

/** 프로세스 그룹째 종료. */
export function killGroup(child: ChildProcess): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* noop */
    }
  }
  // 유예 후 강제
  setTimeout(() => {
    if (child.pid && !child.killed) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* noop */
      }
    }
  }, 4000)
}
