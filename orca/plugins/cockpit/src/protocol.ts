import type { AnswerVia, AskAnswer, AskThread, Card, Cockpit, ConsultMemo, DraftCheck, DraftFormat, Handoff, OpType, TaskSeen, UserLog, Utterance } from './model.ts'

/** 止まっている理由。blocked: 許可待ち、waiting: 返事待ち、dead: プロセスが落ちた。 */
export type StopReason = 'blocked' | 'waiting' | 'interrupted' | 'error' | 'dead' | 'auth' | 'limit'

/** 止まったエージェントが人に出している問い。question: 質問（AskUserQuestion・orchestration の question）、permit: 道具を使ってよいかの確認。 */
export type Ask = {
  kind: 'question' | 'permit'; text: string; options?: string[]; /** 誰が誰に聞いているかの 1 行（窓の行の 2 行目と詳細の題の下）。derive が足す。 */ from?: string
  /** 端末の画面から読んだ問いだけ: 選択肢の番号と文と下の説明、自由入力（Type something）の番号、枠の上の段落、枠の中の問いより上の行（許可の道具の名前と全文）。 */
  choices?: ScreenChoice[]; free?: number; before?: string; body?: string[]
  /** 許可の確認で、題（text）をコマンドにしたときの画面の問いの文（Do you want to proceed? など）。 */
  question?: string
  /** 画面の問いの印（window/orca-state.ts の screenSig）。窓から答えを送る直前に画面を読み直し、同じ問いのときだけキーを送る。 */
  sig?: string
}
/** 端末の選択肢の 1 行。n は押す番号のキー、label は画面の文のまま、note は下の説明の行。 */
export type ScreenChoice = { n: number; label: string; note?: string }

/** Orca の orchestration の question のうち、答えの無いまま待っているもの（window/orca-state.ts の questionFacts）。 */
export type QuestionFact = {
  id: string
  at: number
  /** 一覧の 1 行に出す題（送り主の件名か、本文の 1 行目）。 */
  line: string
  text: string
  options?: string[]
  /** main: 窓口の Run 宛て。owner: 担当の Run 宛て（担当が答える）。 */
  to: 'main' | 'owner'
  /** 聞いた worker の帳簿のタスク。 */
  task?: string
  /** 聞いた側の仕事（タスクが無いときは、担当のチャットのある worktree の下で引いた担当の仕事）。 */
  stream?: string
  /** 聞いたのが担当そのもの。 */
  byOwner?: boolean
  /** 聞いた側の名前（タスクも仕事も引けないときの worktree の表示名）。 */
  asker?: string
}

export type AgentRow = {
  terminalId: string | null
  title: string | null
  agent: string | null
  state: 'working' | 'blocked' | 'waiting' | 'done'
  since: number
  stop?: StopReason
  /** その worker の worktree のパス。端末が無いときに worktree を開くのに使う。 */
  worktree?: string
  /** 何の仕事か。task の worker の記録（Dispatch の端末）で結べればその task の名前、無ければ worktree の表示名・コメント。 */
  job?: string
  /** 操縦席の task.worker に記録された worker なら、その task の id。 */
  task?: string
  /** worktree の comment の「｜」より後ろ（worker が書く今していること）。 */
  where?: string
  /** Orca のチャット（端末ではない）。開くボタンはチャットのある worktree を開く。 */
  chat?: boolean
  /** チャットの Orca のセッション。詰まりの行の id に使う。 */
  session?: string
  /** 利用枠の上限で止まったとき、戻る時刻（「22:50」）。読めなければ無い。 */
  reset?: string
  /** 許可待ち・返事待ちのときの問い。読めなければ無い。 */
  ask?: Ask
}

/** Orca の orchestration の Dispatch の様子（orca orchestration worker-show）。 */
export type DispatchFact = {
  /** ready・dispatched（進行中）、succeeded（worker_done を返した）、failed（起動できない・落ちた・端末が消えた）など。 */
  state: string
  /** live・exited・unverifiable。 */
  liveness?: string
  /** 人にしか答えられない確認（許可など）で止まっている。 */
  waiting?: boolean
  /** worker の handle。チャットの worker（worker-start --agent）は structworker_… で、端末の一覧には出ない。 */
  terminal?: string | null
  /** チャットの worker なら、そのチャットの orcaSessionId（orca agent list で居場所を引く）。 */
  session?: string
  /** 終わった時刻（ミリ秒）。取り込み待ちの猶予に使う。 */
  settledAt?: number
  /** worker の worktree のパス。orchestration の question をどの案件のものか決めるのに使う。 */
  worktree?: string
  /** Orca のタスクの状態（task-list の status。completed など）。Run の続きをたどって引いたときだけ。 */
  taskStatus?: string
}

