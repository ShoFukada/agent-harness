import type { Card, Cockpit, Handoff, OpType, UserLog } from './model.ts'

/** 止まっている理由。blocked: 許可待ち、waiting: 返事待ち、dead: プロセスが落ちた。 */
export type StopReason = 'blocked' | 'waiting' | 'interrupted' | 'error' | 'dead' | 'auth' | 'limit'

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
}

/** Orca の orchestration の Dispatch の様子（orca orchestration worker-show）。 */
export type DispatchFact = {
  /** ready・dispatched（進行中）、succeeded（worker_done を返した）、failed（起動できない・落ちた・端末が消えた）など。 */
  state: string
  /** live・exited・unverifiable。 */
  liveness?: string
  /** 人にしか答えられない確認（許可など）で止まっている。 */
  waiting?: boolean
  terminal?: string | null
  /** 終わった時刻（ミリ秒）。取り込み待ちの猶予に使う。 */
  settledAt?: number
}

/** 担当（Orca のチャットか端末のエージェント）の今。orca agent list から取る。 */
export type OwnerLive = { session: string; kind: 'chat' | 'terminal'; state: AgentRow['state']; title?: string; worktree?: string; updatedAt?: number }

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
  /** メインに合図を送ったときの、最後の op_id。 */
  notifiedOp: number
  /** 自動の合図が届いていないとき。waiting: メインが作業中なので一区切りを待っている。failed: 送れなかった。 */
  signal?: { state: 'waiting' | 'failed'; reason?: string }
  /** メインを新しいチャットに引き継いだ知らせ（.orca/cockpit/handoff.json）。 */
  handoff?: Handoff
}

/** root と item_rev は画面が表示していたもの。別のワークスペースや新しい版に記録しない。 */
export type OpInput = { root: string; item_id: string; item_rev: number; type: OpType; option_id?: string; undo_of?: number; target?: number; text?: string }
export type NotifyResult = { sent: boolean; reason?: string }
/** 担当を開いた結果。how はどこを開いたか（画面に出す）。 */
/** tab は利用者が選ぶチャットのタブの題（Orca にはチャットのタブを前に出す手段が無いので、名前で案内する）。 */
export type TalkResult = { opened: boolean; how: string; tab?: string }

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
    'cockpit.open': { input: { path: string }; output: { opened: boolean } }
    'cockpit.focus': { input: { terminalId: string }; output: { focused: boolean } }
    /** カードの担当を開く（担当の端末を前に出す。チャットの担当はワークスペースを開く）。 */
    /** root と item_rev は画面が表示していたもの。前面が変わったあと・担当が書き換えたあとの要求は断る。 */
    'cockpit.talk': { input: { root: string; item_id: string; item_rev: number }; output: TalkResult }
  }
  interface PluginPanelEvents {
    'cockpit.changed': CockpitView
  }
}
