// .orca/cockpit.json（メインが書く、形の版 2）と .orca/cockpit.user.json（画面が書く操作ログ）の形と、
// その 2 つを重ねてカードの今の状態を決める純粋な関数。窓・パネル・hook が使う。

import type { DispatchFact } from './protocol.ts'

export const VERSION = 2

export type TaskState = 'stop' | 'run' | 'wait' | 'idle' | 'ok'
/**
 * カードの種類。件数に数えるのは send・decide・review・permit・stuck の 5 種類。consult（相談）は要対応に並べるが、深田さんに聞くまで数えない（R52・v40）。
 * inbox は振り分けが済むまで、report は件数に入れない。talk は版 2 の古い種類で、開いたものは読み込みで consult として扱う。
 */
export type CardKind = 'inbox' | 'send' | 'decide' | 'review' | 'permit' | 'stuck' | 'consult' | 'talk' | 'report'
export const KINDS: CardKind[] = ['inbox', 'send', 'decide', 'review', 'permit', 'stuck', 'consult', 'talk', 'report']
export const COUNTED: CardKind[] = ['stuck', 'permit', 'decide', 'send', 'review']
/** 深田さんに返事か相談を頼む種類。必須の欄を検査し、欠けていれば窓に出さない（R46-4）。 */
export const ASKING: CardKind[] = [...COUNTED, 'consult']
export const KIND_LABEL: Record<CardKind, string> = {
  inbox: '受信', send: '送信前', decide: '判断', review: '確認', permit: '許可', stuck: '停止', consult: '相談', talk: '協議中', report: '報告'
}
/** 要対応の行の先頭に出す、深田さんがすること（R115）。種類の名前ではなく動作の語にする。 */
export function actionVerb(c: Pick<Card, 'kind' | 'manual'> & { id?: string }, ask?: 'question' | 'permit'): string {
  if (c.kind === 'stuck') return ask === 'question' ? '答える' : ask === 'permit' ? '許可' : '再開'
  if (c.id?.startsWith(COWORK_ID)) return ask === 'question' ? '答える' : '確認'
  if (c.id?.startsWith(IDLE_ID)) return '確認'
  if (c.kind === 'permit' && c.manual) return '対応'
  return ACTION_VERB[c.kind]
}
const ACTION_VERB: Record<CardKind, string> = {
  inbox: '返信', send: '送る', decide: '決める', review: '承認', permit: '許可', stuck: '再開', consult: '相談', talk: '協議', report: '見る'
}

export type Milestone = { date: string; label: string }
export type Repo = string | Record<string, string>
export type DoneEntry = string | { text: string; at?: string }
export const doneText = (d: DoneEntry) => (typeof d === 'string' ? d : d.text)

export type Task = {
  id: string
  stream: string
  phase: string
  title: string
  state: TaskState
  /** wait で外の相手（顧客・他社）を待つときの相手。 */
  waiting_on?: string
  /** 確認日（YYYY-MM-DD）。その日までは放置の検出で拾わない（欄の検査と日付が来たときの扱いは追加 31）。 */
  check_on?: string
  waiting_since?: string
  goal?: string
  next?: string
  done?: DoneEntry[]
  sources?: string[]
  repo?: Repo
  /**
   * このタスクを進める担当か worker の、Orca の orchestration の Run と最初の Task（worker-start の受け取りの runId・taskId）。
   * 今の Dispatch は窓が Run の Task の続き（follow_up_of）をたどって引く。dispatch_id は版 2 の古い形で、読むが新しく書かせない。
   */
  worker?: TaskWorker
  /** 見直した判断（rulings.jsonl の id）。判断の affects に挙がったタスクは、見直したらその id を足す（9.5）。 */
  reviewed_for?: string[]
}
export type TaskWorker = { task_id: string; run_id?: string; dispatch_id?: string }
/** タスク id → 中身の印と、その印になった時刻（taskseen.json）。 */
export type TaskSeen = Record<string, { sig: string; at: string }>
/** 放置の検出で「動いた」とみなす欄。窓口が状態・工程・次・待つ相手・worker・済んだことを書き換えたら変わる。 */
export const taskSig = (t: Task) => JSON.stringify([t.state, t.phase, t.next ?? '', t.waiting_on ?? '', t.check_on ?? '', t.worker?.task_id ?? '', t.done?.length ?? 0])
/** 仕事の形（R51）。delegate: 任せる・cowork: 一緒に作る・watch: 見張る。タスクは仕事の形を引き継ぐ。 */
export type StreamForm = 'delegate' | 'cowork' | 'watch'
export const FORMS: StreamForm[] = ['cowork', 'delegate', 'watch']
export const FORM_LABEL: Record<StreamForm, string> = { delegate: '任せる', cowork: '一緒に作る', watch: '見張る' }
/** 仕事（大タスク）。担当のチャットは仕事ごとに 1 つまで。 */
export type Stream = { id: string; title: string; summary?: string; sources?: string[]; form?: StreamForm }

/**
 * 仕事の担当。仕事が終わるまで残る、話し相手のエージェント（Orca のチャットか端末）。
 * 担当が無い仕事のカードは、案件の窓口（main）と話す。
 */
export type Owner = {
  id: string
  /** 仕事の名前。サイドバーと画面にこの名前で出る。 */
  title: string
  /** 担当の仕事（streams の id）。 */
  stream?: string
  agent?: string
  /** Orca のチャットのセッション ID（orca agent list の orcaSessionId）。 */
  session?: string
  /** 担当が端末で動くときの handle（term_…）。 */
  terminal?: string
  state?: 'open' | 'done'
}

/** 連絡を拾う経路（Slack・Teams・メール）。見張りが読んだ時刻を書く。止まっていれば画面が「見ていない」と出す。 */
export type Route = { id: string; label: string; read_at?: string; error?: string; stale_minutes?: number }

/** 利用者に頼む手作業。command か steps のどちらかは書く（state.ts の checks が名指しする）。 */
export type Manual = { where?: string; command?: string; steps?: string[]; check?: string }
export type Option = { id: string; label: string; recommended?: boolean; example?: string; body?: string }
export type Link = { label: string; href: string }
export type DecisionContext = { what?: string; now?: string; how?: string; gain?: string; cost?: string }
export const CONTEXT_FIELDS: [keyof DecisionContext, string][] = [
  ['what', 'これは何か'], ['now', '今どうなっているか'], ['how', '入れるならどうするか'], ['gain', '得られること'], ['cost', '失うこと']
]

/** 送る文面を貼る先の書式。clip-draft の --to と同じ名前。 */
export type DraftFormat = 'slack' | 'teams' | 'mail'
export const DRAFT_FORMATS: DraftFormat[] = ['slack', 'teams', 'mail']
export const FORMAT_LABEL: Record<DraftFormat, string> = { slack: 'Slack', teams: 'Teams', mail: 'メール' }
export type Draft = { to: string; via?: string; text: string; href?: string; format?: DraftFormat }
/** 書式の検査（dev-standards の draft-format-lint）が返す違反の 1 件。 */
export type LintViolation = { line: number; rule: string; text: string; fix: string }
/** カードの文面を format の書式で検査した結果。error は検査の CLI を起動できなかった・出力が読めなかった理由（fail closed で扱う）。 */
export type DraftCheck = { format: DraftFormat; violations: LintViolation[] } | { format: DraftFormat; error: string }