/** 担当（Orca のチャットか端末のエージェント）の今。orca agent list から取る。 */
export type OwnerLive = {
  session: string; kind: 'chat' | 'terminal'; state: AgentRow['state']; title?: string; worktree?: string; updatedAt?: number
  /** 一緒に作る仕事の担当がターンを終えたときの、最後の返事の全文（orca agent show の lastAssistantMessage）。読めなければ無い。 */
  last?: string
}

/** 1 つの案件の操縦席。 */
export type CockpitView = {
  /** no-workspace: どのワークスペースも開いていない。missing: cockpit.json が無い。 */
  state: 'no-workspace' | 'missing' | 'ok'
  root?: string
  cockpit?: Cockpit
  log: UserLog
  archive: Card[]
  /** figure に書かれた相対パス → SVG の中身。 */
  figures: Record<string, string>
  /** 読めなかったファイルの 1 行の説明。前回読めた中身は cockpit・log・archive に残す。 */
  errors: string[]
  /** メインを除く、このワークスペースのエージェント。 */
  workers: AgentRow[]
  /** worker の記録（tasks[].worker.dispatch_id）ごとの Orca の様子。null は Orca に無い。パネルは読まないので undefined。 */
  dispatches?: Record<string, DispatchFact | null>
  /** 担当の今（session で引く）。パネルは持たない。 */
  owners?: OwnerLive[]
  /** 担当の今を最後の読み直しで読めなかった（owners は前の値か空）。放置の判定がチャットの担当のタスクを保留する。 */
  ownersStale?: boolean
  /** メインに合図を送ったときの、最後の op_id。 */
  notifiedOp: number
  /** 自動の合図が届いていないとき。waiting: メインが作業中なので一区切りを待っている。failed: 送れなかった。 */
  signal?: { state: 'waiting' | 'failed'; reason?: string }
  /** メインを新しいチャットに引き継いだ知らせ（.orca/cockpit/handoff.json）。 */
  handoff?: Handoff
  /** 仕分けの検査に使う、id のある発言（本文は頭だけ）。パネルは持たない。 */
  utterances?: Utterance[]
  /** 相談・質問の返しで反映された発言の id（仕分け済みとみなす）。判断の記録は窓に送らないので常駐のプロセスが決める。 */
  returned?: string[]
  /** 済んでいないタスクの中身が最後に変わった時刻（放置の検出の起点）。 */
  taskSeen?: TaskSeen
  /** at の無い開いたカードを最初に見つけた時刻。 */
  firstSeen?: Record<string, string>
  /** タスクの id → 今の Dispatch（Run の続きをたどった先）。パネルは持たない。 */
  current?: Record<string, string>
  /** Orca にある端末の handle（Orca を読めていなければ無い）。カードの相談のタブが閉じたら話し中を外すのに使う。 */
  terminals?: string[]
  /** 端末の一覧が上限で切れているかもしれない。 */
  terminalsPartial?: boolean
  /** カードの相談のメモ。パネルは持たない。 */
  consults?: ConsultMemo[]
  /** この案件の worker と担当が出した、答えの無い orchestration の question。パネルは持たない。 */
  questions?: QuestionFact[]
  /** 一緒に作る仕事の担当の handle → その担当の Run で終わっていない worker の Dispatch（state.ts の OrcaFacts.coordinating）。パネルは持たない。 */
  coordinating?: Record<string, string[]>
  /** 窓からの質問（控えの節は新しいものだけに絞る）。パネルは持たない。 */
  asks?: AskThread[]
  /** 窓が質問のタブに「返しを書いて（op n）」を届けた op。読めなければ無い（届いたかを出さない）。パネルは持たない。 */
  askSent?: number[]
  /** 閉じていないカードの文面を宛先の書式で検査した結果（カード id ごと）。コピーは結果の無い・違反のある文面を入れない。 */
  drafts?: Record<string, DraftCheck>
  /**
   * この案件の見張る仕事の Bot の今（orca automations list・runs から。R152）。Orca を読めていなければ無い。パネルは持たない。
   * 帳簿の watch.automation が Orca に無いものは name の無い行で入る。
   */
  automations?: AutomationFact[]
}

/** 見張る仕事の Bot（orca automations の 1 件）。name が無ければ Orca に設定が無い。lastUnread は実行したが最後の実行を読めていない。 */
export type AutomationFact = { id: string; name?: string; rrule?: string; timezone?: string; enabled?: boolean; nextRunAt?: number; last?: AutomationRun; lastUnread?: true }
/** 最後の実行。at は予定の時刻（scheduledFor）、content は出力の全文、chat はその実行のチャットの handle（前に出すのに使う）。 */
export type AutomationRun = { status: string; at: number; content?: string; error?: string; chat?: string }

