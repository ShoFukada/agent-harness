// クリック・キーボードを操作につなぐ。サイドバーのパネル（panel.ts）と窓のページ（window/page.ts）が共有する。
// 表示は view.ts、ファイルと端末は Transport の先（パネルは worker、窓は常駐のプロセス）が受け持つ。
import { chatMain, overlay, OTHER, UNDO_GRACE_MS } from './model.ts'
import type { CockpitView, NotifyResult, OpInput } from './protocol.ts'
import { sanitize } from './sanitize.ts'
import { derive } from './state.ts'
import { CSS as STYLE } from './style.ts'
import { morph } from './morph.ts'
import { navigate, restore, scrollResets } from './nav.ts'
import { archKeys, closedItems, countText, firstItem, isWebUrl, openItems, pickKey, render, sendable, streamTasks, taskStream, type Ui } from './view.ts'

export type Transport = {
  op(input: OpInput): Promise<{ view: CockpitView; notify?: NotifyResult }>
  notify(root: string): Promise<NotifyResult>
  /** ファイルを Orca で開く。path は相対パス（path:行 も可）か、同じリポジトリの worktree の中の絶対パス。 */
  open(root: string, path: string): Promise<{ opened: boolean }>
  /** http(s) の URL を既定のブラウザで開く。 */
  openUrl(url: string): Promise<{ opened: boolean; reason?: string }>
  /** worker の端末を Orca で前に出す。terminalId が空なら worktree を開く。 */
  focusAgent(terminalId: string, worktree: string): Promise<{ focused: boolean }>
}

export type Render = (v: CockpitView | null, ui: Ui, now: number, svg: (raw: string) => string) => string

export type Options = {
  render?: Render
  /** controller が扱わないボタン（窓の列など）。扱ったら true を返す。 */
  onClick?: (d: DOMStringMap) => boolean
  css?: string
}