/** 元のスレッドのホスト（そのサブドメインも）→ 書式。部分一致にすると mailchimp.com のような別のサービスをメールと取り違える。 */
const FORMAT_HOSTS: [string, DraftFormat][] = [
  ['slack.com', 'slack'], ['teams.microsoft.com', 'teams'], ['teams.live.com', 'teams'],
  ['mail.google.com', 'mail'], ['outlook.office.com', 'mail'], ['outlook.office365.com', 'mail'], ['outlook.live.com', 'mail']
]

/** 貼る先の書式。format が無ければ経路から推す。決まらなければ素の文字列で写す。 */
export const draftFormat = (d: Draft): DraftFormat | undefined => d.format ?? draftRoute(d)

/**
 * 経路（via、優先）と元のスレッドのリンク（href、補完）だけから推した宛先。format は見ない（書く道具が format と食い違うかを照合する）。
 * 推せない経路（LINE・GitHub の Issue など）は undefined。
 */
export function draftRoute(d: Pick<Draft, 'via' | 'href'>): DraftFormat | undefined {
  const via = d.via ?? ''
  if (/slack/i.test(via)) return 'slack'
  if (/teams/i.test(via)) return 'teams'
  if (/メール|mail|outlook/i.test(via)) return 'mail'
  let u: URL
  try {
    u = new URL(d.href ?? '')
  } catch {
    return undefined
  }
  if (u.protocol === 'mailto:') return 'mail'
  return FORMAT_HOSTS.find(([h]) => u.hostname === h || u.hostname.endsWith(`.${h}`))?.[1]
}

export type Card = {
  id: string
  rev: number
  kind: CardKind
  title: string
  /** open: 担当か利用者の手の中、waiting: 送ったあと顧客の返事を待つ、done: 済み。 */
  state: 'open' | 'waiting' | 'done'
  /** 出た時刻（ISO 8601）。 */
  at?: string
  /** 版 2 の頃に一部のカードが書いた出た時刻。at が無いときに使う（移し替えで at に写す）。 */
  created_at?: string
  due?: string
  /** 仕事（streams の id）。担当と、案件の今の行に結ぶ。 */
  stream?: string
  tasks?: string[]
  /** 担当（owners の id）。無ければ仕事の担当、それも無ければ窓口。 */
  owner?: string
  /** 何のため 1 行。 */
  purpose?: string

  /** inbox: 送り主・場所・時刻と、元の連絡へのリンク。 */
  from?: { who: string; via?: string; at?: string; href?: string }
  /** inbox: 聞かれていること 1 行。 */
  asked?: string
  /** inbox: 振り分け（どの担当が何を始めたか）。 */
  routed?: string
  /** inbox: 返事が要るか。 */
  reply?: 'needed' | 'none'

  /**
   * send（と、送る文面のある decide）: 宛先と本文。href は元のスレッド。
   * review: 宛先ごとの書式でコピーして貼って確かめる見本（追加 25）。format と href は見ない（押したボタンの書式で入れ、スレッドは開かない）。
   */
  draft?: Draft

  /** decide: なぜ今決めるか。 */
  why?: string
  context?: DecisionContext
  options?: Option[]
  /** 返事が無いときにどうするか。 */
  fallback?: string
  figure?: string
  compare?: { columns: string[]; rows: string[][] } | string
  background?: { text: string; quote?: string; date?: string }

  /** review: 依頼の原文。 */
  request?: string
  look_for?: string[]
  /** review: 見れば判断できる証拠（確かめた結果・変わったところ）。 */
  evidence?: string[]
  href?: string
  diff?: string

  /** permit: 許す対象（commit の範囲・送る本文・書き換える行）。 */
  target?: string
  effect?: string
  undo?: string
  /** permit: 繰り返す許可の種類（push など）。「この案件では任せる」の単位。 */
  scope?: string
  /**
   * permit: 利用者の手作業を頼むカード（darwin-rebuild switch・プラグインの承認・ログインなど）。どこで・打つコマンド・手順・窓口の確かめ方を、
   * そのまま写せる形で書く。ボタンは「済ませた」（sent の操作）と担当と話すだけにする。
   */
  manual?: Manual

  /** stuck: 止まった理由（原文）と、止まった時刻。 */
  reason?: string
  since?: string
  /** stuck: 私が答えれば進むか。 */
  answerable?: boolean
  unblock?: string

  /** consult: 論点 1 行・担当の今の考え・分かっていること・決めかねていること。 */
  issue?: string
  stance?: string
  known?: string[]
  undecided?: string[]
  /** 依頼の帳簿（requests[]）のどの依頼の確認か。request は依頼の原文で、こちらは id。 */
  request_id?: string

  /** talk（版 2）: 最後のやり取りと、次に待つもの。 */
  last?: { text: string; at?: string; by?: string }
  next?: string

  /** report: したこと。理由と戻し方つき。 */
  done?: { what: string; why?: string; undo?: string; task?: string }[]

  /** waiting: 何の返事を待ち、いつから、返事で何を再開し、いつ催促するか。 */
  awaiting?: { who: string; what: string; since: string; resumes?: string; remind_at?: string }

  links?: Link[]
  quote?: string
  repo?: Repo

  resolved_by?: 'user' | 'owner'
  resolved_at?: string
  /** 移し替え（migrate-v3）が resolved_at を操作や作った時刻から推して補った。 */
  resolved_at_inferred?: boolean
  /** 見てを、深田さんの操作（これでよい・直し・話す）が無いまま窓口が閉じた（移し替えが付ける）。対応済みに印を出す。 */
  closed_without_review?: boolean
  resolved_option?: string
  resolved_text?: string

  /** decide・review の、この版で承認を求める要素（9.2）。提案のページの「要素の一覧」はここから作る。 */
  elements?: { n: number; text: string }[]
  /** 反映し終えたカードの相談の返し（return_id）。窓口が判断の記録と帳簿に入れたら足す（設計 10.7 の 1）。 */
  from_returns?: string[]
  /** 版の違い・増えた判断で保留にした返し。相談が返し直すまで残す。 */
  held_returns?: string[]
  /** 要素ごとの行き先。task（タスクの id）・request（「r30#2」の形で依頼と済の条件の番号）・skip（やらない理由）のどれか 1 つ。 */
  element_map?: ElementMap[]
}
export type ElementMap = { n: number; task?: string; request?: string; skip?: string }
/** 行き先（element_map）の無い要素の番号。 */
export const unmappedElements = (c: Pick<Card, 'elements' | 'element_map'>) =>
  (c.elements ?? []).map((e) => e.n).filter((n) => !(c.element_map ?? []).some((m) => m.n === n))

export type RequestKind = 'work' | 'question' | 'decide' | 'send'
export const REQUEST_KINDS: RequestKind[] = ['work', 'question', 'decide', 'send']
export type EvidenceKind = 'commit' | 'pr' | 'url' | 'answer' | 'op' | 'post'
export const EVIDENCE_KINDS: EvidenceKind[] = ['commit', 'pr', 'url', 'answer', 'op', 'post']
/**
 * 済の条件（done_when の番号、0 始まり）を満たした証拠。op は「これでよい」「送った」などの操作で、どのカードのどの版に押したかを持つ。
 * post は見張りが読み取った相手のスレッドへの投稿の URL（送るの済。読み取る仕組みは版 3 ではまだ無い）。
 */
