// クリック・キーボードを操作につなぐ。パネルと窓のページが共有し、送り先（Transport）だけが違う。
import { DRAFT_FORMATS, draftFormat, FORMAT_LABEL, OTHER, UNDO_GRACE_MS, type AskAnswer, type Draft, type DraftCheck, type DraftFormat, type OpType } from './model.ts'
import { morph } from './morph.ts'
import type { AskDecideResult, AskInput, AskResult, ClipResult, CockpitView, FocusResult, NotifyResult, OpenResult, OpInput, RulingHit, TalkResult } from './protocol.ts'
import { sanitize } from './sanitize.ts'
import { byUrgency } from './state.ts'
import { CSS } from './style.ts'
import { boardsOf, chosenOption, keyOf, newUi, preface, render, SENT_LABEL, talkMessage, tighten, type Model, type Theme, type Ui, type VRow } from './view.ts'
import { askPending, boardOf, doneFold, doneOrder, renderWindow, taskOrder, todoOrder, type Tab } from './window-view.ts'

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
  /** 送る文面を宛先の書式でクリップボードに入れる（clip-draft を呼ぶ）。 */
  clip(text: string, format: DraftFormat): Promise<ClipResult>
  /** 窓から質問する（consult --ask）・質問の前に判断の記録を引く・「これで決める」・質問のタブを開く。窓だけが持つ。 */
  ask?(input: AskInput): Promise<AskResult>
  askLookup?(root: string, q: string): Promise<{ hits: RulingHit[] }>
  askDecide?(root: string, ask: string, answer: AskAnswer): Promise<AskDecideResult>
  askTab?(root: string, ask: string): Promise<OpenResult>
}
export type Feed = { views: CockpitView[]; focused?: string; unseen?: Model['unseen']; live?: number; errors?: string[] }

const THEME_KEY = 'cockpit.theme'
const SIDE_KEY = 'cockpit.side'
const narrow = () => matchMedia('(max-width:640px)').matches

/**
 * 本文をコピーしたあとの知らせ。宛先の書式で入れたときはその書式とメールの件名を添える。スレッドを開けたら、今あるボタンの名前で次の操作を案内する。
 * clip は宛先の書式で入れた結果（書式が決まらない宛先は無し）。
 */
export function copyMessage(res?: OpenResult, clip?: ClipResult & { format: DraftFormat }): string {
  const copied = clip ? `本文を${FORMAT_LABEL[clip.format]}の書式でコピー` : '本文をコピー'
  const head = !res ? `${copied}しました` : res.opened ? `${copied}し、スレッドを開きました。送ったら「${SENT_LABEL}」を押してください`
    : `${copied}しましたが、スレッドを開けませんでした${res.reason ? `: ${res.reason}` : ''}`
  return clip?.subject !== undefined ? `${head}。件名は「${clip.subject}」です（本文からは外しました）` : head
}

/**
 * 送る文面をコピーし、元のスレッドを開く。素の文字列とスレッドは呼んだその場で始める（ブラウザは操作の外のクリップボードへの書き込みを、
 * パネルは操作の外で外部のブラウザを開くのを断る）。書式の決まる宛先は、そのあと clip-draft が書式つきで上書きする。
 * clip-draft はクリップボードを空にしてから書くので、失敗すると中身が残っているか分からない。そのときは true を返し、
 * 次に押されたら plainOnly で素の文字列だけを（押した操作の中で）入れ直す。
 */
export async function copyDraft(d: Draft | undefined, t: Pick<Transport, 'openUrl' | 'clip'>, write: (text: string) => Promise<void>, say: (text: string) => void, plainOnly = false): Promise<boolean> {
  const format = d && draftFormat(d)
  const plain = write(d?.text ?? '').then(() => undefined, (e: Error) => e)
  if (plainOnly) {
    const e = await plain
    say(e ? `本文をコピーできませんでした: ${e.message}。もう一度押してください` : '本文を素の文字列でコピーしました')
    return !!e
  }
  const opening = d?.href ? t.openUrl(d.href).catch((e: Error): OpenResult => ({ opened: false, reason: e.message })) : undefined
  const plainError = await plain
  if (!d || !format) {
    say(plainError ? `本文をコピーできませんでした: ${plainError.message}。もう一度押してください` : copyMessage(await opening))
    return false
  }
  say(`本文を${FORMAT_LABEL[format]}の書式に変換しています`)
  const clip = await t.clip(d.text, format).catch((e: Error): ClipResult => ({ copied: false, reason: e.message }))
  if (!clip.copied) {
    say(`本文を${FORMAT_LABEL[format]}の書式に変換できませんでした${clip.reason ? `: ${clip.reason}` : ''}。クリップボードの中身を確認できないので、もう一度押して素の文字列でコピーしてください`)
    return true
  }
  say(copyMessage(await opening, { ...clip, format }))
  return false
}

