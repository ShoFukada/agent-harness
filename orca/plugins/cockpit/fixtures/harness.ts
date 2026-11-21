// テストの土台。全体の表のマスを確かめる、実際のデータの件数を写したくくり。
import { readFileSync } from 'node:fs'
import { parseCockpit, type Cockpit, type Task, type TaskState } from '../src/model.ts'

/** X からハーネスへの取り込み（実際のデータ）。調査は外部待ち 1・未着手 1・完了 5、実装は止まっている 1・完了 3。 */
export function harness(): Cockpit {
  const c = parseCockpit(readFileSync(new URL('./sample.json', import.meta.url), 'utf8'))
  const tasks = (phase: string, states: TaskState[]): Task[] =>
    states.map((state, n) => ({ id: `${phase}-${state}-${n}`, stream: 'x', phase, title: `${phase} ${n}`, state }))
  c.streams = [{ id: 'x', title: 'X からハーネスへの取り込み' }]
  c.phases = ['調査', '実装']
  c.tasks = [...tasks('調査', ['wait', 'idle', 'ok', 'ok', 'ok', 'ok', 'ok']), ...tasks('実装', ['stop', 'ok', 'ok', 'ok'])]
  // 開いている決める d1 が調査の外部待ちを指す。実装の止まっているは worker の作業待ちで、利用者の番ではない。
  c.items = c.items.map((i) => (i.id === 'd1' ? { ...i, related: [{ task: '調査-wait-0' }] } : { ...i, related: [] }))
  return c
}