export function mount(t: Transport, opts: Options = {}) {
  let v: CockpitView | null = null
  const ui: Ui = { tab: 'todo', pick: {}, showDone: {} }
  let toastTimer: ReturnType<typeof setTimeout> | undefined
  /** z で取り消す、この画面で最後に片付けた操作。 */
  let lastClose: { item_id: string; op_id: number } | undefined
  const paint = opts.render ?? render

  const style = document.createElement('style')
  style.textContent = STYLE + (opts.css ?? '')
  document.head.append(style)
  const app = document.createElement('div')
  app.className = 'ck'
  document.body.append(app)

  const views = () => (v?.cockpit ? overlay(v.cockpit, v.log, v.archive) : [])
  const revOf = (id: string) => views().find((x) => x.item.id === id)?.item.rev ?? 0

  let painted: string | undefined
  let shownPlace = ''
  let shownItem = ''
  function draw(): void {
    const html = paint(v, ui, Date.now(), sanitize)
    // 窓には中身の同じ更新が数秒ごとに届く。同じなら DOM に触らない。
    if (html === painted) return
    painted = html
    const active = document.activeElement
    const focused = (active as HTMLElement | null)?.dataset
    const key = focused && Object.entries(focused)[0]
    const next = document.createElement('template')
    next.innerHTML = html
    morph(app, next.content, active)
    // 要素を使い回すので、別のワークスペース・タブ・項目に移ったときだけ欄を先頭に戻す。
    const place = `${v?.root}|${ui.tab}`
    const item = `${place}|${ui.cur}|${ui.curArch}|${ui.curTask}|${ui.curReq}|${ui.curStream}`
    for (const q of scrollResets(place !== shownPlace, item !== shownItem, ui.tab)) {
      if (q === 'page') {
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0
      } else for (const e of app.querySelectorAll(q)) e.scrollTop = 0
    }
    shownPlace = place
    shownItem = item
    // フォーカスのあった要素が作り直されたときは、同じ data 属性の要素に戻す。
    if (key && active && !active.isConnected) {
      ;(app.querySelector(`[data-${key[0].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}="${CSS.escape(key[1] ?? '')}"]`) as HTMLElement | null)?.focus()
      if (key[0] === 'chatbox') focusChat()
    }
    jumpVisibility()
    markZoomable()
  }

  /** 字が注記（14px）より小さく描かれた図に、押すと拡大できる印を付ける。 */
  function markZoomable(): void {
    for (const f of app.querySelectorAll<HTMLElement>('.fig[data-w]')) {
      const small = f.clientWidth > 0 && f.clientWidth < Number(f.dataset.w) * 0.95
      f.classList.toggle('zoomable', small)
      if (small) {
        f.title = '押すと拡大（もう一度押すか Esc で閉じる）'
        f.tabIndex = 0
        f.setAttribute('role', 'button')
      }
    }
  }

  let zoom: HTMLElement | undefined
  function closeZoom(): boolean {
    if (!zoom) return false
    zoom.remove()
    zoom = undefined
    return true
  }
  function openZoom(fig: HTMLElement): void {
    closeZoom()
    zoom = document.createElement('div')
    zoom.className = 'ck figzoom'
    zoom.setAttribute('role', 'dialog')
    zoom.setAttribute('aria-label', '拡大した図（押すか Esc で閉じる）')
    zoom.innerHTML = `<div class="fzin" style="width:min(96vw, ${Number(fig.dataset.w) || 1200}px)">${fig.innerHTML}</div>`
    zoom.addEventListener('click', () => closeZoom())
    document.body.append(zoom)
  }

  /** 「背景と比較を開く」は、詳細の欄が返答の列より上に見えているときは押しても何も変わらないので隠す。 */
  function jumpVisibility(): void {
    const jump = app.querySelector<HTMLElement>('[data-jump]')
    const box = app.querySelector<HTMLElement>('#ck-more')
    if (!jump || !box) return
    const scroller = box.closest('.detail')?.getBoundingClientRect()
    const acts = jump.closest('.acts')?.getBoundingClientRect()
    const bottom = Math.min(window.innerHeight, scroller?.bottom ?? Infinity, acts?.top ?? Infinity)
    const top = box.getBoundingClientRect().top
    jump.hidden = top < bottom - 8 && top > (scroller?.top ?? 0)
  }
  app.addEventListener('scroll', jumpVisibility, true)
  window.addEventListener('resize', () => {
    jumpVisibility()
    markZoomable()
  })

  async function copy(text: string, source: HTMLElement | null): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // パネルの枠ではクリップボードの API が使えないことがある。表示している文字を選んで古い方法でコピーする。
      if (source instanceof HTMLInputElement) source.select()
      else if (source) window.getSelection()?.selectAllChildren(source)
      return document.execCommand('copy')
    }
  }

  function showToast(msg: string, undo?: { item_id: string; op_id: number }): void {
    ui.toast = { msg, undo }
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => {
      ui.toast = undefined
      draw()
    }, UNDO_GRACE_MS)
  }

  /** 操作を記録する。記録できたら true（書きかけの文は、記録できたときだけ消す）。 */
  async function op(input: Omit<OpInput, 'item_rev' | 'root'>): Promise<boolean> {
    try {
      if (!v?.root) return false
      const root = v.root
      const res = await t.op({ ...input, root, item_rev: revOf(input.item_id) })
      // 返事を待つ間に別のワークスペースへ切り替わっていたら、古い返事で表示を戻さない。
      if (v?.root !== root) return true
      receive(res.view)
      ui.notice = res.notify && !res.notify.sent ? `メインに届いていません: ${res.notify.reason ?? ''}` : undefined
      const added = v.log.ops.at(-1)
      const item = v.cockpit?.items.find((i) => i.id === input.item_id)
      if (input.type === 'talk')
        showToast(input.to_main ? (chatMain(v.cockpit) ? 'メインに渡しました。次にメインに話しかけたときに読まれます' : 'メインに渡しました。メインの作業が一区切りしたら届けます') : '送りました。アシスタントが読んでいます')
      else if (input.type === 'need_context')
        showToast(chatMain(v.cockpit) ? '判断材料をメインに頼みました。次に話しかけたときに読まれます' : '判断材料をメインに頼みました')
      else if (input.type === 'repeat') showToast('「前にも言った」を記録しました。メインが記録を読み直します')
      else if (input.type === 'revert') showToast(`「${item?.decided?.[input.target ?? -1]?.what ?? ''}」を戻すよう記録しました`)
      else if (input.type === 'undo') {
        showToast(`「${item?.title ?? ''}」を要対応に戻しました`)
        lastClose = undefined
        ui.tab = 'todo'
        ui.cur = input.item_id
      } else if (added) {
        lastClose = { item_id: input.item_id, op_id: added.op_id }
        showToast(`「${item?.title ?? ''}」を対応済みにしました`, lastClose)
      }
    } catch (e) {
      ui.notice = `記録できませんでした: ${(e as Error).message}`
      draw()
      return false
    }
    draw()
    return true
  }

  const items = () => (v?.cockpit ? openItems(v.cockpit, views()) : [])
  function current() {
    const xs = items()
    return xs.find((x) => x.item.id === ui.cur) ?? firstItem(xs)
  }

  /** 戻り先のスクロール位置を測る欄。窓は一覧・詳細・全体の欄が別々に、パネルはページごと動く。 */
  const SCROLLERS = ['.wmain', '.list', '.detail']
  function scrolls(): Record<string, number> {
    const out: Record<string, number> = { page: document.scrollingElement?.scrollTop ?? 0 }
    for (const q of SCROLLERS) out[q] = app.querySelector(q)?.scrollTop ?? 0
    return out
  }

  /** 戻り先の確認を開き、上がった時点の位置に戻す。選んだ選択肢・書きかけ・欄の開閉は項目ごとに ui に残っている。 */
  function goBack(): void {
    const at = restore(ui)
    if (!at) return
    draw()
    // draw がタブと項目の切り替えで欄を先頭に戻したあとに上書きする。
    for (const q of SCROLLERS) {
      const e = app.querySelector(q)
      if (e) e.scrollTop = at[q] ?? 0
    }
    if (document.scrollingElement) document.scrollingElement.scrollTop = at.page ?? 0
  }

  /** パネルのように一覧と詳細が縦に並ぶときは、押した項目の詳細まで送る（一覧の下に隠れて「さっと決める」ができないため）。 */
  function showDetail(): void {
    const list = app.querySelector('.split > .list')?.getBoundingClientRect()
    const detail = app.querySelector<HTMLElement>('.split > .detail')
    if (list && detail && detail.getBoundingClientRect().top >= list.bottom - 1) detail.scrollIntoView({ block: 'start' })
  }

  function decide(): void {
    const x = current()
    const o = x && x.item.options?.find((k) => k.id === ui.pick[pickKey(x.item)])
    if (!x || x.item.kind !== 'dec' || !o) return
    delete ui.pick[pickKey(x.item)]
    void op({ item_id: x.item.id, type: 'decide', option_id: o.id })
  }

  function undo(target?: { item_id: string; op_id: number }): void {
    if (!target) return
    void op({ item_id: target.item_id, type: 'undo', undo_of: target.op_id })
  }

  function later<T>(p: Promise<T>, done: (r: T) => string | undefined): void {
    void p.then(done, (e: Error) => e.message).then((notice) => {
      ui.notice = notice
      draw()
    })
  }

  app.addEventListener('click', (e) => {
    const fig = (e.target as HTMLElement).closest<HTMLElement>('.fig.zoomable')
    if (fig) return openZoom(fig)
    const b = (e.target as HTMLElement).closest('button')
    if (!b || b.disabled) return
    const d = b.dataset
    if (opts.onClick?.(d)) return draw()
    const x = current()
    if (d.more) {
      ui.more = { ...ui.more, [d.more]: !ui.more?.[d.more] }
    } else if (d.ctx) {
      ui.ctxShut = { ...ui.ctxShut, [d.ctx]: !ui.ctxShut?.[d.ctx] }
    } else if (d.jump) {
      ui.more = { ...ui.more, [d.jump]: true }
      draw()
      return app.querySelector('#ck-more')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } else if (d.href && v?.root) {
      const href = d.href
      return isWebUrl(href)
        ? later(t.openUrl(href), (r) => (r.opened ? undefined : `開けませんでした: ${href}${r.reason ? `（${r.reason}）` : ''}`))
        : later(t.open(v.root, href), (r) => (r.opened ? undefined : `開けませんでした: ${href}`))
    } else if (d.copydraft) {
      const text = v?.cockpit?.items.find((i) => i.id === d.copydraft)?.draft?.text
      if (!text) return
      return void copy(text, app.querySelector<HTMLElement>('.dtext')).then((ok) => {
        showToast(ok ? '本文をコピーしました' : 'コピーできませんでした。枠の中の文字を選んでコピーしてください')
        draw()
      })
    } else if (d.areq) ui.curArch = `req:${d.areq}`
    else if (d.keys !== undefined) ui.keys = !ui.keys
    else if (d.repeat !== undefined) return void op({ item_id: '', type: 'repeat' })
    else if (d.idle !== undefined) ui.showIdle = !ui.showIdle
    else if (d.ms !== undefined) ui.showMs = !ui.showMs
    else if (d.jump !== undefined) return app.querySelector('#ck-more')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    else if (d.done) ui.showDone[d.done] = !ui.showDone[d.done]
    else if (d.back !== undefined || d.tab || d.whole !== undefined || d.stream !== undefined || d.task || d.req || d.goto || d.goarch || d.id) {
      const r = navigate(ui, d, v?.cockpit, x?.item.id, scrolls)
      if (r === 'back') return goBack()
      if (r === 'none') return
      draw()
      if (d.id || d.goto) showDetail()
      return
    } else if (d.pick !== undefined && x) ui.pick[pickKey(x.item)] = d.pick
    else if (d.decide !== undefined) return decide()
    else if (d.approve !== undefined && x) return void op({ item_id: x.item.id, type: 'approve_ask' })
    else if (d.ack !== undefined && x) return void op({ item_id: x.item.id, type: 'ack' })
    else if (d.accept !== undefined && x) return void op({ item_id: x.item.id, type: 'accept' })
    else if (d.fix !== undefined && x) {
      ui.chat = ui.fix = x.item.id
      ui.chatDraft = { ...ui.chatDraft, [x.item.id]: fixText(x.item) }
      draw()
      return focusChat()
    } else if (d.talk) {
      ui.chat = ui.chat === d.talk ? undefined : d.talk
      if (ui.fix !== ui.chat) ui.fix = undefined
      draw()
      return focusChat()
    } else if (d.send) return send(d.send)
    else if (d.other) return sendOther(d.other)
    else if (d.needctx) {
      // 質問の欄に書きかけがあれば、何が知りたいかとして一緒に渡す。
      const id = d.needctx
      const text = ui.chat === id ? (ui.chatDraft?.[id] ?? '').trim() : ''
      return void op({ item_id: id, type: 'need_context', ...(text ? { text } : {}) }).then((ok) => {
        if (ok && text) clearDraft('chat', id)
      })
    } else if (d.handoff && d.of) return void op({ item_id: d.handoff, type: 'talk', to_main: true, handoff_of: Number(d.of) })
    else if (d.revert !== undefined && x) return void op({ item_id: x.item.id, type: 'revert', target: Number(d.revert) })
    else if (d.undo !== undefined) return undo(ui.toast?.undo)
    else if (d.reopen) return undo(closedItems(views()).find((c) => c.item.id === d.reopen)?.reopenOp)
    else if (d.notify !== undefined && v?.root)
      return later(t.notify(v.root), (r) => {
        if (r.sent) showToast('メインに合図を送りました')
        return r.sent ? undefined : `メインに届いていません: ${r.reason ?? ''}`
      })
    else if (d.agent !== undefined)
      return later(t.focusAgent(d.agent, d.wt ?? ''), (r) => (r.focused ? undefined : '端末を開けませんでした'))
    else return
    draw()
  })

  function focusChat(): void {
    const box = app.querySelector<HTMLTextAreaElement>('textarea[data-chatbox]')
    if (!box) return
    box.focus({ preventScroll: true })
    box.setSelectionRange(box.value.length, box.value.length)
    box.closest('.chatin')?.scrollIntoView({ block: 'nearest' })
  }

  function clearDraft(kind: 'chat' | 'other', id: string): void {
    if (kind === 'chat') ui.chatDraft = { ...ui.chatDraft, [id]: '' }
    else ui.otherDraft = { ...ui.otherDraft, [id]: '' }
    draw()
  }

  // 上限を超えた文は送らずに残す（切り詰めない）。記録できたときだけ欄を空にする。
  function sendOther(id: string): void {
    const raw = ui.otherDraft?.[id] ?? ''
    if (!sendable(raw)) return
    void op({ item_id: id, type: 'decide', option_id: OTHER, text: raw.trim() }).then((ok) => {
      if (ok) clearDraft('other', id)
    })
  }

  function send(id: string): void {
    const raw = ui.chatDraft?.[id] ?? ''
    if (!sendable(raw)) return
    const toMain = ui.fix === id
    void op({ item_id: id, type: 'talk', text: raw.trim(), ...(toMain ? { to_main: true } : {}) }).then((ok) => {
      if (!ok) return
      if (ui.fix === id) ui.fix = undefined
      clearDraft('chat', id)
      focusChat()
    })
  }

  app.addEventListener('input', (e) => {
    const t = e.target as HTMLElement
    if (!(t instanceof HTMLTextAreaElement)) return
    const kind = t.dataset.chatbox ? 'chat' : t.dataset.otherbox ? 'other' : undefined
    const id = t.dataset.chatbox ?? t.dataset.otherbox
    if (!kind || !id) return
    if (kind === 'chat') ui.chatDraft = { ...ui.chatDraft, [id]: t.value }
    else ui.otherDraft = { ...ui.otherDraft, [id]: t.value }
    // 描き直さずにボタンと字数だけ差し替える（描き直すと入力中の欄が作り直される）。
    const btn = app.querySelector<HTMLButtonElement>(`button[data-${kind === 'chat' ? 'send' : 'other'}="${CSS.escape(id)}"]`)
    if (btn) btn.disabled = !sendable(t.value)
    const count = app.querySelector<HTMLElement>(`[data-count="${kind}:${CSS.escape(id)}"]`)
    if (count) {
      const c = countText(t.value)
      count.textContent = c.text
      count.classList.toggle('over-limit', c.over)
    }
  })

  /** 入力欄に書く書き出し。メインが依頼と成果物を取り違えないよう、ID と名前を入れる。 */
  function fixText(i: NonNullable<ReturnType<typeof current>>['item']): string {
    const r = v?.cockpit?.requests?.find((q) => q.id === i.request)
    const d = r?.deliverables?.find((k) => k.id === i.deliverable)
    return `【操縦席】${i.request ?? i.id} / ${d?.label ?? i.title} を直したい: `
  }

  function move(ids: string[], cur: string | undefined, by: number): string | undefined {
    const k = Math.max(0, ids.indexOf(cur ?? ids[0]!))
    return ids[Math.min(ids.length - 1, Math.max(0, k + by))]
  }

  document.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (target instanceof HTMLTextAreaElement && target.dataset.chatbox && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      return send(target.dataset.chatbox)
    }
    if (target instanceof HTMLTextAreaElement && target.dataset.otherbox && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      return sendOther(target.dataset.otherbox)
    }
    if (e.key === 'Escape' && closeZoom()) return
    if (e.key === 'Enter' && target.classList.contains('zoomable')) return openZoom(target)
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || e.metaKey || e.ctrlKey || e.altKey) return
    if (e.key === 'Enter' && target.tagName === 'BUTTON') return
    const by = e.key === 'j' ? 1 : e.key === 'k' ? -1 : 0
    if (e.key === 'z') return undo(lastClose)
    if (e.key === '?') {
      ui.keys = !ui.keys
      return draw()
    }
    if (ui.tab === 'whole' && by && v?.cockpit) {
      // 大タスクの画面とタスクの詳細では、その大タスクのタスクを動く。全体の表と依頼の画面では動かない。
      const task = v.cockpit.tasks.find((t) => t.id === ui.curTask)
      const sid = task ? taskStream(v.cockpit, task) : ui.curReq ? undefined : ui.curStream
      if (sid === undefined) return
      ui.curTask = move(streamTasks(v.cockpit, ui, sid).map((t) => t.id), ui.curTask, by)
      ui.curStream = sid
    } else if (ui.tab === 'arch' && by && v?.cockpit) {
      ui.curArch = move(archKeys(v!.cockpit!, views(), derive(v!.cockpit!, v!.log, v!.archive, undefined).requests.filter((r) => r.status === 'done').map((r) => r.request)), ui.curArch, by)
    } else if (ui.tab === 'todo') {
      const x = current()
      if (by) {
        ui.cur = move(items().map((i) => i.item.id), x?.item.id, by)
        if (ui.back && ui.back.item !== ui.cur) ui.back = undefined
      }
      else if (/^[1-9]$/.test(e.key) && x?.item.kind === 'dec' && x.item.options?.[Number(e.key) - 1])
        ui.pick[pickKey(x.item)] = x.item.options[Number(e.key) - 1]!.id
      else if (e.key === 'Enter') return decide()
      else if (e.key === 'e' && x?.item.kind === 'ack') return void op({ item_id: x.item.id, type: 'ack' })
      else return
    } else return
    e.preventDefault()
    draw()
  })

  /** 別のワークスペースに移ったら、選びかけの選択肢と取り消し対象を持ち越さない。 */
  function receive(next: CockpitView): void {
    if (v && v.root !== next.root) {
      ui.tab = 'todo'
      ui.cur = ui.curArch = ui.curTask = ui.curReq = ui.curStream = ui.back = undefined
      ui.fix = ui.chat = undefined
      ui.chatDraft = {}
      ui.more = {}
      ui.ctxShut = {}
      ui.otherDraft = {}
      ui.pick = {}
      ui.toast = undefined
      ui.notice = undefined
      lastClose = undefined
    }
    v = next
  }

  // 「更新 n 分前」と、取り消しの猶予が過ぎた未通知の表示を進めるため。
  setInterval(draw, 30_000)
  draw()
  return { receive, draw }
}
