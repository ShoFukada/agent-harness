import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mail, mailboxOf, type MailOrca } from './mail.ts'

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), p))
const ledger = (main: Record<string, unknown>) => {
  const root = tmp('cockpit-mail-root-')
  mkdirSync(path.join(root, '.orca'))
  writeFileSync(path.join(root, '.orca/cockpit.json'), JSON.stringify({ version: 2, workspace: { name: '社内｜ハーネス' }, main, streams: [], tasks: [], cards: [] }))
  return root
}
function fake(live: string[] = []) {
  const calls: string[][] = []
  const orca: MailOrca = {
    terminals: async () => live.map((handle) => ({ handle, tabId: 't', leafId: handle })),
    mailbox: async (root) => {
      await new Promise((r) => setTimeout(r, 20))
      live.push(`term_box${live.length + 1}`)
      calls.push(['mailbox', root])
      return live.at(-1)!
    },
    notifyRun: async (from, run, subject, body) => (calls.push(['run', from, run, subject, body]), [])
  }
  return { orca, calls }
}

test('郵便受け: 窓と cockpit-mail が同時に求めても 1 つだけ作り、控えた端末が消えていれば作り直す（R191）', async () => {
  const dir = tmp('cockpit-mail-dir-')
  const { orca, calls } = fake()
  const [a, b] = await Promise.all([mailboxOf(orca, dir, '/ws/a'), mailboxOf(orca, dir, '/ws/b')])
  assert.equal(a, b)
  assert.equal(calls.filter((c) => c[0] === 'mailbox').length, 1)
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'mailbox.json'), 'utf8')), { handle: a })
  // 別のプロセス（Orca の端末の一覧に控えの handle が無い）から見たら作り直す。
  const other = fake(['term_other'])
  assert.equal(await mailboxOf(other.orca, dir, '/ws/c'), 'term_box2')
  assert.deepEqual(other.calls, [['mailbox', '/ws/c']])
})

test('cockpit-mail: root の帳簿の main.run_id に郵便受けから送り、run_id が無ければ送らずに断る', async () => {
  const dir = tmp('cockpit-mail-dir-')
  const { orca, calls } = fake()
  const root = ledger({ agent: 'claude', terminal: '', run_id: 'run_main' })
  assert.deepEqual(await mail(orca, dir, root, '件名', '本文\n2 行目'), { run: 'run_main', from: 'term_box1', warnings: [] })
  assert.deepEqual(calls.at(-1), ['run', 'term_box1', 'run_main', '件名', '本文\n2 行目'])
  await assert.rejects(mail(orca, dir, ledger({ agent: 'claude', terminal: 'term_main' }), '件名', '本文'), /main に run_id が無い/)
  assert.equal(calls.filter((c) => c[0] === 'run').length, 1)
})

test('bin/cockpit-mail: 引数と標準入力の本文を偽の orca に渡し、結果を JSON で出す', async () => {
  const dir = tmp('cockpit-mail-bin-')
  const bin = path.join(dir, 'orca')
  // terminal list は空、terminal create は term_new、orchestration send は引数と標準入力を控える。
  writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "terminal list") echo '{"ok":true,"result":{"terminals":[]}}' ;;
  "terminal create") echo '{"ok":true,"result":{"terminal":{"handle":"term_new"}}}' ;;
  "orchestration send") printf "%s\\n" "$@" > "${dir}/args"; cat > "${dir}/stdin"; echo '{"ok":true,"result":{}}' ;;
esac
`)
  chmodSync(bin, 0o755)
  const root = ledger({ agent: 'claude', terminal: '', run_id: 'run_main' })
  const cli = path.join(import.meta.dirname, '../../../../bin/cockpit-mail')
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile(cli, [root, '--subject', '【操縦席】試し'], { env: { ...process.env, COCKPIT_ORCA: bin, COCKPIT_DIR: path.join(dir, 'app') } }, (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout)))
    child.stdin?.end('"本文"\n--to run:x')
  })
  assert.deepEqual(JSON.parse(out), { sent: true, run: 'run_main', from: 'term_new', warnings: [] })
  assert.deepEqual(readFileSync(path.join(dir, 'args'), 'utf8').trimEnd().split('\n'), ['orchestration', 'send', '--from', 'term_new', '--to', 'run:run_main', '--type', 'status', '--subject', '【操縦席】試し', '--body-file', '-', '--json'])
  assert.equal(readFileSync(path.join(dir, 'stdin'), 'utf8'), '"本文"\n--to run:x')
})
