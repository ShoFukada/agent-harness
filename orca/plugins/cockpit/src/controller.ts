// クリック・キーボードを操作につなぐ。パネルと窓のページが共有し、送り先（Transport）だけが違う。
import { OTHER, UNDO_GRACE_MS, type OpType } from './model.ts'
import { morph } from './morph.ts'
import type { CockpitView, FocusResult, NotifyResult, OpenResult, OpInput, TalkResult } from './protocol.ts'
import { sanitize } from './sanitize.ts'
import { byUrgency } from './state.ts'
import { CSS } from './style.ts'
import { boardsOf, chosenOption, keyOf, newUi, preface, render, talkMessage, type Model, type Theme, type Ui, type VRow } from './view.ts'
import { boardOf, doneOrder, renderWindow, todoOrder, type Tab } from './window-view.ts'

export type Transport = {
  op(input: OpInput): Promise<{ view: CockpitView }>
  /** カードの担当を開く。cockpit.json にあるカードなら、話し中にする操作も記録する。 */
  talk(root: string, itemId: string, itemRev: number): Promise<TalkResult>
  notify(root: string): Promise<NotifyResult>
  open(root: string, path: string): Promise<OpenResult>
  openUrl(url: string): Promise<OpenResult>
  focusAgent(terminalId: string | null, worktree?: string): Promise<FocusResult>
  /** 仕事の担当（無ければ窓口）を開く。窓の全体のタブが使う。カードが無いので話し中の印は付けない。 */
  talkStream?(root: string, stream: string): Promise<TalkResult>
}
export type Feed = { views: CockpitView[]; focused?: string; unseen?: Model['unseen']; live?: number; errors?: string[] }

const THEME_KEY = 'cockpit.theme'

/** 帯の印（Orca で止まった worker）を開いた結果を、担当と話すと同じ知らせにする。 */
const focusResult = (x: FocusResult, title: string): TalkResult =>
  x.focused ? { opened: true, how: x.how === '端末' || !x.how ? `${title}の端末` : x.how } : { opened: false, how: `${title}の端末`, reason: `「${title}」の端末も worktree も Orca にありません` }

