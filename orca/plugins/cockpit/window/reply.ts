// メインが話したいことへの回答を .orca/cockpit.talk.json に追記する入口。
// 窓の常駐のプロセスと同じ appendReply（ロック → 読み直し → 保存）を通すので、同時に書いても片方が消えない。
// 使い方: node <このファイル> <ワークスペースの root> <発言の op_id> < 回答の本文
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseUserLog, textError } from '../src/model.ts'
import { appendReply } from '../src/store.ts'

export async function reply(root: string, opId: number, text: string): Promise<void> {
  const body = text.trim()
  if (!body) throw new Error('回答の本文が空です（標準入力に書いてください）')
  const bad = textError(body)
  if (bad) throw new Error(bad)
  const log = parseUserLog(readFileSync(path.join(root, '.orca', 'cockpit.user.json'), 'utf8'))
  if (!log.ops.some((o) => o.op_id === opId && o.type === 'talk')) throw new Error(`話したいの発言 ${opId} が cockpit.user.json にありません`)
  await appendReply(root, { op_id: opId, at: new Date().toISOString(), by: 'main', text: body })
}

if (import.meta.main) {
  const [root, id] = process.argv.slice(2)
  const opId = Number(id)
  if (!root || !Number.isInteger(opId)) {
    console.error('使い方: node reply.ts <ワークスペースの root> <発言の op_id> < 回答の本文')
    process.exit(2)
  }
  reply(path.resolve(root), opId, readFileSync(0, 'utf8')).then(
    () => console.log(`追記しました: op ${opId}`),
    (e: Error) => {
      console.error(e.message)
      process.exit(1)
    }
  )
}