export type Evidence = { /** 済の条件の番号（1 始まり）。 */ when: number; kind: EvidenceKind; ref: string; card?: string; rev?: number }
/**
 * 依頼の帳簿の 1 行。state は版 2 の古い行だけが持つ（新しい行の状態は state.ts が証拠から決める）。legacy は移し替えの時点にあった行の印で、
 * 発言と済の条件を検査しない。deliverables は版 1 から写した成果物の記録で、画面は読まない。
 */
export type Request = {
  id: string; at: string; title: string; quote?: string; state?: 'open' | 'done'; tasks?: string[]; deliverables?: unknown[]
  utterances?: { id: string; quote: string }[]
  kind?: RequestKind
  done_when?: string[]
  evidence?: Evidence[]
  check?: boolean
  legacy?: boolean
  /** 発言の記録（utterances.jsonl）で結べない依頼・窓口の約束の出典（9.1）。utterances か source のどちらかが要る。 */
  source?: { session?: string; at: string; quote: string }
  /** 台帳の行の id（照合と再生のため）。 */
  ledger?: string[]
  /** カードの相談の返しから起こした依頼なら、その return_id。 */
  from_return?: string
}
/** 発言の仕分けの位置（utterances.jsonl の id）。through までの発言は、依頼に結んだか none に入れてある。 */
export type Intake = { through?: string; none?: string[]; checked_through?: string }
/** .orca/cockpit/rulings.jsonl の 1 行のうち、窓が読む欄。affects は範囲を変える判断で見直すタスク（9.5）。 */
export type Ruling = {
  id: string; affects?: string[]; from_return?: string
  at?: string; kind?: string; text?: string; quote?: string; dec?: string; supersedes?: string[]
}
/**
 * カードの相談が窓口に返したもの（相談のメモの「## 窓口に返したもの」の節の ```json の塊）。窓は読むだけで、反映は窓口が書く道具で行う。
 * card は塊に無ければメモのファイル名。
 */
export type ConsultReturn = {
  return_id: string; card?: unknown; rev?: number; choice?: string | null
  decisions?: { text?: string; quote?: string; utterance?: string }[]; requests?: { quote?: string; utterance?: string }[]; open?: string[]
}
/** 返しの照合に使う、帳簿と移したカードの生の欄（画面の形の検査で外したカードも含める。compaction-keep.py の ledger_cards と同じ）。 */
export type ReturnMark = { id: unknown; from_returns?: unknown[]; held_returns?: unknown[] }
/** 相談のメモ（<root>/.orca/consult/<カード id>.md）。path は絶対パス。 */
export type ConsultMemo = { card: string; path: string; returns: ConsultReturn[] }
export const ASK_ID = /^ask\d+$/
/** 「これで決める」の op の item_id（#ask:<質問 id>）。orchestration の question の行（#ask:msg_…）とは id の形で分ける。 */
export const askItem = (id: string) => `#ask:${id}`
export const isAskItem = (id: string) => /^#ask:ask\d+$/.test(id)
/** 帳簿の asks[] の 1 行（窓口が返しを反映したら書く。cockpit skill の schema.md）。 */
export type AskRecord = {
  id: string; card?: string; task?: string; memo?: string
  from_returns?: string[]; held_returns?: string[]
  notify?: { return_id: string; task?: string; message_id?: string }[]
}
/** 返しの照合に使う、帳簿と移したものの生の asks[]（compaction-keep.py の ledger_asks と同じく、id が文字列の行だけ）。 */
export type AskMark = { id: string; from_returns?: unknown; held_returns?: unknown; notify?: unknown }
export type AskReturn = { return_id: string; op?: unknown; decisions?: { text?: string; utterance?: string }[]; requests?: { utterance?: string }[] }
/** 質問と答えの控え（ask-<id>.md）の節。q: 深田さんの質問、a: 答え、n: 窓・窓口からの知らせ。time は HH:MM。 */
export type AskEntry = { kind: 'q' | 'a' | 'n'; time: string; text: string; utterance?: string }
/** 窓からの質問 1 つ。path・returnsPath は絶対パス。at は写した窓口の会話の時点（「22:40」）。 */
export type AskThread = {
  id: string; path: string; returnsPath: string; card?: string; task?: string; at?: string
  entries: AskEntry[]; returns: AskReturn[]
  answers: number
  decide?: AskAnswer
}
/** どの答えで決めたか。n は控えの中の答えの通番（同じ分・同じ書き出しの別の答えと分ける）、head は読むための頭 80 字。 */
export type AskAnswer = { at: string; head: string; n: number }

