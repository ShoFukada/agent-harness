import type { Cockpit, Handoff, Item, OpType, Reply, UserLog } from './model.ts'

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
  /** 何の仕事か。操縦席の task の worker の記録（Dispatch の端末）で結べればその task の名前、無ければ worktree の表示名・コメント。 */
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

export type CockpitView = {
  /** no-workspace: どのワークスペースも開いていない。missing: cockpit.json が無い。 */
  state: 'no-workspace' | 'missing' | 'ok'
  root?: string
  cockpit?: Cockpit
  log: UserLog
  archive: Item[]
  /** figure に書かれた相対パス → SVG の中身。 */
  figures: Record<string, string>
  /** 読めなかったファイルの 1 行の説明。前回読めた中身は cockpit・log・archive に残す。 */
  errors: string[]
  /** メインを除く、このワークスペースのエージェント。 */
  workers: AgentRow[]
  /** worker の記録（tasks[].worker.dispatch_id）ごとの Orca の様子。null は Orca に無い。パネルは読まないので undefined。 */
  dispatches?: Record<string, DispatchFact | null>
  /** メインに合図を送ったときの、最後の op_id。 */
  notifiedOp: number
  /** 自動の合図が届いていないとき。waiting: メインが作業中なので一区切りを待っている。failed: 送れなかった。 */
  signal?: { state: 'waiting' | 'failed'; reason?: string }
  /** 話したいへの回答（.orca/cockpit.talk.json）。 */
  replies: Reply[]
  /** アシスタントが答えている途中の talk の op_id。 */
  thinking?: number[]
  /** メインを新しいチャットに引き継いだ知らせ（.orca/cockpit/handoff.json）。 */
  handoff?: Handoff
}

/** root と item_rev はパネルが表示していたもの。切り替え前の画面や古い表示で押した操作を、別のワークスペースや新しい版に記録しない。 */
export type OpInput = { root: string; item_id: string; item_rev: number; type: OpType; option_id?: string; undo_of?: number; target?: number; text?: string; to_main?: boolean; handoff_of?: number }
export type NotifyResult = { sent: boolean; reason?: string }

/** 窓の左の列の 1 行（操縦席のある本線 1 つ）。 */
export type WsRow = {
  root: string
  name: string
  /** あなたの番（決める・聞く・見て）の件数と、その内訳と最短の期限。 */
  open: number
  counts: { dec: number; ask: number; rev: number }
  due?: string
  /** いちばん急ぐ項目（期限の近い順、同じなら決める・見て・聞くの順）。 */
  next?: { id: string; title: string }
  /** 子の worktree とこのワークスペースの、メインを除くエージェント。 */
  workers: number
  stopped: number
}

/** 常駐のプロセスが窓のページに SSE で送る全体。 */
export type WindowView = {
  /** follow: Orca の前面に合わせる。manual: 列で選んだ行を出す。 */
  mode: 'follow' | 'manual'
  /** Orca の前面のワークスペースのパス。 */
  focused?: string
  rows: WsRow[]
  /** プロセスが生きているエージェントの総数。 */
  live: number
  view: CockpitView
  /** Orca に繋がらないなど、窓全体の 1 行の知らせ。 */
  errors: string[]
}

declare module 'orca' {
  interface PluginRequests {
    'cockpit.get': { output: CockpitView }
    /** 操作を cockpit.user.json に追記する。talk はそのままメインに合図も送る。 */
    'cockpit.op': { input: OpInput; output: { view: CockpitView; notify?: NotifyResult } }
    'cockpit.notify': { output: NotifyResult }
    /** ファイルを Orca で開く。path はワークスペースからの相対パスか、同じリポジトリの worktree の中の絶対パス。 */
    'cockpit.open': { input: { path: string }; output: { opened: boolean } }
    'cockpit.focus': { input: { terminalId: string }; output: { focused: boolean } }
  }
  interface PluginPanelEvents {
    'cockpit.changed': CockpitView
  }
}
