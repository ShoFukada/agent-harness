// コピーの書式: 窓とパネルが clip-draft に渡した結果、クリップボードに入る中身（テキストと HTML）を固定する。
// pasteboard への書き込みは sandbox やテストの機械では届かないので、clip-draft が呼ぶ swift を偽物に差し替えて中身を受け取る（clip-draft_test.py と同じ方法）。
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { DRAFTS, REVIEW_SAMPLE } from '../fixtures/drafts.ts'
import { copyTarget } from './controller.ts'
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

test('コピーの書式: 見てのカードの見本（追加 25）は、押した 3 つのボタンそれぞれの書式で同じ本文を入れる。メールは clip-draft が Markdown の記号を外した素の文字列で入れる', { skip }, async () => {
  const got: Record<string, Got> = {}
  for (const f of ['slack', 'teams', 'mail'] as const) {
    const d = copyTarget(REVIEW_SAMPLE, f)!
    assert.equal(d.href, undefined, 'スレッドは開かない')
    got[f] = (await capture((env) => clipDraft(d.text, draftFormat(d)!, { bin: BIN, pasteboard: PB, env }))).got
  }
  assert.deepEqual(got, {
    slack: { name: PB, text: REVIEW_SAMPLE.text, html: null },
    teams: { name: PB, text: REVIEW_SAMPLE.text, html: CHAT_HTML },
    mail: { name: PB, text: '森さん\n林さん\n\nご確認ありがとうございます。次の2点を直しました。\n・締切: 11/25（月）18:00\n・手順書: 手順書（v2） https://example.com/manual\n\nよろしくお願いいたします。\n', html: null }
  })
})

test('コピーの書式: 期限が切れたら clip-draft が起こした swift ごと止め、あとからクリップボードに書かせない', { skip }, async () => {
  const slow = path.join(dir, 'slow')
  mkdirSync(slow)
  // 起きた印を残し、試験が合図のファイルを置くまで待ってから書く（swift が起きる前に期限が切れても通ってしまわないように）。
  // 書く時機を時計でなく合図にし、期限は python と pandoc が重い機械でも起きられる長さにする（1.5 秒では起きる前に切れうる。追加 43）。
  writeFileSync(path.join(slow, 'swift'), '#!/bin/sh\necho started > "$FAKE_SWIFT_OUT.started"\nwhile [ ! -e "$FAKE_SWIFT_OUT.go" ]; do sleep 0.05; done\necho late > "$FAKE_SWIFT_OUT"\n')
  chmodSync(path.join(slow, 'swift'), 0o755)
  const out = path.join(dir, 'late.json')
  const go = () => writeFileSync(`${out}.go`, '')
  // 止める処理が壊れて swift が残ると、パイプが閉じず clipDraft が返らない。試験の側の上限で落とし、残った swift も合図で終わらせる（Codex 43 必須 3）。
  let hang: NodeJS.Timeout | undefined
  const pending = clipDraft('本文', 'teams', { bin: BIN, pasteboard: PB, timeoutMs: 5000, env: { ...process.env, PATH: `${slow}:${process.env.PATH}`, FAKE_SWIFT_OUT: out } })
  try {
    const r = await Promise.race([pending, new Promise<'hang'>((res) => (hang = setTimeout(res, 30_000, 'hang')))])
    if (r === 'hang') {
      // 残った swift を合図で終わらせ、パイプが閉じて clipDraft が返るまで待ってから落とす（後片付けが合図ごと消して swift が残らないように）。
      go()
      await pending
      assert.fail('期限のあとも clip-draft が返らない（swift が残っている）')
    }
    assert.deepEqual(r, { copied: false, reason: 'clip-draft が時間内に終わりませんでした' })
    assert.equal(existsSync(`${out}.started`), true)
    // 止めていなければ、合図から 0.05 秒ほどで書く。合図を置いて 1 秒待ち、書いていないことを見る。
    go()
    await new Promise((res) => setTimeout(res, 1000))
  } finally {
    clearTimeout(hang)
    go()
  }
  assert.equal(existsSync(out), false)
})

test('コピーの書式: clip-draft が無い・失敗したときは入れたことにせず理由を返す', async () => {
  const r = await clipDraft('本文', 'teams', { bin: path.join(dir, 'missing') })
  assert.equal(r.copied, false)
  assert.ok(r.reason)
})
