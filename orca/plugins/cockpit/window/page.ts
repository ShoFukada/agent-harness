// 窓のページ。操作は常駐のプロセス（window/server.ts）に送り、全案件の状態は SSE で受け取る。
import { mount } from '../src/controller.ts'
import type { WindowView } from '../src/protocol.ts'

const token = document.querySelector<HTMLMetaElement>('meta[name="cockpit-token"]')!.content
let lost = false
let last: WindowView | undefined

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cockpit-token': token },
    body: JSON.stringify(body)
  })
  const json = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error((json as { error?: string }).error ?? `${r.status}`)
  return json as T
}

const ctl = mount({
  op: (input) => post('/api/op', input),
  talk: (root, item_id, item_rev) => post('/api/talk', { root, item_id, item_rev }),
  notify: (root) => post('/api/notify', { root }),
  open: (root, path) => post('/api/open', { root, path }),
  openUrl: (url) => post('/api/openurl', { url }),
  focusAgent: (terminalId, worktree) => post('/api/focus', { terminalId, worktree }),
  talkStream: (root, stream) => post('/api/talk', { root, stream }),
  clip: (text, format) => post('/api/clip', { text, format }),
  ask: (input) => post('/api/ask', input),
  askLookup: (root, q) => post('/api/asklookup', { root, q }),
  askDecide: (root, ask, answer) => post('/api/askdecide', { root, ask, answer }),
  askTab: (root, ask) => post('/api/asktab', { root, ask })
}, { window: true })

function show(): void {
  if (!last) return
  ctl.receive({ views: last.boards, focused: last.focused, unseen: last.unseen, live: last.live, errors: [...last.errors, ...(lost ? ['常駐のプロセスに繋がりません'] : [])] })
  ctl.draw()
}

let es: EventSource | undefined
function connect(): void {
  es?.close()
  es = new EventSource(`/events?token=${encodeURIComponent(token)}`)
  es.onmessage = (e) => {
    last = JSON.parse(e.data) as WindowView
    lost = false
    show()
  }
  es.onerror = () => {
    lost = true
    show()
    // 常駐のプロセスが起動し直すとトークンが変わり、EventSource は再接続をやめる。ページを読み直して新しいトークンを受け取る。
    if (es?.readyState === EventSource.CLOSED) setTimeout(() => location.reload(), 5000)
  }
}

// 隠れている間は接続を切り、常駐のプロセスが Orca の状態を確かめに行かないようにする。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    es?.close()
    es = undefined
  } else connect()
})
if (!document.hidden) connect()
// 期限の「あと n 時間」と今の時刻の線を、データが変わらなくても 1 分ごとに描き直す。
setInterval(() => ctl.draw(), 60_000)
