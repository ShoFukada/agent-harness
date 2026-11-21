import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { appendReply } from '../src/store.ts'
import { CLI_ARGS, claudeCli } from './assistant.ts'
import { reply } from './reply.ts'

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'cockpit-reply-'))
  mkdirSync(path.join(root, '.orca'))
  const ops = [1, 2].map((op_id) => ({ op_id, at: '2026-11-16T10:00:00+09:00', item_id: 'd1', item_rev: 1, type: 'talk', text: `質問 ${op_id}` }))
  writeFileSync(path.join(root, '.orca/cockpit.user.json'), JSON.stringify({ ops }))
  return root
}

test('メインの回答と窓の回答を同時に書いても、どちらも残る', async () => {
  const root = workspace()
  await Promise.all(
    Array.from({ length: 10 }, (_, n) =>
      n % 2 ? reply(root, 1, `メイン ${n}`) : appendReply(root, { op_id: 2, at: new Date().toISOString(), by: 'assistant', text: `アシスタント ${n}` })
    )
  )
  const saved = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.talk.json'), 'utf8')).replies as { by: string; text: string }[]
  assert.equal(saved.length, 10)
  assert.deepEqual(saved.filter((r) => r.by === 'main').map((r) => r.text).sort(), ['メイン 1', 'メイン 3', 'メイン 5', 'メイン 7', 'メイン 9'])
})

test('回答の入口は、無い発言・空の本文・上限を超える本文を断る', async () => {
  const root = workspace()
  await assert.rejects(reply(root, 9, '答え'), /発言 9 が cockpit.user.json にありません/)
  await assert.rejects(reply(root, 1, '  '), /本文が空です/)
  await assert.rejects(reply(root, 1, 'あ'.repeat(4001)), /4000 字までです/)
})

test('コマンドとして呼ぶと標準入力の本文を by: main で追記する', () => {
  const root = workspace()
  const out = execFileSync(process.execPath, [new URL('./reply.ts', import.meta.url).pathname, root, '2'], { input: '件数の上限は 5 件にします\n', encoding: 'utf8' })
  assert.match(out, /追記しました: op 2/)
  const saved = JSON.parse(readFileSync(path.join(root, '.orca/cockpit.talk.json'), 'utf8')).replies
  assert.deepEqual(saved.map((r: { op_id: number; by: string; text: string }) => [r.op_id, r.by, r.text]), [[2, 'main', '件数の上限は 5 件にします']])
})

test('アシスタントの CLI は hook を止めて読むだけの道具に絞り、SIGTERM で終わらなければ SIGKILL する', async () => {
  assert.ok(CLI_ARGS.includes('{"disableAllHooks":true}'))
  assert.deepEqual(CLI_ARGS.slice(CLI_ARGS.indexOf('--tools'), CLI_ARGS.indexOf('--tools') + 2), ['--tools', 'Read,Grep,Glob'])
  // SIGTERM を無視して居座る偽の CLI。
  const dir = mkdtempSync(path.join(tmpdir(), 'cockpit-cli-'))
  const bin = path.join(dir, 'claude')
  writeFileSync(bin, `#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n`)
  chmodSync(bin, 0o755)
  const started = Date.now()
  await assert.rejects(claudeCli(bin, 200)('質問', dir), /0 秒で打ち切りました/)
  assert.ok(Date.now() - started < 8000, '猶予のあと SIGKILL で終わる')
})
