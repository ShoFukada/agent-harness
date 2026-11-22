// 窓を前に見たときからの変化（追加 24・U13）。窓が前に出たときに、描いている案件の要対応の行とタスクの控えをブラウザに持ち、
// 次に前に出たとき、その控えより後に出た行・変わった行に「新規」「更新」の印を付け、上の帯に「HH:MM 以降 済 n・新しい要対応 n」を出す。
// 控えは帳簿にも常駐のプロセスにも書かない。見たかどうかは人と端末ごとに違う（Mac と電話で別に見る）ので、ブラウザごとに持つ。
import { COUNTED, taskSig, timeOf } from './model.ts'
import { keyOf, type Board } from './view.ts'
import type { Row, TaskView } from './state.ts'

/**
 * 1 案件の控え。at は窓が前に出た時刻。rows は要対応のタブの行（鍵 → [版, タブの要対応に数えたか, 題]）、
 * tasks はタスク（id → 済なら "1"、まだなら "0" を頭に付けた、窓に出す中身の印）。
 */
export type Snap = { at: number; rows: Record<string, [number, 0 | 1, string]>; tasks: Record<string, string> }
export type Mark = 'new' | 'upd'
export const MARK_LABEL: Record<Mark, string> = { new: '新規', upd: '更新' }
/** 控えとの違い。rows・tasks は印、done は済んだもの（カードとタスク）、fresh は新しい要対応、updated は変わった要対応の行の数。 */
export type Since = { root: string; at: number; rows: Record<string, Mark>; tasks: Record<string, Mark>; done: number; fresh: number; updated: number }

/** 要対応のタブの行（届いたは全体に出すので外す。直し待ちは入れる）。window-view.ts の todoGroups と同じ集め方。 */
const todoRows = (b: Board) => [...b.d.queue.filter((r) => r.card.kind !== 'inbox'), ...b.d.fixing]
/** タブの要対応の数に入る行（window-view.ts の renderWindow の total と同じ）。 */
const counted = (r: Row): 0 | 1 => (r.status === 'mine' && COUNTED.includes(r.card.kind) ? 1 : 0)
/** タスクの行と詳細に出る中身。taskSig（放置の検出の印）に、題・目的・状況の文を足す。 */
const taskMark = (t: TaskView) =>
  `${t.task.state === 'ok' ? 1 : 0}${JSON.stringify([taskSig(t.task), t.task.title, t.task.goal ?? '', t.task.status ?? ''])}`

export function snapOf(b: Board, at: number): Snap {
  return {
    at,
    rows: Object.fromEntries(todoRows(b).map((r) => [keyOf(r), [r.card.rev, counted(r), r.card.title]])),
    tasks: Object.fromEntries([...b.d.tasks.values()].map((t) => [t.task.id, taskMark(t)]))
  }
}

export function sinceOf(prev: Snap, b: Board): Since {
  const rows: Record<string, Mark> = {}
  let fresh = 0
  let updated = 0
  for (const r of todoRows(b)) {
    const k = keyOf(r)
    const was = prev.rows[k]
    // 修正待ちから戻った行は、行には「更新」を付け、タブの要対応に入ったので新しい要対応にも数える。
    if (counted(r) && !was?.[1]) fresh++
    if (!was) rows[k] = 'new'
    else if (was[0] !== r.card.rev || was[2] !== r.card.title) {
      rows[k] = 'upd'
      updated++
    }
  }
  // 控えで要対応だった行と、控えの時刻より後に済んだ行を数える（前に見たあとに出て済んだものも入れる）。
  // 控えで要対応だった行は、済んだ時刻が控えの時刻より前でも数える（控えが、取り込みの遅れた配信で取られたとき）。
  let done = b.d.settled.filter((r) => prev.rows[keyOf(r)] !== undefined || (!!r.when && timeOf(r.when) > prev.at)).length
  const tasks: Record<string, Mark> = {}
  for (const t of b.d.tasks.values()) {
    const was = prev.tasks[t.task.id]
    const now = taskMark(t)
    if (t.task.state === 'ok') {
      if (was === undefined || was[0] === '0') done++
    } else if (was === undefined) tasks[t.task.id] = 'new'
    else if (was !== now) tasks[t.task.id] = 'upd'
  }
  return { root: b.root, at: prev.at, rows, tasks, done, fresh, updated }
}

