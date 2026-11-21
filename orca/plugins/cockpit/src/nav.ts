// 「全体 → 大タスク → 確認」の行き来で、どのボタンでどの画面に移り、戻り先をどう持つかを決める。
// DOM に触らないので、controller から切り出して Node のテストで確かめる。
import type { Cockpit } from './model.ts'
import { taskStream, type Tab, type Ui } from './view.ts'

/** 行き来のボタンの data-* 。 */
export type NavClick = { tab?: string; whole?: string; stream?: string; task?: string; req?: string; goto?: string; goarch?: string; back?: string; id?: string }

/**
 * 行き来のボタンを ui に反映する。扱わないボタンは 'none'。
 * 'back' は戻り先の確認へ戻る（呼び出し側が restore のあとに欄の位置を戻す）。
 * cur は要対応でいま開いている確認、scroll は上がる時点の欄の位置を測る関数。
 */
export function navigate(ui: Ui, d: NavClick, c: Cockpit | undefined, cur: string | undefined, scroll: () => Record<string, number>): 'none' | 'moved' | 'back' {
  // 要対応・対応済みの確認から全体のタブへ上がるとき、読んでいた確認と位置を戻り先として 1 つだけ持つ。
  const leave = () => {
    if (ui.tab === 'todo' && cur) ui.back = { tab: 'todo', item: cur, scroll: scroll() }
    else if (ui.tab === 'arch' && ui.curArch && !ui.curArch.startsWith('req:')) ui.back = { tab: 'arch', item: ui.curArch, scroll: scroll() }
  }
  const up = (stream?: string, task?: string, req?: string) => {
    leave()
    ui.tab = 'whole'
    ui.curStream = stream
    ui.curTask = task
    ui.curReq = req
  }
  if (d.back !== undefined) return ui.back ? 'back' : 'none'
  if (d.tab) {
    ui.tab = d.tab as Tab
    // 全体のタブはいつも全体の表から始める（大タスクの画面へはそこから 1 クリック）。
    if (ui.tab === 'whole') ui.curStream = ui.curTask = ui.curReq = undefined
  } else if (d.whole !== undefined) up()
  else if (d.stream !== undefined) up(d.stream)
  else if (d.task) {
    const task = c?.tasks.find((k) => k.id === d.task)
    if (!task || !c) return 'none'
    const sid = taskStream(c, task)
    if (task.state === 'ok') ui.showDone[sid] = true
    up(sid, task.id)
  } else if (d.req) up(undefined, undefined, d.req)
  else if (d.goto) {
    // 上がってきた確認へ下りるときは、戻るのと同じく読んでいた位置に戻す。別の確認へ下りたら戻り先は消す。
    if (ui.back?.tab === 'todo' && ui.back.item === d.goto) return 'back'
    ui.back = undefined
    ui.cur = d.goto
    ui.tab = 'todo'
  } else if (d.goarch) {
    if (ui.back?.tab === 'arch' && ui.back.item === d.goarch) return 'back'
    ui.back = undefined
    ui.curArch = d.goarch
    ui.tab = 'arch'
  } else if (d.id) {
    if (ui.tab === 'arch') ui.curArch = d.id
    else ui.cur = d.id
    if (ui.back && ui.back.item !== d.id) ui.back = undefined
  } else return 'none'
  return 'moved'
}

/** 戻り先の確認を開く。戻した欄の位置を返す（呼び出し側が描いたあとに当てる）。 */
export function restore(ui: Ui): Record<string, number> | undefined {
  const b = ui.back
  if (!b) return undefined
  ui.back = undefined
  ui.tab = b.tab
  if (b.tab === 'todo') ui.cur = b.item
  else ui.curArch = b.item
  return b.scroll
}

/**
 * 描き直したあと先頭に戻す欄。page はパネルのページ全体（パネルは 1 枚のページごと動く）。
 * ワークスペースかタブが変わったら全部、全体のタブで大タスク・タスク・依頼を移ったら詳細と全体の欄とページ、
 * 要対応・対応済みで項目を移ったら詳細だけ（一覧は読んでいた位置に残す）。
 */
export function scrollResets(placeChanged: boolean, itemChanged: boolean, tab: Tab): string[] {
  if (placeChanged) return ['.list', '.wmain', '.detail', 'page']
  if (itemChanged) return tab === 'whole' ? ['.detail', '.wmain', 'page'] : ['.detail']
  return []
}
