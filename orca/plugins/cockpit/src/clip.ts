// 送る文面を宛先の書式でクリップボードに入れる。書式の変換と pasteboard への書き込みは clip-draft（nix-darwin の claude/bin）に任せ、
// 窓の常駐のプロセスとパネルの worker の両方がこれを呼ぶ（書式を操縦席の側で二重に持たない）。
import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DRAFT_FORMATS, type DraftFormat } from './model.ts'
import type { ClipResult } from './protocol.ts'

export type ClipOpts = { bin?: string; pasteboard?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export const isDraftFormat = (v: unknown): v is DraftFormat => DRAFT_FORMATS.includes(v as DraftFormat)

export async function clipDraft(text: string, format: DraftFormat, opts: ClipOpts = {}): Promise<ClipResult> {
  const bin = opts.bin ?? process.env.COCKPIT_CLIP_DRAFT ?? path.join(os.homedir(), '.local/bin/clip-draft')
  const base = opts.env ?? process.env
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-clip-'))
  // clip-draft の一時ファイルもここに置き、期限切れで止めたときも finally で一緒に消す。
  // PATH は、Orca の worker が GUI の PATH で動き、clip-draft が呼ぶ pandoc（nix-darwin が入れる）が見えないことがあるため足す。
  const env = { ...base, TMPDIR: dir, PATH: [base.PATH, '/run/current-system/sw/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') }
  try {
    const file = path.join(dir, 'draft')
    await fsp.writeFile(file, text)
    const args = ['--to', format, ...(opts.pasteboard ? ['--pasteboard', opts.pasteboard] : []), file]
    // 期限切れでは clip-draft が起こした swift ごと止める（残すと、あとで古い本文をクリップボードに書く）。execFile は detached でもプロセスのまとまりを分けないので spawn を使う。
    const out = await new Promise<{ code: number | null; timedOut: boolean; stdout: string; stderr: string; error?: Error }>((resolve) => {
      const child = spawn(bin, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c))
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c))
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          // 既に終わっている。
        }
      }, opts.timeoutMs ?? 60_000)
      child.on('error', (error: Error) => {
        clearTimeout(timer)
        resolve({ code: null, timedOut, stdout, stderr, error })
      })
      child.on('close', (code: number | null) => {
        clearTimeout(timer)
        resolve({ code, timedOut, stdout, stderr })
      })
    })
    if (out.timedOut) return { copied: false, reason: 'clip-draft が時間内に終わりませんでした' }
    if (out.code !== 0) return { copied: false, reason: (out.stderr.trim().split('\n')[0] || out.error?.message || `clip-draft が ${out.code} で終わりました`).slice(0, 300) }
    const subject = /^件名: (.*)$/m.exec(out.stdout)?.[1]
    return subject === undefined ? { copied: true } : { copied: true, subject }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}
