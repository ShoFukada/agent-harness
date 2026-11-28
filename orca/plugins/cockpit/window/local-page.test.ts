import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { localPage, PAGES_DIR } from './local-page.ts'

function pages() {
  const home = mkdtempSync(path.join(tmpdir(), 'cockpit-home-'))
  const dir = path.join(home, 'orca-pages')
  mkdirSync(path.join(dir, 'aoba', 'sub.html'), { recursive: true })
  writeFileSync(path.join(dir, 'aoba', 'plan.html'), '<h1>plan</h1>')
  writeFileSync(path.join(dir, 'aoba', 'PLAN2.HTML'), '<h1>plan</h1>')
  writeFileSync(path.join(dir, 'aoba', 'note.md'), 'x')
  writeFileSync(path.join(home, 'secret.html'), 'secret')
  symlinkSync(path.join(home, 'secret.html'), path.join(dir, 'aoba', 'leak.html'))
  return { home, dir, real: realpathSync(dir) }
}

test('~/orca-pages の下の .html は実体のパスを返す（絶対パス・file:// のどちらでも）', async () => {
  const { dir, real } = pages()
  const file = path.join(dir, 'aoba', 'plan.html')
  assert.deepEqual(await localPage(file, dir), { file: path.join(real, 'aoba', 'plan.html') })
  assert.deepEqual(await localPage(pathToFileURL(file).href, dir), { file: path.join(real, 'aoba', 'plan.html') })
  assert.deepEqual(await localPage(path.join(dir, 'aoba', 'PLAN2.HTML'), dir), { file: path.join(real, 'aoba', 'PLAN2.HTML') })
})

test('~/orca-pages の外は扱わず（ワークスペースの中のファイルとして今までどおり開く）、URL と相対パスも扱わない', async () => {
  const { home, dir } = pages()
  assert.equal(await localPage(path.join(home, 'secret.html'), dir), undefined)
  assert.equal(await localPage(`${dir}-evil/x.html`, dir), undefined, '名前が前方一致するだけのフォルダは ~/orca-pages ではない')
  assert.equal(await localPage('https://example.com/x.html', dir), undefined)
  assert.equal(await localPage('docs/x.html', dir), undefined)
})

test('~/orca-pages を指していても、.html 以外・.. を含む・シンボリックリンクで外を指す・フォルダ・無いファイルは断る', async () => {
  const { dir } = pages()
  const reason = async (p: string) => ((await localPage(p, dir)) as { reason: string }).reason
  assert.match(await reason(path.join(dir, 'aoba', 'note.md')), /\.html だけ/)
  assert.match(await reason(`${dir}/aoba/../../secret.html`), /\.\. を含む/)
  assert.match(await reason(path.join(dir, 'aoba', 'leak.html')), /外を指す/)
  assert.match(await reason(path.join(dir, 'aoba', 'sub.html')), /ファイルではありません/)
  assert.match(await reason(path.join(dir, 'aoba', 'none.html')), /見つかりません/)
})

test('置き場所の既定は ~/orca-pages で、~/ で書いたパスもそこを指す', async () => {
  assert.equal(PAGES_DIR, path.join(os.homedir(), 'orca-pages'))
  // 実際のホームには触らない。無いファイルなら「見つかりません」で、~/ を ~/orca-pages の下と読めている。
  assert.match(((await localPage('~/orca-pages/__cockpit_test_none__/x.html')) as { reason: string }).reason, /見つかりません/)
})
