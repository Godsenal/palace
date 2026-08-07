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

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** 명령을 실행하고 전체 출력을 모아 반환(짧은 점검용: git status, port check, doctor). */
export function runCapture(cmd: string, cwd?: string, shell?: string, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const sh = detectShell(shell)
    const child = spawn(sh, ['-l', '-c', cmd], {
      cwd,
      env: process.env
    })
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
export function runStreaming(
  cmd: string,
  cwd: string | undefined,
  onLine: (line: string, level: 'info' | 'error') => void,
  shell?: string
): Promise<number> {
  return new Promise((resolve) => {
    const sh = detectShell(shell)
    const child = spawn(sh, ['-l', '-c', cmd], { cwd, env: process.env })
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
export function spawnLongRunning(
  cmd: string,
  cwd: string,
  onLine: (line: string, level: 'info' | 'error') => void,
  shell?: string
): ChildProcess {
  const sh = detectShell(shell)
  const child = spawn(sh, ['-l', '-c', cmd], {
    cwd,
    env: process.env,
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
