// 形の版 1 の cockpit.json（items の dec・ask・rev・ack）を版 2（cards の 8 種類）に移し替える純粋な関数。
// 画面は版 2 だけを読む。移し替えの入口は window/migrate.ts。
import { VERSION, type Card, type CardKind, type Cockpit, type Link, type Option } from './model.ts'

type V1Item = {
  id: string; rev: number; kind: 'dec' | 'ask' | 'rev' | 'ack'; title: string; state: 'open' | 'done'; due?: string
  topic?: string; related?: { task: string; effect?: string }[]; why?: string; context?: Card['context']; quote?: string
  figure?: string; options?: Option[]; fallback?: string; decided?: { what: string; why?: string; task?: string }[]
  source?: string; background?: Card['background']; compare?: Card['compare']; draft?: { to: string; text: string; href?: string }
  links?: Link[]; repo?: Card['repo']; href?: string; request?: string; deliverable?: string; asked_at?: string
  resolved_by?: 'user' | 'main'; resolved_at?: string; resolved_option?: string; resolved_text?: string
}
type V1Deliverable = { id: string; label: string; href?: string; diff?: string; look_for?: string[] }
type V1Request = { id: string; at: string; title: string; quote: string; state: 'open' | 'done'; tasks?: string[]; deliverables?: V1Deliverable[] }
export type V1 = Omit<Cockpit, 'version' | 'cards' | 'requests'> & { version?: number; items: V1Item[]; requests?: V1Request[] } & Record<string, unknown>

/** v1 の項目の種類から v2 の種類へ。dec は中身で分ける（push は許す、送る文面のあるものは送る前）。 */
export function kindOf(i: V1Item): CardKind {
  if (i.kind === 'ask') return 'send'
  if (i.kind === 'rev') return 'review'
  if (i.kind === 'ack') return 'report'
  if (i.topic === 'push') return 'permit'
  if (i.draft) return 'send'
  return 'decide'
}

const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length))) as T

export function migrateItem(i: V1Item, c: V1): Card {
  const kind = kindOf(i)
  const taskIds = (i.related ?? []).map((r) => r.task)
  const stream = taskIds.map((t) => c.tasks.find((x) => x.id === t)?.stream).find((s) => s && c.streams.some((x) => x.id === s))
  const req = i.request ? c.requests?.find((r) => r.id === i.request) : undefined
  const del = req?.deliverables?.find((d) => d.id === i.deliverable)
  const links = [...(i.links ?? []), ...(i.source && /^https?:/.test(i.source) ? [{ label: '出どころ', href: i.source }] : [])]
  const card: Card = {
    id: i.id,
    // 版を 1 つ上げ、古い版に押した操作（話したい・取り消し）を新しいカードに効かせない。
    rev: i.rev + 1,
    kind,
    title: i.title,
    state: i.state,
    due: i.due,
    stream,
    tasks: taskIds,
    purpose: i.related?.find((r) => r.effect)?.effect,
    why: kind === 'report' || kind === 'review' ? undefined : i.why,
    context: i.context,
    options: i.options,
    fallback: i.fallback,
    figure: i.figure,
    compare: i.compare,
    background: i.background,
    draft: i.draft ?? (i.kind === 'ask' ? { to: '顧客', text: i.quote ?? i.why ?? i.title } : undefined),
    quote: i.kind === 'ask' && !i.draft ? undefined : i.quote,
    request: req?.quote,
    look_for: del?.look_for,
    href: del?.href ?? i.href,
    diff: del?.diff,
    target: kind === 'permit' ? i.title : undefined,
    effect: kind === 'permit' ? i.why : undefined,
    scope: kind === 'permit' ? i.topic : undefined,
    done: kind === 'report' ? (i.decided?.length ? i.decided.map((d) => defined({ what: d.what, why: d.why, task: d.task })) : [{ what: i.why ?? i.title }]) : undefined,
    links,
    repo: i.repo,
    resolved_by: i.resolved_by === 'main' ? 'owner' : i.resolved_by,
    resolved_at: i.resolved_at,
    resolved_option: i.resolved_option,
    resolved_text: i.resolved_text
  }
  if (kind === 'review' && !card.purpose && i.why) card.purpose = i.why
  return defined(card)
}

/** 版 1 の cockpit.json を版 2 にする。tasks・streams・worker の記録はそのまま写す。 */
export function migrate(v1: V1): Cockpit {
  if (v1.version === VERSION) throw new Error('すでに版 2 です')
  if (!Array.isArray(v1.items)) throw new Error('items がありません')
  const { items, requests, version: _v, summary: _s, updated_at: _u, ...rest } = v1
  return {
    ...rest,
    version: VERSION,
    requests: requests?.map(({ deliverables: _d, ...r }) => r),
    cards: items.map((i) => migrateItem(i, v1))
  } as Cockpit
}

/** cockpit.archive.json（版 1 は { items }）を版 2（{ cards }）にする。 */
export function migrateArchive(a: { items: V1Item[] }, v1: V1): { cards: Card[] } {
  return { cards: a.items.map((i) => migrateItem(i, v1)) }
}