export function mount(t: Transport, opts: { panel?: boolean; window?: boolean } = {}) {
  const win = !!opts.window
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
      for (const k of ['queue', 'fixing', 'waiting', 'reports', 'closed'] as const) for (const r of b.d[k]) rows.set(keyOf(r), { ...r, v: b.v })
    const shown = ui.filter ? boards.filter((b) => b.root === ui.filter) : boards
    order = shown.flatMap((b) => b.d.queue.map((r) => ({ ...r, v: b.v }))).sort(byUrgency).map(keyOf)
    // 操縦席はあるが読めない案件（版 1 のまま・壊れた JSON）は、黙って外さず「見ていない」に理由つきで出す。
    const unreadable = feed.views
      .filter((v) => v.root && !v.cockpit && v.state === 'ok')
      .map((v) => ({ name: v.root!.split('/').pop() ?? v.root!, path: v.root!, why: v.errors[0] ?? '操縦席が読めません' }))
    // 窓は 1 案件だけを描き、操縦席の無いワークスペースは並べない（R39）。読めない操縦席だけ理由つきで出す。
    const m: Model = { boards, focused: feed.focused, unseen: win ? unreadable : [...(feed.unseen ?? []), ...unreadable], live: feed.live, errors: feed.errors ?? [], panel: opts.panel }
    if (win) {
      const b = boardOf(m)
      order = ui.tab === 'done' ? doneOrder(b) : todoOrder(b)
      // 要対応は先頭を選んで右に詳細を常に開く。対応済みも先頭を選ぶ。
      const reports = b ? b.d.reports.map((r) => keyOf(r)) : []
      if ((ui.tab ?? 'todo') === 'todo' && !(ui.sel && (order.includes(ui.sel) || reports.includes(ui.sel)))) ui.sel = order[0] ?? reports[0]
      if (ui.tab === 'done' && !(ui.doneSel && order.includes(ui.doneSel))) ui.doneSel = order[0]
    }
    return m
  }

  function draw(): void {
    const now = Date.now()
    if (ui.filter && !feed.views.some((v) => v.root === ui.filter)) ui.filter = undefined
    const html = win ? renderWindow(model(now), ui, now, svg) : render(model(now), ui, now, svg)
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
      const res: TalkResult = r.agent ? focusResult(await t.focusAgent(r.agent.terminalId, r.agent.worktree), r.owner.title) : await t.talk(r.root, r.card.id, r.card.rev)
      toast(talkMessage(res, copied))
    } catch (e) {
      fail(e)
    }
  }

  async function copy(r: VRow): Promise<void> {
    try {
      await navigator.clipboard.writeText(r.card.draft?.text ?? '')
      const res = r.card.draft?.href ? await t.openUrl(r.card.draft.href) : undefined
      toast(!res ? '本文をコピーしました'
        : res.opened ? '本文をコピーし、スレッドを開きました。送ったら「送った」を押してください'
        : `本文をコピーしましたが、スレッドを開けませんでした${res.reason ? `: ${res.reason}` : ''}`)
    } catch (e) {
      fail(e)
    }
  }

  async function decide(r: VRow): Promise<void> {
    const k = keyOf(r)
    const other = (ui.other[k] ?? '').trim()
    // 別の答えを開いている間は、その文だけで決める（空のままおすすめが決まらないように）。
    // 見ての「直してほしいこと」は片付けずに、本文つきの talk として渡す（カードは直し待ちになり、担当が書き換えると私の番に戻る）。
    if (ui.otherOpen[k] && r.card.kind === 'review') return other ? act('talk', r, { text: other }, '直しを頼みました') : undefined
    if (ui.otherOpen[k]) return other ? act('decide', r, { option_id: OTHER, text: other }, `別の答えで決めました`) : undefined
    const id = chosenOption(r, ui)
    const o = r.card.options?.find((x) => x.id === id)
    if (o) return act('decide', r, { option_id: o.id }, `${r.card.kind === 'permit' ? '許しました' : '決めました'}「${o.label}」`)
  }

  const LABEL: Partial<Record<OpType, string>> = { accept: 'これでよいと返しました', sent: '送ったと記録しました', skip: '見送りました', delegate: '許して、以後は任せました', ack: '読みました' }

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
    if (name === 'repeat') {
      const root = el.dataset.root
      if (root)
        void t.op({ root, item_id: '', item_rev: 0, type: 'repeat' }).then((res) => {
          replace(res.view)
          toast('「前にも言った」を記録しました。窓口が記録を読み直します')
        }, fail)
      return
    }
    if (name === 'unseen') {
      ui.open.unseen = !ui.open.unseen
      return draw()
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
      case 'copycmd': return void navigator.clipboard.writeText(r.card.manual?.command ?? '').then(() => toast('コマンドをコピーしました。打って終わったら「済ませた」を押してください'), fail)
      case 'focus': return void t.focusAgent(r.agent?.terminalId ?? null, r.agent?.worktree).then((x) => toast(talkMessage(focusResult(x, r.owner.title), false)), fail)
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
        return void act(name, r, {}, r.card.kind === 'permit' && name === 'accept' ? '許しました' : r.card.manual && name === 'sent' ? '済ませたと記録しました' : LABEL[name]!)
    }
  }

  function openTarget(root: string, el: HTMLElement): void {
    if (el.dataset.url) void t.openUrl(el.dataset.url).then((x) => !x.opened && toast(`開けませんでした${x.reason ? `: ${x.reason}` : ''}`), fail)
    else if (el.dataset.file) void t.open(root, el.dataset.file).then((x) => !x.opened && toast(`開けませんでした: ${x.reason ?? 'ワークスペースの中にファイルが見つかりません'}`), fail)
  }

  const CSS_ESC = (s: string) => (window.CSS?.escape ? window.CSS.escape(s) : s.replace(/"/g, '\\"'))
  const rowOfEl = (el: HTMLElement) => {
    const k = el.dataset.key ?? el.closest<HTMLElement>('[data-strip]')?.dataset.strip
    return k ? rows.get(k) : undefined
  }

  /** 選んだら確定のボタンに移す。題や選択肢のボタンに残ると、次の Enter がそのボタンを押して決まらないため。 */
  function pick(k: string, optionId: string): void {
    ui.picked[k] = optionId
    ui.otherOpen[k] = false
    draw()
    app.querySelector<HTMLButtonElement>(`[data-strip="${CSS_ESC(k)}"] [data-act="decide"]`)?.focus()
  }

  function select(k: string | undefined): void {
    if (win && ui.tab === 'done') ui.doneSel = k
    // 窓の要対応は詳細を常に開くので、押し直しても閉じない。
    else ui.sel = win && (ui.tab ?? 'todo') === 'todo' ? k : ui.sel === k ? undefined : k
    draw()
    if (ui.sel) app.querySelector(`[data-strip="${CSS_ESC(ui.sel)}"],[data-sel="${CSS_ESC(ui.sel)}"].cardrow`)?.scrollIntoView({ block: 'nearest' })
  }

  async function talkStream(root: string, stream: string): Promise<void> {
    if (!t.talkStream) return
    try {
      toast(talkMessage(await t.talkStream(root, stream), false))
    } catch (e) {
      fail(e)
    }
  }

  /** 窓だけの操作（タブ・畳み・依頼の開閉・要対応へ移る・worker の端末・仕事の担当）。扱ったら true。 */
  function onWindow(el: HTMLElement): boolean {
    const d = el.dataset
    const root = boardOf(model(Date.now()))?.root
    if (d.tab !== undefined) ui.tab = d.tab as Tab
    else if (d.toggle !== undefined) ui.open[d.toggle] = el.getAttribute('aria-expanded') !== 'true'
    else if (d.rq !== undefined) ui.rq = ui.rq === d.rq ? undefined : d.rq
    else if (d.jump !== undefined) {
      ui.tab = 'todo'
      ui.sel = d.jump
    } else if (d.dsel !== undefined) ui.doneSel = d.dsel
    else if (d.term !== undefined) {
      void t.focusAgent(d.term || null, d.wt || undefined).then((x) => toast(x.focused ? `${x.how ?? '端末'}を前に出しました` : '端末も worktree も Orca にありません'), fail)
      return true
    } else if (d.talkstream !== undefined) {
      if (root) void talkStream(root, d.talkstream)
      return true
    } else return false
    draw()
    return true
  }

  app.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sel],[data-filter],[data-pane],[data-pick],[data-act],[data-url],[data-file],[data-theme],[data-tab],[data-toggle],[data-rq],[data-jump],[data-dsel],[data-term],[data-talkstream]')
    if (!el || !app.contains(el)) return
    if (win && onWindow(el)) return
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
    // 片付いた・顧客待ちの票は読み返すだけ。キーで選んだり決めたりしない。
    const cur = ui.sel ? rows.get(ui.sel) : undefined
    const sel = cur && (cur.status === 'mine' || cur.status === 'fixing') ? cur : undefined
    if (e.key === 'j' || e.key === 'k') {
      if (!order.length) return
      const i = ui.sel ? order.indexOf(ui.sel) : -1
      const n = i < 0 ? 0 : Math.min(order.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))
      ui.sel = undefined
      e.preventDefault()
      return select(order[n])
    }
    // 手作業の票（manual）は選択肢を出さないので、数字と Enter で決めない。
    if (/^[1-9]$/.test(e.key) && sel?.card.options && !(sel.card.kind === 'permit' && sel.card.manual)) {
      const o = sel.card.options[Number(e.key) - 1]
      if (o) pick(keyOf(sel), o.id)
      return
    }
    // 打鍵ひとつで決めない。選んでから Enter。
    if (e.key === 'Enter' && !onControl && sel && (ui.picked[keyOf(sel)] || (ui.otherOpen[keyOf(sel)] && ui.other[keyOf(sel)]?.trim()))) {
      e.preventDefault()
      return void decide(sel)
    }
    if (e.key === 't' && cur) return void talk(cur)
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