/**
 * コピーしない理由。カードの文面を、カードの書式（見てのボタンもボタンの書式ではなくカードの書式）で検査した結果が無い・検査できない・違反がある
 * ときは、素の本文も入れない（押し直しても入れない）。書式の決まらない宛先（LINE など）は検査しない。
 */
export function copyBlock(d: Draft | undefined, check: DraftCheck | undefined): string | undefined {
  const f = d && draftFormat(d)
  if (!f) return undefined
  if (!check || check.format !== f) return '書式の確認が済んでいないので、コピーしていません。少し待ってからもう一度押してください'
  if ('error' in check) return `書式を確認できないので、コピーしていません: ${check.error}`
  if (check.violations.length) return `${FORMAT_LABEL[f]}の書式に合わない行が ${check.violations.length} 件あるので、コピーしていません。カードの「書式の確認」を担当に伝えて修正を依頼してください`
  return undefined
}

/** コピーする文面。見ての見本（追加 25）は押した宛先の書式で入れ、スレッドは開かない。送る前のコピーは draft のまま。 */
export const copyTarget = (d: Draft | undefined, format?: DraftFormat): Draft | undefined => (format && d ? { ...d, href: undefined, format } : d)

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
  try {
    const side = localStorage.getItem(SIDE_KEY)
    ui.sideOpen = side ? side === 'open' : !narrow()
  } catch {
    ui.sideOpen = true
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
  /** 窓が今描いている案件（前面の案件）。 */
  let shownRoot: string | undefined
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
      for (const k of ['queue', 'fixing', 'waiting', 'reports', 'settled'] as const) for (const r of b.d[k]) rows.set(keyOf(r), { ...r, v: b.v })
    const shown = ui.filter ? boards.filter((b) => b.root === ui.filter) : boards
    order = shown.flatMap((b) => b.d.queue.map((r) => ({ ...r, v: b.v }))).sort(byUrgency).map(keyOf)
    // 操縦席はあるが読めない案件（版 1 のまま・壊れた JSON）は、黙って外さず「見ていない」に理由つきで出す。
    const unreadable = feed.views
      .filter((v) => v.root && !v.cockpit && v.state === 'ok')
      .map((v) => ({ name: v.root!.split('/').pop() ?? v.root!, path: v.root!, why: v.errors[0] ?? '操縦席が読めません' }))
    // 窓は 1 案件だけを描き、操縦席の無いワークスペースは並べない（R39）。読めない操縦席だけ理由つきで出す。
    const m: Model = { boards, focused: feed.focused, unseen: win ? unreadable : [...(feed.unseen ?? []), ...unreadable], live: feed.live, errors: feed.errors ?? [], panel: opts.panel }
    if (win) {
      const b = boardOf(m, ui.filter)
      shownRoot = b?.root
      // 答えが控えに届いた質問は、待つ表示をやめる（送った時点より答えの節が増えた）。送った案件の控えで見る。
      for (const [k, w] of Object.entries(ui.askWait))
        if (w.ask && !w.error && (feed.views.find((v) => v.root === w.root)?.asks ?? []).some((a) => a.id === w.ask && a.answers > w.answers)) delete ui.askWait[k]
      order = ui.tab === 'done' ? doneOrder(b) : ui.tab === 'whole' ? taskOrder(b) : todoOrder(b)
      // 要対応は先頭を選んで右に詳細を常に開く。対応済みも先頭を選ぶ。
      const reports = b ? b.d.reports.map((r) => keyOf(r)) : []
      if ((ui.tab ?? 'todo') === 'todo' && !(ui.sel && (order.includes(ui.sel) || reports.includes(ui.sel)))) ui.sel = order[0] ?? reports[0]
      // 対応済みはタスクの詳細から開いた期間外のカードも選んだまま出す（今の案件のものだけ）。
      if (ui.tab === 'done' && !(ui.doneSel && (order.includes(ui.doneSel) || b?.d.settled.some((r) => keyOf(r) === ui.doneSel)))) ui.doneSel = order[0]
      // 全体は右に出しているタスクが消えたら、上から最初のタスクにする（済んだタスクは選んだまま読める）。
      if (ui.tab === 'whole' && !(ui.task && b?.d.tasks.has(ui.task))) ui.task = order[0]
    }
    return m
  }

  function draw(): void {
    const now = Date.now()
    if (ui.filter && !feed.views.some((v) => v.root === ui.filter)) ui.filter = undefined
    const html = tighten(win ? renderWindow(model(now), ui, now, svg) : render(model(now), ui, now, svg))
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
      ui.undos.push({ root: r.root, opId: op.op_id, itemId: r.card.id, rev: r.card.rev, label, title: r.card.title, to: r.owner.how === 'main' ? '窓口' : '担当', until: Date.now() + UNDO_GRACE_MS })
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

  /** clip-draft で書式つきに直している間は次のコピーを受けない（遅れて終わった前のカードの本文が、あとのカードの本文を上書きするため）。 */
  let copying = false
  /** clip-draft が失敗したカード。次に押されたら素の文字列だけを入れ直す。 */
  const plainNext = new Set<string>()
  async function copy(r: VRow, format?: DraftFormat): Promise<void> {
    if (copying) return toast('前のコピーが終わるまで待ってから押してください')
    const blocked = copyBlock(r.card.draft, r.v?.drafts?.[r.card.id])
    if (blocked) return toast(blocked)
    copying = true
    const k = format ? `${keyOf(r)}:${format}` : keyOf(r)
    try {
      const retry = await copyDraft(copyTarget(r.card.draft, format), t, (text) => navigator.clipboard.writeText(text), toast, plainNext.has(k))
      if (retry) plainNext.add(k)
      else plainNext.delete(k)
    } finally {
      copying = false
    }
  }

  async function decide(r: VRow): Promise<void> {
    const k = keyOf(r)
    const other = (ui.other[k] ?? '').trim()
    // 別の答えを開いている間は、その文だけで決める（空のままおすすめが決まらないように）。
    // 「直しを伝える」は片付けずに、本文つきの talk として渡す（カードは直し待ちになり、担当が書き換えると私の番に戻る。R115）。停止の別の回答だけは答えとして決める。
    if (ui.otherOpen[k] && r.card.kind !== 'stuck') return other ? act('talk', r, { text: other }, '直しを伝えました') : undefined
    if (ui.otherOpen[k]) return other ? act('decide', r, { option_id: OTHER, text: other }, `別の答えで決めました`) : undefined
    const id = chosenOption(r, ui)
    const o = r.card.options?.find((x) => x.id === id)
    if (o) return act('decide', r, { option_id: o.id }, `${r.card.kind === 'permit' ? '許可しました' : '決めました'}「${o.label}」`)
  }

  const LABEL: Partial<Record<OpType, string>> = { accept: '承認しました', sent: '送信済みにしました', skip: '見送りました', delegate: '許可し、以後は一任しました', ack: '既読にしました' }

  function onAct(name: string, r: VRow | undefined, el: HTMLElement): void {
    if (name === 'undo') {
      // ボタンからはその操作、u キーからは最後の操作を戻す。
      const u = el.dataset.op ? ui.undos.find((x) => x.root === el.dataset.root && String(x.opId) === el.dataset.op) : ui.undos.filter((x) => !win || x.root === shownRoot).at(-1)
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
          toast('記録の再読を依頼しました')
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
      case 'copyas': return void (DRAFT_FORMATS.includes(el.dataset.format as DraftFormat) && copy(r, el.dataset.format as DraftFormat))
      case 'copycmd': return void navigator.clipboard.writeText(r.card.manual?.command ?? '').then(() => toast('コマンドをコピーしました'), fail)
      case 'focus': return void t.focusAgent(r.agent?.terminalId ?? null, r.agent?.worktree).then((x) => toast(talkMessage(focusResult(x, r.owner.title), false)), fail)
      case 'url': return void openTarget(r.root, el)
      case 'other': {
        const k = keyOf(r)
        ui.otherOpen[k] = !ui.otherOpen[k]
        draw()
        if (ui.otherOpen[k]) app.querySelector<HTMLTextAreaElement>(`textarea[data-other="${CSS_ESC(k)}"]`)?.focus()
        return
      }
      case 'revert': return void act('revert', r, { target: Number(el.dataset.target) }, '戻すよう依頼しました')
      case 'dismiss': return void act('dismiss', r, {}, '対応済みにしました')
      case 'accept': case 'sent': case 'skip': case 'delegate': case 'ack':
        return void act(name, r, {}, r.card.kind === 'permit' && name === 'accept' ? '許可しました' : r.card.manual && name === 'sent' ? '対応済みにしました' : LABEL[name]!)
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

  const tabOf = (): Tab => (win ? ui.tab ?? 'todo' : 'todo')
  /** 今のタブで右に出しているもの（j・k の今の位置）。全体はタスクの id。 */
  const current = () => ({ todo: ui.sel, whole: ui.task, done: ui.doneSel })[tabOf()]
  /** キーで返答・協議する票。全体では開いている受信だけ（要対応で選んだまま隠れた票に返答しない）。 */
  const cardKey = () => ({ todo: ui.sel, whole: openInbox(), done: ui.doneSel })[tabOf()]
  /** 全体の「届いた連絡」に今出ている受信の票（案件が切り替わった・片付いたあとに前の票へ返答しない）。 */
  function openInbox(): string | undefined {
    const r = rows.get(ui.sel ?? '')
    return r && r.root === shownRoot && r.status === 'mine' && r.card.kind === 'inbox' ? ui.sel : undefined
  }

  /** 対応済みのカードを選ぶ。閉じた仕事の中のカードへ移ったら、その仕事を既定（開く）に戻して隠さない。 */
  function pickDone(k: string | undefined): void {
    ui.doneSel = k
    const c = k ? rows.get(k)?.card : undefined
    if (c) delete ui.open[doneFold(c)]
  }

  function select(k: string | undefined): void {
    const tb = tabOf()
    const task = tb === 'whole' && !!k && order.includes(k)
    if (tb === 'done') pickDone(k)
    else if (task) ui.task = k
    // 窓の要対応は詳細を常に開くので、押し直しても閉じない。全体の受信の票は開け閉めする。
    else ui.sel = win && tb === 'todo' ? k : ui.sel === k ? undefined : k
    draw()
    const shown = task ? `[data-task="${CSS_ESC(k)}"]` : tb === 'done' ? k && `[data-dsel="${CSS_ESC(k)}"]` : ui.sel && `[data-strip="${CSS_ESC(ui.sel)}"],[data-sel="${CSS_ESC(ui.sel)}"].cardrow`
    if (shown) app.querySelector(shown)?.scrollIntoView({ block: 'nearest' })
  }

  async function talkStream(root: string, stream: string): Promise<void> {
    if (!t.talkStream) return
    try {
      toast(talkMessage(await t.talkStream(root, stream), false))
    } catch (e) {
      fail(e)
    }
  }

  // ── 窓から質問する ──
  /** 待っている質問があるあいだだけ、経った秒を 1 秒ごとに描き直す。 */
  let askTimer: ReturnType<typeof setInterval> | undefined
  function askTick(): void {
    if (askTimer) return
    askTimer = setInterval(() => {
      if (!Object.values(ui.askWait).some((w) => !w.error)) {
        clearInterval(askTimer)
        askTimer = undefined
      }
      draw()
    }, 1000)
  }

  /** 欄の鍵（<root>#<置き場所>）から、送る案件と送る先（続きの質問 id・結ぶカードかタスク）。 */
  function askTarget(key: string): { root: string } & Pick<AskInput, 'ask' | 'card' | 'task'> {
    const root = key.slice(0, key.lastIndexOf('#'))
    const scope = key.slice(key.lastIndexOf('#') + 1)
    const [kind, id] = [scope.slice(0, scope.indexOf(':')), scope.slice(scope.indexOf(':') + 1)]
    return { root, ...(kind === 'id' ? { ask: id } : kind === 'card' ? { card: id } : kind === 'task' ? { task: id } : {}) }
  }

  /** 判断の記録を引いているあいだの欄（二度押しで写しを 2 つ立てない。Codex 中 1）。 */
  const askLooking = new Set<string>()

  /** 質問を送る。新しい質問は先に判断の記録を引き、当たれば原文を出して止める（足りなければ「それでも窓口の写しに聞く」で送る）。 */
  async function askSend(key: string, lookup: boolean): Promise<void> {
    const { root, ...target } = askTarget(key)
    // 「それでも窓口の写しに聞く」は引いた文を送る（引いたあとに書き換えた文を、引かずに送らない。Codex 2 回目 中 2）。
    const q = (lookup ? ui.askDraft[key] ?? '' : ui.askHits[key]?.q ?? ui.askDraft[key] ?? '').trim()
    const busy = (ui.askWait[key] && !ui.askWait[key]!.error) || (target.ask && askPending(ui, root, target.ask))
    if (!root || !q || !t.ask || busy || askLooking.has(key)) return
    askLooking.add(key)
    try {
      if (lookup && !target.ask && t.askLookup) {
        try {
          const { hits } = await t.askLookup(root, q)
          // 引いているあいだに欄を書き換えたら、古い文の当たりは出さず、送りもしない。
          if ((ui.askDraft[key] ?? '').trim() !== q) return
          if (hits.length) {
            ui.askHits[key] = { q, hits }
            return draw()
          }
        } catch (e) {
          // 引けなくても質問はできるので、知らせだけ出して送る。
          toast(`判断の記録を引けませんでした: ${(e as Error).message}`)
        }
      }
      delete ui.askHits[key]
      const thread = (feed.views.find((v) => v.root === root)?.asks ?? []).find((a) => a.id === target.ask)
      ui.askWait[key] = { root, at: Date.now(), q, answers: thread?.answers ?? 0, ...(target.ask && { ask: target.ask }) }
    } finally {
      askLooking.delete(key)
    }
    askTick()
    draw()
    try {
      const res = await t.ask({ root, question: q, ...target })
      const w = ui.askWait[key]
      if (!w) return
      if (!res.opened) w.error = res.reason ?? '理由が分かりません'
      else {
        w.ask = res.ask
        if (res.ask) ui.askMine[`${root}#${res.ask}`] = true
        // 送っているあいだに次の文を書いていたら残す。打っていた欄は描き直しで触らない（morph）ので、送れた文はここで消す。
        if ((ui.askDraft[key] ?? '').trim() === q) delete ui.askDraft[key]
        const ta = app.querySelector<HTMLTextAreaElement>(`textarea[data-askdraft="${CSS_ESC(key)}"]`)
        if (ta && ta.value.trim() === q) ta.value = ''
      }
    } catch (e) {
      if (ui.askWait[key]) ui.askWait[key]!.error = (e as Error).message
    }
    draw()
  }

  function onAsk(el: HTMLElement): void {
    const d = el.dataset
    const root = shownRoot
    const key = d.scope ?? ''
    switch (d.ask) {
      case 'send': return void askSend(key, true)
      case 'go': return void askSend(key, false)
      case 'open':
        ui.open[`aski:${key}`] = true
        draw()
        app.querySelector<HTMLTextAreaElement>(`textarea[data-askdraft="${CSS_ESC(key)}"]`)?.focus()
        return
      case 'clear':
        delete ui.askHits[key]
        return draw()
      case 'dismiss':
        delete ui.askWait[key]
        return draw()
      case 'more':
        ui.open[`askf:${key}`] = !ui.open[`askf:${key}`]
        draw()
        if (ui.open[`askf:${key}`]) app.querySelector<HTMLTextAreaElement>(`textarea[data-askdraft="${CSS_ESC(key)}"]`)?.focus()
        return
      case 'tab':
        if (root && d.id && t.askTab) void t.askTab(root, d.id).then((x) => toast(x.opened ? '写しの会話を前に出しました' : x.reason ?? '開けませんでした'), fail)
        return
      case 'decide':
        if (root && d.id && t.askDecide)
          void t.askDecide(root, d.id, { at: d.at ?? '', head: d.head ?? '', n: Number(d.n) }).then(
            (x) => toast(x.again ? 'この答えはもう窓口に返すよう依頼しています' : x.sent ? '窓口に返すよう依頼しました' : '記録しました'),
            fail
          )
        return
    }
  }

  /** 窓だけの操作（タブ・畳み・タスクの詳細・カードへ移る・worker の端末・仕事の担当）。扱ったら true。 */
  function onWindow(el: HTMLElement): boolean {
    const d = el.dataset
    const root = boardOf(model(Date.now()), ui.filter)?.root
    if (d.ask !== undefined) {
      onAsk(el)
      return true
    }
    if (d.side !== undefined) {
      ui.sideOpen = d.side === 'toggle' ? !ui.sideOpen : d.side === 'open'
      try {
        localStorage.setItem(SIDE_KEY, ui.sideOpen ? 'open' : 'close')
      } catch {
        // 覚えられないだけで、この窓の開閉は切り替える。
      }
    } else if (d.filter !== undefined) {
      ui.filter = d.filter || undefined
      if (narrow()) ui.sideOpen = false
    } else if (d.orca === 'open') {
      if (root) void t.focusAgent(null, root).then((x) => toast(x.focused ? `${x.how ?? '案件'}を Orca で開きました` : 'この案件は Orca にありません'), fail)
      return true
    } else if (d.orca === 'sync') {
      if (feed.views.some((v) => v.root === feed.focused && v.cockpit)) ui.filter = feed.focused
    }
    else if (d.tab !== undefined) {
      ui.tab = d.tab as Tab
      if (d.task) ui.task = d.task
    }
    else if (d.toggle !== undefined) ui.open[d.toggle] = el.getAttribute('aria-expanded') !== 'true'
    else if (d.task !== undefined) ui.task = d.task
    else if (d.jump !== undefined) {
      // 済んだカードは対応済みのタブで開く。
      if (rows.get(d.jump)?.status === 'closed') {
        ui.tab = 'done'
        pickDone(d.jump)
      } else {
        ui.tab = 'todo'
        ui.sel = d.jump
      }
    } else if (d.dsel !== undefined) pickDone(d.dsel)
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
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sel],[data-filter],[data-pane],[data-pick],[data-act],[data-url],[data-file],[data-theme],[data-tab],[data-toggle],[data-task],[data-jump],[data-dsel],[data-term],[data-talkstream],[data-ask],[data-side],[data-orca]')
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
    const root = r?.root ?? (win ? shownRoot : undefined) ?? feed.views[0]?.root
    if (root) openTarget(root, el)
  })
  app.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement
    if (d.dataset?.fold) ui.open[d.dataset.fold] = d.open
  }, true)
  app.addEventListener('input', (e) => {
    const el = e.target as HTMLTextAreaElement
    // 質問の書きかけは覚えるだけ（描き直すと打っている欄の中身を差し替えるため、描き直さない）。
    const k = el.dataset.askdraft
    if (k !== undefined) {
      ui.askDraft[k] = el.value
      // 空の欄では「送る」を押させない。描き直さずにボタンだけ切り替える（Neon 1 巡目）。
      const send = el.closest('.askin')?.querySelector<HTMLButtonElement>('button[data-ask="send"]')
      if (send) send.disabled = !el.value.trim() || !!(ui.askWait[k] && !ui.askWait[k]!.error)
    }
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
    // 狭い幅で案件の一覧を重ねているあいだは、背面の票を操作させない（Esc で一覧を閉じる）。
    if (win && narrow() && ui.sideOpen) {
      if (e.key === 'Escape') {
        ui.sideOpen = false
        draw()
      }
      return
    }
    if (e.key === 'Escape') {
      ui.sel = undefined
      ;(document.activeElement as HTMLElement | null)?.blur()
      return draw()
    }
    if (typing) return
    // 片付いた・顧客待ちの票は読み返すだけ。キーで選んだり決めたりしない。
    const ck = cardKey()
    const cur = ck ? rows.get(ck) : undefined
    const sel = cur && (cur.status === 'mine' || cur.status === 'fixing') ? cur : undefined
    if (e.key === 'j' || e.key === 'k') {
      if (!order.length) return
      const at = current()
      const i = at ? order.indexOf(at) : -1
      const n = i < 0 ? 0 : Math.min(order.length - 1, Math.max(0, i + (e.key === 'j' ? 1 : -1)))
      if (tabOf() === 'todo') ui.sel = undefined
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
    // 協議のボタンを出さない票（片付いた・顧客待ち）では、キーでも協議を始めない。
    if (e.key === 't' && cur && cur.status !== 'closed' && cur.status !== 'waiting') return void talk(cur)
    if (e.key === 'u' && ui.undos.some((x) => !win || x.root === shownRoot)) return onAct('undo', undefined, app)
  })

  return {
    receive(next: Feed): void {
      feed = next
    },
    draw,
    ui
  }
}
