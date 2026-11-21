// クリック・キーボードを操作につなぐ。パネルと窓のページが共有し、送り先（Transport）だけが違う。
import { COUNTED, OTHER, UNDO_GRACE_MS, type OpType } from './model.ts'
import { morph } from './morph.ts'
import type { CockpitView, NotifyResult, OpInput, TalkResult } from './protocol.ts'
import { sanitize } from './sanitize.ts'
import { byUrgency } from './state.ts'
import { CSS } from './style.ts'
import { boardsOf, keyOf, newUi, preface, render, type Model, type Theme, type Ui, type VRow } from './view.ts'

export type Transport = {
  op(input: OpInput): Promise<{ view: CockpitView }>
  /** カードの担当を開く。cockpit.json にあるカードなら、話し中にする操作も記録する。 */
  talk(root: string, itemId: string, itemRev: number): Promise<TalkResult>
  notify(root: string): Promise<NotifyResult>
  open(root: string, path: string): Promise<{ opened: boolean }>
  openUrl(url: string): Promise<{ opened: boolean; reason?: string }>
  focusAgent(terminalId: string | null, worktree?: string): Promise<{ focused: boolean }>
}
export type Feed = { views: CockpitView[]; focused?: string; unseen?: Model['unseen']; live?: number; errors?: string[] }

const THEME_KEY = 'cockpit.theme'