export function answerParts(text: string): { at?: string; body: string } {
  const lines = text.split('\n')
  const at = /^\s*窓口の会話\s*(.+?)\s*時点/.exec(lines[0] ?? '')?.[1]
  const rest = (at ? lines.slice(1) : lines).join('\n')
  const cut = rest.search(/^【窓口への返し】/m)
  return { ...(at && { at }), body: (cut >= 0 ? rest.slice(0, cut) : rest).replace(/\*\*(.+?)\*\*/g, '$1').trim() }
}
export const answerHead = (text: string) => answerParts(text).body.replace(/\s+/g, ' ').slice(0, 80)
export function latestAnswer(entries: AskEntry[]): AskAnswer | undefined {
  const lastQ = entries.findLastIndex((e) => e.kind === 'q')
  const a = entries.slice(lastQ + 1).findLast((e) => e.kind === 'a')
  return a && { at: a.time, head: answerHead(a.text), n: entries.filter((e) => e.kind === 'a').length }
}
export const unanswered = (entries: AskEntry[]) => entries.filter((e) => e.kind !== 'n').at(-1)?.kind === 'q'
/** 窓から送る質問の中の、控えの節の見出しと同じ形の行（貼ったログの例など）を 1 字下げる。hook は本文をそのまま控えに書くため（Codex 2 回目 重大 1）。 */
export const escapeAskSections = (q: string) => q.replace(/^(?=### (?:質問|答え|知らせ) \d{1,2}:\d{2})/gm, ' ')
/** .orca/cockpit/utterances.jsonl の 1 行（hook が書く）。id の無い古い行は仕分けの検査に入れない。 */
export type Utterance = { id?: string; at: string; prompt?: string }

export type Cockpit = {
  version: 2
  workspace: { name: string; milestones?: Milestone[] }
  /** 窓口。run_id は窓口の orchestration の Run（カードの相談と窓からの質問の返しの宛先）。main の無かった帳簿に Run だけを書くと run_id だけになる。 */
  main?: { agent?: string; terminal?: string; run_id?: string }
  phases?: string[]
  streams: Stream[]
  tasks: Task[]
  owners?: Owner[]
  routes?: Route[]
  cards: Card[]
  requests?: Request[]
  intake?: Intake
  notes_ref?: string
  applied_ops?: number[]
  asks?: AskRecord[]
}

/**
 * talk に text があれば、見ての「直してほしいことを書く」で書いた直しの指示（原文）。カードは話し中（直し待ち）になる。
 * 利用者の操作。decide は選択肢（option_id）か別の答え（option_id "other" と text）、accept は見ての「これでよい」、
 * sent は送った・済ませた、skip は送らない・返事は要らない・止める、delegate は「この案件では任せる」（許したうえで以後を任せる）、
 * talk は担当と話し始めた（カードは話し中になる）、ack は報告を読んだ、revert は報告の n 番目を戻して、undo は取り消し。
 */
/** repeat: 「前にも言った」。前に伝えたことをメインが落としたという合図で、item_id は空。メイン側の hook が押下を数え、新しいチャットへの引き継ぎに使う。 */
/**
 * dismiss: Orca から作った詰まり（item_id は「#agent:…」「#dispatch:…」「#ask:…」、item_rev は止まった時刻の ms）の「済ませた」。
 * 帳簿に無い行への返答で、窓口が反映するものは無い（未反映の操作に数えない）。同じ失敗のあいだだけその行を出さない。
 */
/**
 * ask_decide: 窓からの質問の「これで決める」。item_id は #ask:<質問 id>、item_rev は 0、answer はどの答えか。窓口はこの op だけでは何もせず、
 * op にこの op_id を持つ返しが届いたら反映し、同じ書き込みで applied_ops に足す（cockpit skill の ops.md）。
 */
export type OpType = 'decide' | 'accept' | 'sent' | 'skip' | 'delegate' | 'talk' | 'ack' | 'revert' | 'undo' | 'repeat' | 'dismiss' | 'ask_decide'
export const OP_TYPES: OpType[] = ['decide', 'accept', 'sent', 'skip', 'delegate', 'talk', 'ack', 'revert', 'undo', 'repeat', 'dismiss', 'ask_decide']
/** 一緒に作る仕事の行の id の頭（R145）。帳簿のカードではなく、担当のチャットの Orca の様子から作る（state.ts の coworkRows）。 */
export const COWORK_ID = '#cowork:'
/** 線を越えて動いていないタスクの行の id の頭（追加 35）。 */
export const IDLE_ID = '#idle:'
/** Orca から作った詰まりの行の id（帳簿に無い）。 */
export const isSynthetic = (id: string) => id.startsWith('#agent:') || id.startsWith('#dispatch:') || id.startsWith('#ask:')
/** 「済ませた」で隠せる詰まり。版（止まった時刻）が取れないもの（0）は、次の停止と見分けられないので隠させない。 */
export const dismissable = (c: Pick<Card, 'id' | 'rev'>) => isSynthetic(c.id) && c.rev > 0
export type Op = {
  op_id: number
  at: string
  item_id: string
  item_rev: number
  type: OpType
  option_id?: string
  undo_of?: number
  target?: number
  text?: string
  /** talk: 窓が立てた（前に出した）カードの相談のタブの端末の handle。タブが Orca から消えたら話し中の印を外す。 */
  terminal?: string
  answer?: AskAnswer
}
export type UserLog = { ops: Op[] }
export type Archive = { cards: Card[] }
/** .orca/cockpit/handoff.json。メイン側の hook が、メインを新しいチャットに引き継いだときに書く。 */
export type Handoff = { at: string; reason: string }
export function parseHandoff(text: string): Handoff | undefined {
  const v = JSON.parse(text) as Partial<Handoff>
  return typeof v?.at === 'string' && typeof v.reason === 'string' ? { at: v.at, reason: v.reason } : undefined
}

export const OTHER = 'other'
export const TEXT_MAX = 4000
export const UNDO_GRACE_MS = 10_000
/** 工程の段。どの仕事も同じ 5 段で並べる（R82）。名前は業務の漢語（R135）。帳簿の phase は自由な名前のまま、読むときに段へ寄せる。 */
export const STAGES = ['調査', '決定', '作成', '確認', '反映'] as const
export type Stage = (typeof STAGES)[number]
/** 読み替えの元。帳簿は前の和語の名前（調べる・決める・作る・確かめる・入れる）で書かれていることがあるので、書き換えなくても同じ段に寄せる。 */
const STAGE_NAMES: Record<Stage, string[]> = {
  調査: ['調査', '調べる'],
  決定: ['決定', '決める', '要件', '設計'],
  作成: ['作成', '作る', '実装', '2 周目（Neon）'],
  確認: ['確認', '確かめる', '確かめ', '実地確認', '見てもらう', '見直し'],
  反映: ['反映', '入れる', 'push', 'switch 待ち']
}
/** 帳簿の phase の段。対応に無い名前は undefined（推測でどこかの段に入れない）。 */
export const stageOf = (phase: string): Stage | undefined => STAGES.find((s) => STAGE_NAMES[s].includes(phase))

/** 利用者が書いた文の検証。切り詰めずに断る（末尾の条件が落ちた文を決定として扱わないため）。 */
export function textError(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  if (typeof text !== 'string') return '文の形が違います'
  if (text.length > TEXT_MAX) return `${TEXT_MAX} 字までです（今 ${text.length} 字）。分けて送ってください`
  return undefined
}

/** メインが Orca のチャットで動いていて、合図を送る端末が無い。 */
export const chatMain = (c: Cockpit | undefined) => !c?.main?.terminal

export const TASK_STATES: TaskState[] = ['stop', 'run', 'wait', 'idle', 'ok']
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

type Shape = (v: unknown) => boolean
const str: Shape = (v) => typeof v === 'string'
const strs: Shape = (v) => Array.isArray(v) && v.every(str)
/** オブジェクトで、need の欄が文字列、opt の欄が無いか文字列。 */
const obj = (need: string[], opt: string[] = []): Shape => (v) =>
  isObj(v) && need.every((k) => str(v[k])) && opt.every((k) => v[k] === undefined || str(v[k]))
const list = (one: Shape): Shape => (v) => Array.isArray(v) && v.every(one)
/** カードの相談の返しの id（<カード id>-<連番>）。連番の数字は compaction-keep.py（python の \d）と同じく Unicode の十進数字を受ける。 */
export const RETURN_ID = /^[A-Za-z0-9_]+-\p{Nd}+$/u
export const returnId: Shape = (v) => str(v) && RETURN_ID.test(v as string)
/** 画面と状態の計算が読むカードの欄の形。種類・状態・id は parseCockpit が先に断る。 */
export const CARD_SHAPE: Record<string, Shape> = {
  ...Object.fromEntries(['at', 'created_at', 'due', 'stream', 'owner', 'purpose', 'asked', 'routed', 'why', 'fallback', 'figure', 'request', 'request_id', 'href', 'diff', 'target', 'effect', 'undo',
    'scope', 'reason', 'since', 'unblock', 'next', 'quote', 'issue', 'stance', 'resolved_at', 'resolved_option', 'resolved_text'].map((k) => [k, str])),
  reply: (v) => v === 'needed' || v === 'none',
  resolved_at_inferred: (v) => typeof v === 'boolean', closed_without_review: (v) => typeof v === 'boolean',
  resolved_by: (v) => v === 'user' || v === 'owner',
  answerable: (v) => typeof v === 'boolean',
  manual: (v) => obj([], ['where', 'command', 'check'])(v) && ((v as Manual).steps === undefined || strs((v as Manual).steps)),
  tasks: strs, look_for: strs, evidence: strs, known: strs, undecided: strs,
  // 返しの照合は python と同じく配列の値をそのまま使う（1 つの書き間違いで欄ごと落とさない）。書く道具は形を別に確かめる。
  from_returns: Array.isArray, held_returns: Array.isArray,
  from: obj(['who'], ['via', 'at', 'href']),
  draft: (v) => obj(['to', 'text'], ['via', 'href'])(v) && ((v as Draft).format === undefined || DRAFT_FORMATS.includes((v as Draft).format!)),
  context: obj([], CONTEXT_FIELDS.map(([k]) => k)),
  options: list((v) => obj(['id', 'label'], ['example', 'body'])(v) && ((v as { recommended?: unknown }).recommended === undefined || typeof (v as { recommended?: unknown }).recommended === 'boolean')),
  compare: (v) => str(v) || (isObj(v) && strs(v.columns) && list(strs)(v.rows)),
  background: obj(['text'], ['quote', 'date']),
  last: obj(['text'], ['at', 'by']),
  done: list(obj(['what'], ['why', 'undo', 'task'])),
  awaiting: obj(['who', 'what', 'since'], ['resumes', 'remind_at']),
  links: list(obj(['label', 'href'])),
  elements: list((v) => isObj(v) && Number.isInteger(v.n) && str(v.text)),
  element_map: list((v) => isObj(v) && Number.isInteger(v.n) && ['task', 'request', 'skip'].filter((k) => v[k] !== undefined).length === 1 && ['task', 'request', 'skip'].every((k) => v[k] === undefined || str(v[k]))),
  repo: (v) => str(v) || (isObj(v) && Object.values(v).every(str))
}

/** 形の違う欄の名前（書く道具は書く前に断り、読み込みは外して名指しする）。 */
export function badFields(c: Card): string[] {
  const rec = c as unknown as Record<string, unknown>
  return Object.keys(CARD_SHAPE).filter((k) => rec[k] !== undefined && rec[k] !== null && !CARD_SHAPE[k]!(rec[k]))
}

/**
 * 形の違う欄を外し、外したことを 1 行ずつ返す。カードは窓口（エージェント）が書くので、1 枚の欄の書き間違い（evidence を文字列で書くなど）で
 * 窓全体の描画を止めず、そのカードを名指しして欄を出さずに表示する（2026-11-21 に v88・v89 の evidence で見てのカードが押せなくなった）。
 */
export function dropBadFields(cards: Card[], where: string): string[] {
  const out: string[] = []
  for (const c of cards) {
    const rec = c as unknown as Record<string, unknown>
    const bad = badFields(c)
    for (const k of Object.keys(CARD_SHAPE)) if (rec[k] === null) delete rec[k]
    // 手作業の頼みは、形が違っても「済ませた」で返す票のままにする（消すと許す・任せるが押せてしまう）。正しい下の欄だけを残す。
    const m = rec.manual
    for (const k of bad) delete rec[k]
    if (bad.includes('manual'))
      rec.manual = isObj(m) ? Object.fromEntries(Object.entries(m).filter(([k, x]) => (k === 'steps' ? strs(x) : ['where', 'command', 'check'].includes(k) && str(x)))) : {}
    if (bad.length) out.push(`${where}のカード ${c.id}「${c.title}」の ${bad.join('・')} の形が違うので、その欄を出さずに表示しています`)
  }
  return out
}

/**
 * 版 2 の古い形を版 3 の読み方にそろえる（読み込みと移し替え migrate-v3 が同じ規則を使う）。
 * 開いた talk は consult にし、論点に次に待つもの、担当の考えに最後のやり取りを写す。at が無ければ created_at を写す。
 */
export function upgradeCard(c: Card): Card {
  if (c.kind === 'talk' && c.state !== 'done') {
    c.kind = 'consult'
    c.issue ??= c.next ?? c.title
    if (c.last?.text) c.stance ??= c.last.text
  }
  if (!c.at && c.created_at) c.at = c.created_at
  return c
}

/** タスクの省略できる欄の形（id・title・phase・state・worker は parseCockpit が先に断る）。 */
export const TASK_SHAPE: Record<string, Shape> = {
  stream: str, next: str, goal: str, waiting_on: str, waiting_since: str, sources: strs, reviewed_for: strs,
  done: list((d) => str(d) || obj(['text'], ['at'])(d)),
  repo: (v) => str(v) || (isObj(v) && Object.values(v).every(str))
}
/** 時刻の文字列を比べられる数にする。操作の UTC（Z）と窓口が書いた +09:00 が混ざるので、文字列のまま比べない。読めなければ 0。 */
export const timeOf = (s: string | undefined): number => {
  const t = Date.parse(s ?? '')
  return Number.isNaN(t) ? 0 : t
}

/** orchestration の Run の id（run_ で始まる）。 */
export const RUN_ID = (v: unknown): v is string => typeof v === 'string' && /^run_\S+$/.test(v)
export const WORKER_SHAPE: Shape = (w) => isObj(w) && str(w.task_id) && (str(w.run_id) || str(w.dispatch_id)) && [w.run_id, w.dispatch_id].every((x) => x === undefined || str(x))
const EVIDENCE_SHAPE: Shape = (e) => isObj(e) && Number.isInteger(e.when) && EVIDENCE_KINDS.includes(e.kind as EvidenceKind) && str(e.ref)
  && (e.card === undefined || str(e.card)) && (e.rev === undefined || Number.isInteger(e.rev))
/** 依頼の帳簿の欄の形。id は parseCockpit が先に断る。 */
export const REQUEST_SHAPE: Record<string, Shape> = {
  at: str, title: str, quote: str, state: (v) => v === 'open' || v === 'done', tasks: strs,
  utterances: list(obj(['id', 'quote'])), kind: (v) => REQUEST_KINDS.includes(v as RequestKind), done_when: strs, evidence: list(EVIDENCE_SHAPE),
  check: (v) => typeof v === 'boolean', legacy: (v) => typeof v === 'boolean',
  source: obj(['at', 'quote'], ['session']), ledger: strs, from_return: returnId
}
export const INTAKE_SHAPE: Shape = (v) => obj([], ['through', 'checked_through'])(v) && ((v as Intake).none === undefined || strs((v as Intake).none))

/** カード 1 枚の id・題・版・種類・状態が読めるか。読めなければ理由。画面で class 名や印に使うので、知らない値は断る。 */
export function cardHeadError(c: unknown): string | undefined {
  if (!isObj(c) || typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.rev !== 'number') return 'id・title・rev を読めない'
  if (c.id.startsWith('#')) return 'id が # で始まる（Orca から作る詰まりの行のために空けてある）'
  if (!KINDS.includes(c.kind as CardKind)) return `kind が不正: ${String(c.kind)}`
  if (c.state !== 'open' && c.state !== 'waiting' && c.state !== 'done') return `state が不正: ${String(c.state)}`
  return undefined
}

/**
 * 壊れた JSON・形の違うファイル・古い版は例外にし、呼び出し側が前回の表示を保てるようにする。
 * 1 枚のカード・1 つのタスクの形の誤りは、その 1 件だけを外して problems に「形の誤り」として名指しし、残りを描く
 * （帳簿は書く道具を通すが、Bash からの書き換えは止め切れないため）。
 */
export function parseCockpit(text: string, problems: string[] = []): Cockpit {
  const v: unknown = JSON.parse(text)
  if (!isObj(v)) throw new Error('cockpit.json がオブジェクトではありません')
  if (v.version !== VERSION)
    throw new Error(`cockpit.json が古い形（version ${String(v.version ?? 1)}）です。node window/migrate.ts <ワークスペースの root> --write で移し替えてください`)
  if (!isObj(v.workspace) || !Array.isArray(v.cards) || !Array.isArray(v.tasks) || !Array.isArray(v.streams))
    throw new Error('cockpit.json に workspace・streams・tasks・cards がありません')
  v.tasks = (v.tasks as Record<string, unknown>[]).filter((t) => {
    const why = !isObj(t) || typeof t.id !== 'string' ? 'id を読めない'
      : typeof t.title !== 'string' || typeof t.phase !== 'string' ? 'title・phase を読めない'
      : !TASK_STATES.includes(t.state as TaskState) ? `state が不正: ${String(t.state)}`
      : t.worker !== undefined && !WORKER_SHAPE(t.worker) ? 'worker の形が不正。{ run_id, task_id } で書く'
      : undefined
    if (why) problems.push(`形の誤り: cockpit.json のタスク ${String(t?.id)}（${why}）。このタスクは表示していません`)
    if (why) return false
    const bad = Object.keys(TASK_SHAPE).filter((k) => t[k] != null && !TASK_SHAPE[k]!(t[k]))
    for (const k of bad) delete t[k]
    if (bad.length) problems.push(`cockpit.json のタスク ${String(t.id)} の ${bad.join('・')} の形が違うので、その欄を出さずに表示しています`)
    return true
  })
  v.cards = (v.cards as unknown[]).filter((c) => {
    const why = cardHeadError(c)
    if (why) problems.push(`形の誤り: cockpit.json のカード ${String((c as { id?: unknown })?.id)}（${why}）。このカードは表示していません`)
    return !why
  })
  for (const st of v.streams as Record<string, unknown>[])
    if (isObj(st) && st.form !== undefined && !FORMS.includes(st.form as StreamForm)) {
      problems.push(`cockpit.json の仕事 ${String(st.id)} の form（${String(st.form)}）が不正なので、形が書かれていない仕事として出しています`)
      delete st.form
    }
  for (const key of ['owners', 'routes', 'requests'] as const)
    if (v[key] !== undefined && (!Array.isArray(v[key]) || (v[key] as unknown[]).some((x) => !isObj(x) || typeof x.id !== 'string')))
      throw new Error(`cockpit.json の ${key} の形が不正です`)
  for (const r of (v.requests ?? []) as Record<string, unknown>[]) {
    const bad = Object.keys(REQUEST_SHAPE).filter((k) => r[k] !== undefined && !REQUEST_SHAPE[k]!(r[k]))
    for (const k of bad) delete r[k]
    if (bad.length) problems.push(`cockpit.json の依頼 ${String(r.id)} の ${bad.join('・')} の形が違うので、その欄を外して読んでいます`)
  }
  if (v.asks !== undefined) {
    if (!Array.isArray(v.asks)) problems.push('cockpit.json の asks が配列ではないので、質問の返しの札を出していません')
    v.asks = Array.isArray(v.asks) ? (v.asks as unknown[]).filter((x) => isObj(x) && typeof x.id === 'string') : undefined
  }
  if (isObj(v.main) && v.main.run_id !== undefined && !RUN_ID(v.main.run_id)) {
    problems.push(`cockpit.json の main.run_id（${String(v.main.run_id)}）の形が違うので、その欄を外して読んでいます`)
    delete v.main.run_id
  }
  if (v.intake !== undefined && !INTAKE_SHAPE(v.intake)) {
    problems.push('cockpit.json の intake の形が違うので、発言の仕分けの検査を止めています')
    delete v.intake
  }
  problems.push(...dropBadFields(v.cards as Card[], 'cockpit.json '))
  for (const c of v.cards as Card[]) upgradeCard(c)
  return v as unknown as Cockpit
}

export function parseUserLog(text: string): UserLog {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.ops)) throw new Error('cockpit.user.json に ops がありません')
  return v as unknown as UserLog
}

