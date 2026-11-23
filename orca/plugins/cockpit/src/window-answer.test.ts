import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newUi, type VRow } from './view.ts'
import { withAnswerActs } from './window-answer.ts'

test('選択肢のボタンは文のまま下の行の先頭に置く（$ を置換の記号として読まない。Codex 軽微）', () => {
  const r = {
    root: '/ws', status: 'mine', card: { id: '#agent:term_w', rev: 1, kind: 'stuck', title: 'x' },
    agent: { terminalId: 'term_w', stop: 'waiting', ask: { kind: 'question', text: 'x', sig: 's', choices: [{ n: 1, label: 'echo $$' }, { n: 2, label: "$' と $&" }] } }
  } as unknown as VRow
  const h = withAnswerActs(r, newUi(), '<div class="acts"><button class="btn pri" type="button" data-act="focus">端末を開く</button></div>')
  assert.match(h, /^<div class="acts"><button[^>]*data-choice="1"[^>]*>echo \$\$<\/button><button[^>]*data-choice="2"[^>]*>\$&#39; と \$&#38;<\/button><button class="btn" type="button" data-act="focus">/)
})
