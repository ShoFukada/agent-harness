import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ASK_SCREEN } from '../fixtures/demo.ts'
import { deliverAnswer, type AnswerDeps } from './answer.ts'
import { screenAsk } from './orca-state.ts'

const fake = (screens: string[][]) => {
  const calls: string[][] = []
  const deps: AnswerDeps = {
    orca: {
      screen: async () => screens.shift() ?? [],
      keys: async (t, text) => void calls.push(['keys', t, text]),
      reply: async (from, id, body) => void calls.push(['reply', from, id, body]),
      sendTo: async (from, to) => {
        calls.push(['sendTo', from, to])
        if (to === 'run:gone') throw new Error('run_not_found')
        return to.startsWith('dispatch:') ? ['Queued. Orca can\'t notify the agent right now'] : []
      }
    },
    from: async () => 'term_box',
    sleep: async () => {}
  }
  return { calls, deps }
}
const sig = screenAsk(ASK_SCREEN)!.sig
// 答えを受けて、エージェントが次に進んだ画面。
const NEXT = ['⏺ 両方やる。 まず調査', '❯ ']
const keys = { via: 'keys', terminal: 'term_w', kind: 'question', how: '地図の端末' } as const

// 使い捨ての端末で見た形: 自由入力の番号を押すと印（❯）がその行に移り、打った文はその行に出る。
const onFree = (label: string) => ASK_SCREEN.map((l) => l.replace(' ❯ 1.', '   1.').replace('   3. Type something.', ` ❯ 3. ${label}`))

test('書いた答えは、自由入力の番号で欄に移り、改行を空白にした文と Enter を送る。文と Enter の前に、同じ問いの自由入力の行にいるかを確かめる', async () => {
  const { calls, deps } = fake([ASK_SCREEN, onFree('Type something.'), onFree('両方やる。 まず調査'), NEXT])
  const r = await deliverAnswer(keys, { text: '両方やる。\nまず調査', sig }, deps)
  assert.deepEqual(r, { sent: true, text: '両方やる。\nまず調査', to: ['term_w'], key: 3 })
  assert.deepEqual(calls, [['keys', 'term_w', '3'], ['keys', 'term_w', '両方やる。 まず調査'], ['keys', 'term_w', '\r']])
  // 番号のあとに問いが閉じていたら（Esc など）、文も Enter も送らない。
  const closed = fake([ASK_SCREEN, ['❯ ']])
  assert.equal((await deliverAnswer(keys, { text: '両方やる', sig }, closed.deps)).sent, false)
  assert.deepEqual(closed.calls, [['keys', 'term_w', '3']])
})

test('送ったあとに画面を読めなければ、届いたと言わない', async () => {
  const { deps } = fake([ASK_SCREEN])
  deps.orca.screen = (async () => {
    if (!(deps as { read?: true }).read) return ((deps as { read?: true }).read = true), ASK_SCREEN
    throw new Error('timeout')
  }) as typeof deps.orca.screen
  assert.match((await deliverAnswer(keys, { choice: 1, sig }, deps) as { reason: string }).reason, /画面を読み直せず/)
})

test('送ったあとも同じ問いの画面・打った文が入力欄に残った画面・空の画面なら、届いたと言わない。自由入力に移る間に選択肢が変わったら文を送らない', async () => {
  const same = fake([ASK_SCREEN, ASK_SCREEN])
  assert.deepEqual(await deliverAnswer(keys, { choice: 1, sig }, same.deps), { sent: false, reason: '端末にキーを送りましたが、画面が変わりません。端末を開いて確かめてください' })
  const left = fake([ASK_SCREEN, onFree('Type something.'), onFree('試験'), onFree('試験')])
  assert.equal((await deliverAnswer(keys, { text: '試験', sig }, left.deps)).sent, false)
  const empty = fake([ASK_SCREEN, []])
  assert.equal((await deliverAnswer(keys, { choice: 1, sig }, empty.deps)).sent, false)
  const swapped = fake([ASK_SCREEN, onFree('Type something.').map((l) => l.replace('調査報告だけにする', '何もしない'))])
  assert.equal((await deliverAnswer(keys, { text: '試験', sig }, swapped.deps)).sent, false)
  assert.deepEqual(swapped.calls, [['keys', 'term_w', '3']])
})

test('無い番号は送らない。担当への返事は、Orca が預かっただけなら遅れて届くと添える。写しが送れなくても返事は届いたとして記録する', async () => {
  const a = fake([ASK_SCREEN])
  assert.equal((await deliverAnswer(keys, { choice: 3, sig }, a.deps)).sent, false)
  assert.deepEqual(a.calls, [])
  const b = fake([])
  const d = await deliverAnswer({ via: 'dispatch', to: 'dispatch:ctx_o', how: '担当' }, { text: 'それで進めて' }, b.deps)
  assert.deepEqual(d, { sent: true, text: 'それで進めて', to: ['dispatch:ctx_o'], note: '相手がすぐには受け取れない状態のため、Orca が預かっています。入力を受け付けると届きます' })
  const c = fake([])
  const q = await deliverAnswer({ via: 'reply', id: 'msg_1', copyTo: 'run:gone', who: 'worker（地図）', line: 'どちら？', how: 'worker と窓口' }, { text: 'A' }, c.deps)
  assert.deepEqual(q, { sent: true, text: 'A', to: ['msg_1'], note: 'worker（地図）には届けましたが、宛先への写しは送れませんでした: run_not_found' })
})