export function parseArchive(text: string, problems: string[] = []): Archive {
  const v: unknown = JSON.parse(text)
  if (!isObj(v) || !Array.isArray(v.cards)) throw new Error('cockpit.archive.json に cards がありません（古い形なら migrate.ts で移し替えてください）')
  // 片付いたの列も同じ描画を通るので、id・題・種類が読めないカードは外し、欄の形も確かめる。
  const cards = (v.cards as Record<string, unknown>[]).filter((c) => isObj(c) && str(c.id) && str(c.title) && KINDS.includes(c.kind as CardKind))
  if (cards.length < v.cards.length) problems.push(`cockpit.archive.json の id・title・kind が読めないカード ${v.cards.length - cards.length} 枚を出していません`)
  problems.push(...dropBadFields(cards as unknown as Card[], 'cockpit.archive.json '))
  return { cards: cards as unknown as Card[] }
}

export function nextOp(log: UserLog, op: Omit<Op, 'op_id'>): Op {
  const last = log.ops.reduce((n, o) => Math.max(n, o.op_id), 0)
  return { op_id: last + 1, ...op }
}

/**
 * カードの今。
 * - mine: 私の番（件数に数える種類なら数える）。「担当と話す」を押したカードも、同じ版のあいだは talking の印を付けて私の番に残す（R46）
 * - fixing: 見てで直しを頼んだ（本文つきの talk）。件数から外し、担当が直して rev が上がると mine に戻る
 * - waiting: 送ったあと顧客の返事を待っている
 * - closed: 済み。pending は担当がまだ受け取っていない（受け取り待ち）
 */