/** root と item_rev は画面が表示していたもの。別のワークスペースや新しい版に記録しない。 */
export type OpInput = { root: string; item_id: string; item_rev: number; type: OpType; option_id?: string; undo_of?: number; target?: number; text?: string; terminal?: string; answer?: AskAnswer; choice?: string; via?: AnswerVia; to?: string[]; key?: number }
/** 窓から質問する（consult --ask）。ask が無ければ新しい質問、あれば続き。card・task・stream は結ぶ先（新しい質問だけ・1 つまで）。 */
export type AskInput = { root: string; ask?: string; question: string; card?: string; task?: string; stream?: string }
/** 質問のタブを開いた結果。ask は質問 id（新しい質問でも、立てられなかったときも返す）。 */
export type AskResult = { opened: boolean; ask?: string; reason?: string }
/** 質問の前に判断の記録から引いた行（撤回・置き換えされていないもの）。 */
export type RulingHit = { id: string; at?: string; kind?: string; text: string; quote?: string }
/** 「これで決める」の結果。op は書いた op_id、sent は質問のタブに「返しを書いて」を送れたか。 */
/** again: 同じ答えをもう記録していた（記録も知らせも足していない）。 */
export type AskDecideResult = { op: number; sent: boolean; reason?: string; again?: true }
export type NotifyResult = { sent: boolean; reason?: string }
/**
 * 停止の行に窓から答える（/api/answer）。item_id は行の id、rev は行の版（聞いた時刻の ms）。端末の問いは、選んだ番号（choice）か書いた文（text）と、
 * 見ていた画面の印（sig）を送る。orchestration の問い（#ask:msg_…）と担当の返事待ち（#cowork:…）は text だけ。
 */
export type AnswerInput = { root: string; item_id: string; rev: number; text?: string; choice?: number; sig?: string }
/** 答えを届けた結果。届かなければ reason（op は書いていない）。how は届け先を利用者の語で（「端末」「worker と窓口」など）。 */
export type AnswerResult = { sent: boolean; how?: string; op?: number; reason?: string; note?: string }
/**
 * 担当を開いた結果。how はどこを開いたか（画面に出す）。tab は利用者が選ぶチャットのタブの題（Orca にはチャットのタブを前に出す手段が無いので、
 * 名前で案内する）。reason は開けなかった理由。note はカードの相談を立てられずに窓口へ回したときの理由。
 * terminal は、相談のタブを開いたのに協議の記録を残せなかったときの、そのタブの handle。
 */
export type TalkResult = { opened: boolean; how: string; tab?: string; reason?: string; note?: string; terminal?: string }
/** 開く系の結果。開けなければ理由を返し、画面が黙って何も起きないようにしない。 */
export type OpenResult = { opened: boolean; reason?: string }
/** 送る文面を宛先の書式でクリップボードに入れた結果。subject はメールの先頭の「件名:」行（本文からは外す）。 */
export type ClipResult = { copied: boolean; subject?: string; reason?: string }
/** 帯の印・「端末を開く」の結果。how は前に出したもの（端末かワークスペース）。 */
/** how は前に出したもの。worktree を前に出したときは「作業場所」（ワークスペースの名前は利用者の語でないので出さない）。 */
export type FocusResult = { focused: boolean; how?: string }

/** 常駐のプロセスが窓のページに SSE で送る全体。 */
export type WindowView = {
  /** Orca の前面のワークスペース（worker の worktree なら操縦席のある親）。 */
  focused?: string
  /** 操縦席のある案件の全部。 */
  boards: CockpitView[]
  /** Orca にあって操縦席の無い案件（見ていない案件）。 */
  unseen: { name: string; path: string; why?: string }[]
  /** プロセスが生きているエージェントの総数。 */
  live: number
  /** Orca に繋がらないなど、窓全体の 1 行の知らせ。 */
  errors: string[]
}

declare module 'orca' {
  interface PluginRequests {
    'cockpit.get': { output: CockpitView }
    'cockpit.op': { input: OpInput; output: { view: CockpitView; notify?: NotifyResult } }
    'cockpit.notify': { output: NotifyResult }
    /** ファイルを Orca で開く。path はワークスペースからの相対パスか、同じリポジトリの worktree の中の絶対パス。 */
    'cockpit.open': { input: { path: string }; output: OpenResult }
    'cockpit.focus': { input: { terminalId: string }; output: FocusResult }
    /** 送る文面を clip-draft に渡し、宛先の書式でクリップボードに入れる。 */
    'cockpit.clip': { input: { text: string; format: DraftFormat }; output: ClipResult }
    /** カードの担当を開く（担当の端末を前に出す。チャットの担当はワークスペースを開く）。 */
    /** root と item_rev は画面が表示していたもの。前面が変わったあと・担当が書き換えたあとの要求は断る。 */
    'cockpit.talk': { input: { root: string; item_id: string; item_rev: number }; output: TalkResult }
  }
  interface PluginPanelEvents {
    'cockpit.changed': CockpitView
  }
}