/** ブラウザに残した 1 案件の控え。形の違うもの・壊れたもの・ありえない時刻は捨てる（印を出さないだけ）。 */
export function parseSnap(text: string | null, now: number): Snap | undefined {
  try {
    const s = JSON.parse(text ?? 'null') as Snap | null
    const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
    if (!s || !Number.isFinite(s.at) || s.at < 0 || s.at > now + 86400_000 || !obj(s.rows) || !obj(s.tasks)) return undefined
    const rowOk = (v: unknown) => Array.isArray(v) && v.length === 3 && typeof v[0] === 'number' && (v[1] === 0 || v[1] === 1) && typeof v[2] === 'string'
    if (!Object.values(s.rows).every(rowOk) || !Object.values(s.tasks).every((v) => typeof v === 'string' && /^[01]/.test(v))) return undefined
    return s
  } catch {
    return undefined
  }
}

export type SeenStore = { get(key: string): string | null; set(key: string, value: string): void }
export const SEEN_KEY = 'cockpit.seen:'
/**
 * 配信が切れていた窓（起動直後・隠れていた）が、繋ぎ直したあとに控えを書くまでの待ち。
 * 繋ぎ直した最初の配信は、止まっていた Orca の取り込みより前の状態のことがある（server.ts の /events）。
 */
export const FRESH_WAIT_MS = 2000

/**
 * 窓が前に出ているあいだの控えの出し入れ。前に出るたびに（focus）、描いた案件ごとに 1 回だけ前の控えを読んで比べる元に固定し、
 * 前に出た時刻（あとから切り替えた案件は、描いた時刻）の今の行とタスクを次の控えとして書く。
 * 配信が切れていた窓は、繋ぎ直して新しい配信を受け、前に出てから FRESH_WAIT_MS が過ぎるまで書かない。見えたまま前に出た窓はすぐ書く。
 * 後ろに回ったら（blur）、まだ書いていない控えは書かない。比べる元は前に出るたびに読み直す（別のタブや窓が書いた新しい控えを使う）。
 */
export function seenTracker(store: SeenStore, active: boolean, now: number) {
  const base: Record<string, Snap | undefined> = {}
  /** この前面のあいだに描いた案件と、その控えの時刻。 */
  let shown = new Map<string, number>()
  let written = new Set<string>()
  let frontAt = now
  /** 配信が切れていた（起動直後・隠れていた）。fed は、切れたあとに新しい配信を受けたか。 */
  let cut = true
  let fed = false
  return {
    focus(now: number): void {
      if (active) return
      active = true
      frontAt = now
      shown = new Map()
      written = new Set()
    },
    /** hidden は窓が隠れたか（page.ts が配信を切る）。 */
    blur(hidden: boolean): void {
      active = false
      if (hidden) {
        cut = true
        fed = false
      }
    },
    /** 新しい配信を受けたら呼ぶ（繋がらないときの、前の配信の同じ一覧での描き直しでは呼ばない）。 */
    feed(): void {
      fed = true
    },
    /** 描くたびに呼ぶ。 */
    since(b: Board, now: number): Since | undefined {
      if (active && !shown.has(b.root)) {
        shown.set(b.root, shown.size ? now : frontAt)
        base[b.root] = parseSnap(store.get(SEEN_KEY + b.root), now)
      }
      if (active && cut && fed && now - frontAt >= FRESH_WAIT_MS) cut = false
      if (active && !cut && !written.has(b.root)) {
        written.add(b.root)
        try {
          store.set(SEEN_KEY + b.root, JSON.stringify(snapOf(b, shown.get(b.root)!)))
        } catch {
          // 覚えられないだけで、この窓の印は今の比べる元のまま出す。
        }
      }
      const prev = base[b.root]
      return prev ? sinceOf(prev, b) : undefined
    }
  }
}