export type Status = 'mine' | 'fixing' | 'waiting' | 'closed'
export type CardView = {
  card: Card
  status: Status
  /** 利用者の操作を担当がまだ受け取っていない。 */
  pending: boolean
  /** 取り消せる操作（10 秒の間と、担当が受け取る前）。 */
  undoOp?: Op
  /** 済んだ理由（「決めた: …」）。 */
  how?: string
  when?: string
  chosen?: Option
  /** 見ての「直してほしいことを書く」で頼んだ直し（本文つきの talk の操作の text）。 */
  fix?: string
  /** 「担当と話す」を押してから、担当・窓口がカードを書き直すまで（同じ版のあいだ）。since は押した時刻、terminal はカードの相談のタブ。 */
  talking?: { since: string; terminal?: string }
}

const CLOSING: OpType[] = ['decide', 'accept', 'sent', 'skip', 'delegate', 'ack']

function closedLabel(c: Card, type: OpType | undefined, option?: Option, text?: string): string {
  if (type === 'decide' && option?.id === OTHER) return `別の回答: ${text ?? ''}`
  if (type === 'decide' || (!type && option)) return `${c.kind === 'permit' ? '許可' : '決定'}: ${option?.label ?? text ?? '?'}`
  if (type === 'accept') return c.kind === 'permit' ? '許可' : '承認'
  if (type === 'sent') return c.kind === 'send' ? '送信済み' : '対応済み'
  if (type === 'skip') return c.kind === 'send' ? '送信しない' : c.kind === 'inbox' ? '返信不要' : c.kind === 'permit' ? '却下' : '見送り'
  if (type === 'delegate') return '許可・以後一任'
  if (type === 'ack') return '既読'
  return '担当が完了'
}