export function mount(t: Transport, opts: { panel?: boolean } = {}) {
  const style = document.createElement('style')
  style.textContent = `${CSS}\nhtml,body{margin:0}`
  document.head.append(style)
  const app = document.createElement('div')
  document.body.append(app)

  let feed: Feed = { views: [] }
  const ui: Ui = newUi()
  const dark = matchMedia('(prefers-color-scheme: dark)')
  try {
    ui.theme = (localStorage.getItem(THEME_KEY) as Theme | null) ?? 'light'
  } catch {
    // 保存できない画面（パネルのサンドボックス）では明るい地のまま。
  }
  const applyTheme = () => (ui.dark = ui.theme === 'dark' || (ui.theme === 'auto' && dark.matches))
  applyTheme()
  dark.addEventListener('change', () => {
    applyTheme()
    draw()
  })

  /** 今描いている行（key → 行）。押したボタンから行を引く。 */
  let rows = new Map<string, VRow>()
  let order: string[] = []
  const svgCache = new Map<string, string>()
  const svg = (raw: string) => {
    let s = svgCache.get(raw)
    if (s === undefined) svgCache.set(raw, (s = sanitize(raw)))
    return s
  }

  function model(now: number): Model {
    const boards = boardsOf(feed.views, now)
    rows = new Map()
    for (const b of boards)
      for (const k of ['queue', 'talking', 'waiting', 'reports', 'closed'] as const) for (const r of b.d[k]) rows.set(keyOf(r), { ...r, v: b.v })
    const shown = ui.filter ? boards.filter((b) => b.root === ui.filter) : boards
    order = shown.flatMap((b) => b.d.queue.map((r) => ({ ...r, v: b.v }))).sort(byUrgency).map(keyOf)
    return { boards, focused: feed.focused, unseen: feed.unseen ?? [], live: feed.live, errors: feed.errors ?? [], panel: opts.panel }
  }

  function draw(): void {
    const now = Date.now()
    if (ui.filter && !feed.views.some((v) => v.root === ui.filter)) ui.filter = undefined
    const html = render(model(now), ui, now, svg)
    const tpl = document.createElement('template')
    tpl.innerHTML = html
    morph(app, tpl.content, document.activeElement)
  }

  // 知らせと「元に戻す」は別に持つ。次の票で別の知らせが出ても、取り消しは 10 秒残す。
  let toastTimer: ReturnType<typeof setInterval> | undefined
  function tick(): void {
    clearInterval(toastTimer)
    toastTimer = setInterval(() => {
      const now = Date.now()
      if (ui.toast && ui.toast.until <= now) ui.toast = undefined
      ui.undos = ui.undos.filter((u) => u.until > now)
      if (!ui.toast && !ui.undos.length) clearInterval(toastTimer)
      draw()
    }, 1000)
    draw()
  }
  function toast(text: string): void {
    ui.toast = { text, until: Date.now() + 5000 }
    tick()
  }

  const fail = (e: unknown) => toast(`できませんでした: ${(e as Error).message}`)

  /** 押した票を閉じ、同じ列の次の票を開く（上から順に片付けられるように）。 */
  function advance(key: string): void {
    const i = order.indexOf(key)
    const next = order.filter((k) => k !== key)[Math.max(0, i)]
    ui.sel = next
  }

  async function act(type: OpType, r: VRow, extra: Partial<OpInput> = {}, label: string): Promise<void> {
    const k = keyOf(r)
    try {
      const res = await t.op({ root: r.root, item_id: r.card.id, item_rev: r.card.rev, type, ...extra })
      const op = res.view.log.ops.at(-1)!
      delete ui.picked[k]
      delete ui.other[k]
      delete ui.otherOpen[k]
      if (type !== 'revert') advance(k)
      replace(res.view)
      ui.toast = undefined
      ui.undos.push({ root: r.root, opId: op.op_id, itemId: r.card.id, rev: r.card.rev, text: `${label}「${r.card.title}」`, until: Date.now() + UNDO_GRACE_MS })
      tick()
    } catch (e) {
      fail(e)
    }
  }

  function replace(v: CockpitView): void {
    feed = { ...feed, views: feed.views.map((x) => (x.root === v.root ? v : x)) }
    draw()
  }

  async function talk(r: VRow): Promise<void> {
    // クリックの中でコピーする（ブラウザは操作の外のクリップボードへの書き込みを断る）。
    let copied = false
    try {
      await navigator.clipboard.writeText(preface(r))
      copied = true
    } catch {
      copied = false
    }
    try {
      const res = r.agent ? { opened: (await t.focusAgent(r.agent.terminalId, r.agent.worktree)).focused, how: `${r.owner.title} の端末` } : await t.talk(r.root, r.card.id, r.card.rev)
      if (!r.agent && COUNTED.includes(r.card.kind) && r.status === 'mine') advance(keyOf(r))
      toast(`${res.opened ? `${res.how}を開きました` : `${res.how}で話してください`}。${copied ? '書き出しをコピーしたので、チャットに貼って話してください' : ''}`)
    } catch (e) {
      fail(e)
    }
  }

  async function copy(r: VRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(r.card.draft?.text ?? '')
      if (r.card.draft?.href) await t.openUrl(r.card.draft.href)
      toast(r.card.draft?.href ? '本文をコピーし、スレッドを開きました。送ったら「送った」を押してください' : '本文をコピーしました')
    } catch (e) {
      fail(e)
    }
  }

  async function decide(r: VRow): Promise<void> {
    const k = keyOf(r)
    const other = (ui.other[k] ?? '').trim()
    if (ui.otherOpen[k] && other) return act('decide', r, { option_id: OTHER, text: other }, `別の答えで決めました`)
    const id = ui.picked[k]
    const o = r.card.options?.find((x) => x.id === id)
    if (o) return act('decide', r, { option_id: o.id }, `決めました「${o.label}」`)
  }

  const LABEL: Partial<Record<OpType, string>> = { accept: '承りました', sent: '送ったと記録しました', skip: '見送りました', delegate: '許して、以後は任せました', ack: '読みました' }

  function onAct(name: string, r: VRow | undefined, el: HTMLElement): void {
    if (name === 'undo') {
      // ボタンからはその操作、u キーからは最後の操作を戻す。
      const u = el.dataset.op ? ui.undos.find((x) => x.root === el.dataset.root && String(x.opId) === el.dataset.op) : ui.undos.at(-1)
      if (!u) return
      ui.undos = ui.undos.filter((x) => x !== u)
      void t.op({ root: u.root, item_id: u.itemId, item_rev: u.rev, type: 'undo', undo_of: u.opId }).then((res) => {
        ui.sel = `${u.root}#${u.itemId}`
        replace(res.view)
        toast('元に戻しました')
      }, fail)
      return
    }
    if (name === 'notify') {
      const root = feed.views[0]?.root
      if (root) void t.notify(root).then((x) => toast(x.sent ? 'メインに届けました' : `届きませんでした: ${x.reason ?? ''}`), fail)
      return
    }
    if (!r) return
    switch (name) {
      case 'decide': return void decide(r)
      case 'talk': return void talk(r)
      case 'copy': return void copy(r)
      case 'focus': return void t.focusAgent(r.agent?.terminalId ?? null, r.agent?.worktree).then((x) => toast(x.focused ? '端末を開きました' : '端末が見つかりません'), fail)
      case 'url': return void openTarget(r.root, el)
      case 'other': {
        const k = keyOf(r)
        ui.otherOpen[k] = !ui.otherOpen[k]
        draw()
        if (ui.otherOpen[k]) app.querySelector<HTMLTextAreaElement>(`textarea[data-other="${CSS_ESC(k)}"]`)?.focus()
        return
      }
      case 'revert': return void act('revert', r, { target: Number(el.dataset.target) }, '戻すよう頼みました')
      case 'accept': case 'sent': case 'skip': case 'delegate': case 'ack':
        return void act(name, r, {}, r.card.kind === 'permit' && name === 'accept' ? '許しました' : LABEL[name]!)
    }
  }

  function openTarget(root: string, el: HTMLElement): void {
    if (el.dataset.url) void t.openUrl(el.dataset.url).then((x) => !x.opened && toast(`開けませんでした${x.reason ? `: ${x.reason}` : ''}`), fail)
    else if (el.dataset.file) void t.open(root, el.dataset.file).then((x) => !x.opened && toast('ワークスペースの中にファイルが見つかりません'), fail)
  }

  const CSS_ESC = (s: string) => (window.CSS?.escape ? window.CSS.escape(s) : s.replace(/"/g, '\\"'))
  const rowOfEl = (el: HTMLElement) => {
    const k = el.dataset.key ?? el.closest<HTMLElement>('[data-strip]')?.dataset.strip
    return k ? rows.get(k) : undefined
  }

  /** 選んだら確定のボタンに移す。題や選択肢のボタンに残ると、次の Enter がそのボタンを押して決まらないため。 */
  function pick(k: string, optionId: string): void {
    ui.picked[k] = optionId
    draw()
    app.querySelector<HTMLButtonElement>(`[data-strip="${CSS_ESC(k)}"] [data-act="decide"]`)?.focus()
  }

  function select(k: string | undefined): void {
    ui.sel = ui.sel === k ? undefined : k
    draw()
    if (ui.sel) app.querySelector(`[data-strip="${CSS_ESC(ui.sel)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  app.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sel],[data-filter],[data-pane],[data-pick],[data-act],[data-url],[data-file],[data-theme]')
    if (!el || !app.contains(el)) return
    if (el.dataset.sel !== undefined) return select(el.dataset.sel)
    if (el.dataset.pane !== undefined) {
      ui.pane = el.dataset.pane === 'side' ? 'side' : 'queue'
      return draw()
    }
    if (el.dataset.filter !== undefined) {
      ui.filter = el.dataset.filter || undefined
      return draw()
    }
    if (el.dataset.pick !== undefined) return pick(el.dataset.key!, el.dataset.pick)
    if (el.dataset.theme !== undefined) {
      ui.theme = el.dataset.theme as Theme
      try {
        localStorage.setItem(THEME_KEY, ui.theme)
      } catch {
        // 保存できなくても今の画面は切り替える。
      }
      applyTheme()
      return draw()
    }
    if (el.dataset.act !== undefined) return onAct(el.dataset.act, rowOfEl(el), el)
    const r = rowOfEl(el)
    const root = r?.root ?? feed.views[0]?.root
    if (root) openTarget(root, el)
  })
  app.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement
    if (d.dataset?.fold) ui.open[d.dataset.fold] = d.open
  }, true)
  app.addEventListener('input', (e) => {
    const el = e.target as HTMLTextAreaElement
    if (el.dataset.other) {
      ui.other[el.dataset.other] = el.value
      draw()
    }
  })

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const typing = (e.target as Element).closest?.('textarea,input')
    // ボタンやリンクの上の Enter はその操作にする（選んだあと「担当と話す」に移って Enter で決まらないように）。
    const onControl = (e.target as Element).closest?.('button,a,summary')
    if (e.key === 'Escape') {
      ui.sel = undefined
      ;(document.activeElement as HTMLElement | null)?.blur()
      return draw()
    }
    if (typing) return
    const sel = ui.sel ? rows.get(ui.sel) : undefined
    if (e.key === 'j' || e.key === 'k') {
      if (!order.length) return
      const i = ui.sel ? order.indexOf(ui.sel) : -1
      const n = i < 0 ? 0 : Math.min(order.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))
      ui.sel = undefined
      e.preventDefault()
      return select(order[n])
    }
    if (/^[1-9]$/.test(e.key) && sel?.card.options) {
      const o = sel.card.options[Number(e.key) - 1]
      if (o) pick(keyOf(sel), o.id)
      return
    }
    // 打鍵ひとつで決めない。選んでから Enter。
    if (e.key === 'Enter' && !onControl && sel && (ui.picked[keyOf(sel)] || (ui.otherOpen[keyOf(sel)] && ui.other[keyOf(sel)]?.trim()))) {
      e.preventDefault()
      return void decide(sel)
    }
    if (e.key === 't' && sel) return void talk(sel)
    if (e.key === 'u' && ui.undos.length) return onAct('undo', undefined, app)
  })

  return {
    receive(next: Feed): void {
      feed = next
    },
    draw,
    ui
  }
}
