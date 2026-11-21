// 送る文面を宛先の書式でクリップボードに入れる。書式の変換と pasteboard への書き込みは clip-draft（nix-darwin の claude/bin）に任せ、
// 窓の常駐のプロセスとパネルの worker の両方がこれを呼ぶ（書式を操縦席の側で二重に持たない）。
import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DRAFT_FORMATS, type DraftFormat } from './model.ts'
import type { ClipResult } from './protocol.ts'

export type ClipOpts = { bin?: string; pasteboard?: string; env?: NodeJS.ProcessEnv }

export const isDraftFormat = (v: unknown): v is DraftFormat => DRAFT_FORMATS.includes(v as DraftFormat)

export async function clipDraft(text: string, format: DraftFormat, opts: ClipOpts = {}): Promise<ClipResult> {
  const bin = opts.bin ?? process.env.COCKPIT_CLIP_DRAFT ?? path.join(os.homedir(), '.local/bin/clip-draft')
  const base = opts.env ?? process.env
  // Orca の worker は GUI の PATH で動き、clip-draft が呼ぶ pandoc（nix-darwin が入れる）が見えないことがあるため足す。
  const env = { ...base, PATH: [base.PATH, '/run/current-system/sw/bin', '/usr/bin', '/bin'].filter(Boolean).join(':') }
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cockpit-clip-'))
  try {
    const file = path.join(dir, 'draft')
    await fsp.writeFile(file, text)
    const args = ['--to', format, ...(opts.pasteboard ? ['--pasteboard', opts.pasteboard] : []), file]
    const out = await new Promise<{ err: Error | null; stdout: string; stderr: string }>((resolve) =>
      execFile(bin, args, { env, timeout: 60_000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }))
    )
    if (out.err) return { copied: false, reason: (out.stderr.trim().split('\n')[0] || out.err.message).slice(0, 300) }
    const subject = /^件名: (.*)$/m.exec(out.stdout)?.[1]
    return subject === undefined ? { copied: true } : { copied: true, subject }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true })
  }
}