const SILENT: OpType[] = ['undo', 'repeat', 'dismiss']
/** 窓から出した指示の 1 件。applied は窓口（担当）が帳簿に反映したか。 */
export type Sent = { op: Op; card: Card; label: string; text?: string; applied: boolean }

/**
 * カードへ出した指示（操作の記録から作る。帳簿には書かない）。新しい順。取り消した操作と取り消しそのもの、
 * カードに結ばれない合図（repeat）、窓だけの記録の詰まりの「済ませた」は出さない。
 */
export function sentOps(cards: Card[], log: UserLog, appliedOps: number[] = []): Sent[] {
  const applied = new Set(appliedOps)
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const byId = new Map(cards.map((c) => [c.id, c]))
  return log.ops
    .filter((o) => byId.has(o.item_id) && !SILENT.includes(o.type) && !undone.has(o.op_id))
    .map((o): Sent => {
      const c = byId.get(o.item_id)!
      // 選択肢の文言と戻す作業は、押した版が今のカードと同じときだけ今のカードから引く（版が変わると同じ id が別の中身を指す）。
      const same = o.item_rev === c.rev
      const old = same ? '' : `（版 ${o.item_rev}）`
      const [label, text] = o.type === 'decide' && o.option_id === OTHER ? ['別の回答', o.text]
        : o.type === 'decide' ? [`${closedLabel(c, 'decide', (same && c.options?.find((x) => x.id === o.option_id)) || { id: o.option_id ?? '', label: o.option_id ?? '?' })}${old}`, o.text]
        : o.type === 'talk' ? (o.text?.trim() ? ['修正を依頼', o.text] : ['協議を開始', undefined])
        : o.type === 'revert' ? [`戻すよう依頼${old}`, same ? c.done?.[o.target ?? -1]?.what : `${(o.target ?? 0) + 1} 件目`]
        : [`${closedLabel(c, o.type)}${old}`, o.text]
      return { op: o, card: c, label, text: text?.trim() || undefined, applied: applied.has(o.op_id) }
    })
    .sort((a, b) => timeOf(b.op.at) - timeOf(a.op.at) || b.op.op_id - a.op.op_id)
}

const USER_DONE: Record<CardKind, string> = {
  review: '承認', permit: '許可', decide: '決定', send: '送信済み', report: '既読', stuck: '回答', inbox: '返信不要', consult: '協議で決定', talk: '協議で決定'
}

/**
 * cockpit.json の状態に、操作ログのうち効いている操作を重ねる。live は Orca にある端末か（分からなければ渡さない）。
 * カードの相談のタブ（talk の op の terminal）が閉じたら、話し中の印を外す。
 */
export function overlay(c: Cockpit, log: UserLog, archive: Card[] = [], live?: (terminal: string) => boolean): CardView[] {
  const applied = new Set(c.applied_ops ?? [])
  const undone = new Set(log.ops.filter((o) => o.type === 'undo' && o.undo_of != null).map((o) => o.undo_of!))
  const byCard = new Map<string, Op[]>()
  for (const o of log.ops) byCard.set(o.item_id, [...(byCard.get(o.item_id) ?? []), o])
  const out: CardView[] = []
  for (const card of c.cards) {
    const ops = (byCard.get(card.id) ?? []).filter((o) => !undone.has(o.op_id) && o.type !== 'undo')
    const option = (id?: string) => (id === OTHER ? { id: OTHER, label: '別の答え' } : card.options?.find((x) => x.id === id))
    // 重ねるのは今の版に押した未反映の操作だけ。反映後と、担当が書き換えた後は cockpit.json を正にする。
    const act = ops.filter((o) => CLOSING.includes(o.type) && o.item_rev === card.rev && !applied.has(o.op_id)).at(-1)
    if (act && card.state === 'open') {
      const chosen = option(act.option_id)
      out.push({ card, status: 'closed', pending: true, undoOp: act, how: closedLabel(card, act.type, chosen, act.text), when: act.at, chosen })
      continue
    }
    if (card.state === 'done') {
      const chosen = option(card.resolved_option)
      // 深田さんの返答で閉じたのに選択肢の記録が無いもの（見て・許す・報告など）は、種類ごとの返答の名前にする（「担当が片付けた」と出さない）。
      const how = card.resolved_by === 'user' ? (chosen ? closedLabel(card, undefined, chosen, card.resolved_text) : card.resolved_text ? `${USER_DONE[card.kind]}: ${card.resolved_text}` : USER_DONE[card.kind]) : closedLabel(card, undefined)
      out.push({ card, status: 'closed', pending: false, how: card.resolved_option === OTHER ? `別の回答: ${card.resolved_text ?? ''}` : how, when: card.resolved_at, chosen })
      continue
    }
    if (card.state === 'waiting') {
      out.push({ card, status: 'waiting', pending: false, when: card.awaiting?.since })
      continue
    }
    const talks = ops.filter((o) => o.type === 'talk' && o.item_rev === card.rev)
    // 直しの受領は applied_ops に足すだけでカードの中身は変えない。直した版（rev が上がる）が出るまで件数から外す。
    const fix = talks.filter((o) => o.text?.trim()).at(-1)
    if (fix) {
      const pending = !applied.has(fix.op_id)
      out.push({ card, status: 'fixing', pending, undoOp: pending ? fix : undefined, when: fix.at, fix: fix.text })
      continue
    }
    // 最新の協議だけを見る（相談のタブを閉じたら、前に窓口へ回した協議の印を戻さない）。
    const last = talks.at(-1)
    const talk = last && (!last.terminal || !live || live(last.terminal)) ? last : undefined
    out.push({ card, status: 'mine', pending: false, ...(talk && { talking: { since: talk.at, ...(talk.terminal && { terminal: talk.terminal }) }, when: talk.at, undoOp: applied.has(talk.op_id) ? undefined : talk }) })
  }
  for (const card of archive) {
    const chosen = card.options?.find((x) => x.id === card.resolved_option)
    out.push({ card, status: 'closed', pending: false, how: closedLabel(card, undefined, chosen, card.resolved_text), when: card.resolved_at, chosen })
  }
  return out
}

/**
 * 依頼の今の判定が読むカード（証拠の操作が指すカードと、request_id で依頼に結ばれたカード）。済・進行中の判定がこのカードの版と有無を見るので、
 * 表示の期間を過ぎても窓に送る（窓と CLI で依頼の今が食い違わないように）。
 */
export function requestCards(c: Cockpit, log: UserLog): Set<string> {
  const reqs = new Set((c.requests ?? []).map((r) => r.id))
  const ids = new Set(c.cards.filter((x) => x.request_id && reqs.has(x.request_id)).map((x) => x.id))
  for (const e of (c.requests ?? []).flatMap((r) => r.evidence ?? []))
    if (e.kind === 'op') {
      const o = log.ops.find((x) => String(x.op_id) === e.ref)
      for (const id of [e.card, o?.item_id]) if (id) ids.add(id)
    }
  return ids
}

