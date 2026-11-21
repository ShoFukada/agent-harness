// コピーの書式: 窓とパネルが clip-draft に渡した結果、クリップボードに入る中身（テキストと HTML）を固定する。
// pasteboard への書き込みは sandbox やテストの機械では届かないので、clip-draft が呼ぶ swift を偽物に差し替えて中身を受け取る（clip-draft_test.py と同じ方法）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { DRAFTS } from '../fixtures/drafts.ts'
import { clipDraft } from './clip.ts'
import { draftFormat, type DraftFormat } from './model.ts'

const BIN = process.env.COCKPIT_CLIP_DRAFT ?? path.join(homedir(), '.local/bin/clip-draft')
const hasPandoc = (() => {
  try {
    execFileSync('pandoc', ['--version'], { env: { ...process.env, PATH: `${process.env.PATH}:/run/current-system/sw/bin` } })
    return true
  } catch {
    return false
  }
})()
const skip = !existsSync(BIN) || !hasPandoc ? 'clip-draft か pandoc がこの機械に無い' : false

const FAKE_SWIFT = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
i = args.index("-module-cache-path")
rest = args[:i] + args[i + 2:]
_, name, text, *html = rest
read = lambda p: open(p, encoding="utf-8").read()
json.dump({"name": name, "text": read(text), "html": read(html[0]) if html else None}, open(os.environ["FAKE_SWIFT_OUT"], "w"))
`

const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-clip-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))
mkdirSync(path.join(dir, 'bin'))
writeFileSync(path.join(dir, 'bin/swift'), FAKE_SWIFT)
chmodSync(path.join(dir, 'bin/swift'), 0o755)

type Got = { name: string; text: string; html: string | null }
let n = 0
/** 偽の swift を先に置いた環境で fn を走らせ、pasteboard に渡った中身を返す。 */
async function capture<T>(fn: (env: NodeJS.ProcessEnv) => T | Promise<T>): Promise<{ ret: T; got: Got }> {
  const out = path.join(dir, `out-${n++}.json`)
  const ret = await fn({ ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, FAKE_SWIFT_OUT: out })
  return { ret, got: JSON.parse(readFileSync(out, 'utf8')) as Got }
}

/** clip-draft を拡張子で宛先を決める使い方（reply-draft が下書きを保存して貼るときと同じ）で呼ぶ。 */
const EXT: Record<DraftFormat, string> = { slack: 'md', teams: 'teams.md', mail: 'txt' }
const direct = (f: DraftFormat, text: string) =>
  capture((env) => {
    const file = path.join(dir, `draft-${n}.${EXT[f]}`)
    writeFileSync(file, text)
    return execFileSync(BIN, ['--pasteboard', 'cockpit-test', file], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  })

const PB = 'cockpit-test'
const CHAT_HTML = `<meta charset="utf-8"><p>森さん<br />
林さん</p>
<p>ご確認ありがとうございます。次の2点を直しました。</p>
<ul>
<li><strong>締切</strong>: 11/25（月）18:00</li>
<li>手順書: <a href="https://example.com/manual">手順書（v2）</a></li>
</ul>
<p>よろしくお願いいたします。</p>
`
const MAIL_BODY = DRAFTS.mail.text.slice(DRAFTS.mail.text.indexOf('森様'))

test('コピーの書式: 見本の宛先は経路とリンクから Slack・Teams・メールに決まる', () => {
  assert.deepEqual(Object.values(DRAFTS).map(draftFormat), ['slack', 'teams', 'mail'])
})

test('コピーの書式: Slack は Markdown のテキストだけ、Teams は HTML とテキスト、メールは件名を外したテキスト', { skip }, async () => {
  const slack = await capture((env) => clipDraft(DRAFTS.slack.text, 'slack', { bin: BIN, pasteboard: PB, env }))
  assert.deepEqual(slack.ret, { copied: true })
  assert.deepEqual(slack.got, { name: PB, text: DRAFTS.slack.text, html: null })

  const teams = await capture((env) => clipDraft(DRAFTS.teams.text, 'teams', { bin: BIN, pasteboard: PB, env }))
  assert.deepEqual(teams.ret, { copied: true })
  assert.deepEqual(teams.got, { name: PB, text: DRAFTS.teams.text, html: CHAT_HTML })

  const mail = await capture((env) => clipDraft(DRAFTS.mail.text, 'mail', { bin: BIN, pasteboard: PB, env }))
  assert.deepEqual(mail.ret, { copied: true, subject: '【ご確認】手順書の修正について' })
  assert.deepEqual(mail.got, { name: PB, text: MAIL_BODY, html: null })
})

test('コピーの書式: 操縦席から入れた中身は、同じ本文を clip-draft に下書きのファイルで渡したときと同じ', { skip }, async () => {
  for (const f of ['slack', 'teams', 'mail'] as const) {
    const ours = await capture((env) => clipDraft(DRAFTS[f].text, f, { bin: BIN, pasteboard: PB, env }))
    const theirs = await direct(f, DRAFTS[f].text)
    assert.deepEqual(ours.got, theirs.got, f)
  }
})

test('コピーの書式: clip-draft が無い・失敗したときは入れたことにせず理由を返す', async () => {
  const r = await clipDraft('本文', 'teams', { bin: path.join(dir, 'missing') })
  assert.equal(r.copied, false)
  assert.ok(r.reason)
})