/** メインにまだ反映されていない操作。 */
export function unappliedOps(c: Cockpit | undefined, log: UserLog): Op[] {
  const applied = new Set(c?.applied_ops ?? [])
  // 詰まりの「済ませた」とその取り消しは窓だけの記録で、窓口に反映させるものが無い。
  const dismiss = new Set(log.ops.filter((o) => o.type === 'dismiss').map((o) => o.op_id))
  return log.ops.filter((o) => !applied.has(o.op_id) && !dismiss.has(o.op_id) && !(o.type === 'undo' && dismiss.has(o.undo_of ?? -1)))
}

const SEV: Record<TaskState, number> = { stop: 0, run: 1, wait: 2, idle: 3, ok: 4 }
export function worstState(states: TaskState[]): TaskState | undefined {
  return [...states].sort((a, b) => SEV[a] - SEV[b])[0]
}

export type ShownWhy = 'ok' | 'record' | 'working' | 'intake' | 'stopped' | 'missing'
export type TaskShown = { state: TaskState; why: ShownWhy; stop?: string }

/**
 * 画面に出すタスクの状態。worker の記録があるタスクは、メインの書いた state ではなく Orca の Dispatch の様子から決める
 * （メインが書き忘れると「worker が作業中なのに動いていない」のような矛盾が出たため、2026-11-16）。
 * fact は undefined なら Orca を読んでいない（パネル）、null なら Orca に無い。
 * - state が ok なら完了、wait（外の相手を待つ）はメインの書いた state のまま
 * - worker_done を返していれば、メインの取り込み待ち
 * - 起動できない・落ちた・端末が消えた・人の確認待ちなら、止まっている
 * - それ以外は進行中（担当が利用者と話している間や worker を待つ間も、Dispatch は開いたまま）
 */
export function shownTask(t: Task, fact: DispatchFact | null | undefined): TaskShown {
  if (t.state === 'ok') return { state: 'ok', why: 'ok' }
  if (!t.worker || fact === undefined || t.state === 'wait') return { state: t.state, why: 'record' }
  if (fact === null) return { state: 'stop', why: 'missing' }
  if (fact.state === 'succeeded') return { state: 'wait', why: 'intake' }
  if (fact.state === 'failed' || fact.liveness === 'exited') return { state: 'stop', why: 'stopped', stop: fact.liveness === 'exited' ? 'dead' : 'error' }
  if (fact.waiting) return { state: 'stop', why: 'stopped', stop: 'blocked' }
  return { state: 'run', why: 'working' }
}

const has = (v: unknown): boolean =>
  Array.isArray(v) ? v.some(has) : isObj(v) ? Object.values(v).some(has) : typeof v === 'boolean' || typeof v === 'number' || !!String(v ?? '').trim()
type Need = [key: string, label: string, ok: (c: Card) => boolean]
/** 許可の影響と対象。版 2 の許可は判断の材料（context.gain・context.what）に書いたものがある。必須の判定と窓・パネルの表示で同じ選び方をする。 */
export const permitEffect = (c: Pick<Card, 'effect' | 'context'>) => (c.effect?.trim() ? c.effect : c.context?.gain)
export const permitTarget = (c: Pick<Card, 'target' | 'context'>) => (c.target?.trim() ? c.target : c.context?.what)

const COMMON_NEEDS: Need[] = [
  // 並びは窓で見せる順（何のためを題の直下に置く。info-needs 3.10）。
  ['purpose', '何のため', (c) => has(c.purpose)],
  ['stream', 'どの仕事の話か', (c) => has(c.stream)],
  ['why|due', 'なぜ今・期限', (c) => has(c.why) || has(c.due)],
  ['fallback', '返事が無いとき', (c) => has(c.fallback)],
  // 出典は、資料・原文・依頼の原文・成果物のほか、送る前の元のスレッド・届いた連絡・いきさつの原文でも足りる。
  ['links|quote|request|href', '出典', (c) => has(c.links) || has(c.quote) || has(c.request) || has(c.href) || has(c.draft?.href) || has(c.from?.href) || has(c.background?.quote)]
]
const KIND_NEEDS: Partial<Record<CardKind, Need[]>> = {
  decide: [
    ...CONTEXT_FIELDS.map(([k, l]): Need => [`context.${k}`, l, (c) => has(c.context?.[k])]),
    ['options', '選択肢 2 つ以上と各案の具体例', (c) => (c.options?.length ?? 0) >= 2 && c.options!.every((o) => has(o.example))],
    ['options.recommended', 'おすすめ 1 つ', (c) => c.options?.filter((o) => o.recommended).length === 1]
  ],
  review: [
    ['href|draft.text', '成果物', (c) => has(c.href) || has(c.draft?.text)], ['look_for', '見てほしい点', (c) => has(c.look_for)],
    ['request', '依頼の原文', (c) => has(c.request)], ['evidence', '確認した結果', (c) => has(c.evidence)]
  ],
  permit: [
    ['effect|context.gain', '何が変わるか', (c) => has(permitEffect(c))],
    ['target|context.what', '対象', (c) => has(permitTarget(c))],
    ['undo', '戻し方', (c) => has(c.undo)]
  ],
  send: [['draft.to', '宛先', (c) => has(c.draft?.to)], ['draft.via', '経路', (c) => has(c.draft?.via)], ['draft.text', '本文', (c) => has(c.draft?.text)], ['draft.href', '元のスレッド', (c) => has(c.draft?.href)]],
  consult: [['issue', '論点', (c) => has(c.issue)], ['stance', '担当の今の考え', (c) => has(c.stance)]],
  stuck: [['reason', '何で止まっているか', (c) => has(c.reason)], ['unblock', '何をすれば進むか', (c) => has(c.unblock)]]
}
/** 手作業の頼みは、何のためと手作業の欄だけで足りる（cards.md「深田の手作業を頼む」）。 */
const MANUAL_NEEDS: Need[] = [
  ['purpose', '何のため', (c) => has(c.purpose)],
  ['manual.where', 'どこで', (c) => has(c.manual?.where)],
  ['manual.command|steps', 'コマンドか手順', (c) => has(c.manual?.command) || has(c.manual?.steps)],
  ['manual.check', '済ませたあと窓口が確認すること', (c) => has(c.manual?.check)]
]

/**
 * 確認依頼の必須の欄のうち、欠けているもの（R46-4）。深田さんに頼む種類（ASKING）だけを見る。欠けたカードは窓の要対応に出さず、
 * state.ts の checks.incomplete_cards で窓口に名指しする。key は窓口が直す欄、label は画面に出す名前。
 */
export function missingFields(c: Card): { key: string; label: string }[] {
  if (!ASKING.includes(c.kind)) return []
  const needs = c.kind === 'permit' && c.manual ? MANUAL_NEEDS : [...COMMON_NEEDS, ...(KIND_NEEDS[c.kind] ?? [])]
  return needs.filter(([, , ok]) => !ok(c)).map(([key, label]) => ({ key, label }))
}
