import { mount } from '../src/controller.ts'
import type { WindowView } from '../src/protocol.ts'
import { renderWindow, WINDOW_CSS } from '../src/window-view.ts'

const token = document.querySelector<HTMLMetaElement>('meta[name="cockpit-token"]')!.content
let w: WindowView | null = null
let lost = false
let failed: string | undefined

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

/** 結果は SSE で届くので待たない。失敗したときだけ理由を上の帯に出す。 */
function send(url: string, body: unknown): void {
  post(url, body).then(
    () => (failed = undefined),
    (e: Error) => {
      failed = `操作できませんでした: ${e.message}`
      ctl.draw()
    }
  )
}

const ctl = mount(
  {
    op: (input) => post('/api/op', input),
    notify: (root) => post('/api/notify', { root }),
    open: (root, path) => post('/api/open', { root, path }),
    openUrl: (url) => post('/api/openurl', { url }),
    focusAgent: (terminalId, worktree) => post('/api/focus', { terminalId, worktree })
  },
  {
    css: WINDOW_CSS,
    render: (v, ui, now, svg) => {
      const extra = [lost ? '常駐のプロセスに繋がりません' : '', failed ?? ''].filter(Boolean)
      const shown = w && extra.length ? { ...w, errors: [...w.errors, ...extra] } : w
      return renderWindow(shown, v, ui, now, svg)
    },
    onClick: (d) => {
      if (d.ws) {
        send('/api/select', { root: d.ws })
        return !d.goto
      } else if (d.follow !== undefined) send('/api/select', {})
      else if (d.activate !== undefined && w?.view.root) send('/api/activate', { root: w.view.root })
      else return false
      return true
    }
  }
)

let es: EventSource | undefined
function connect(): void {
  es?.close()
  es = new EventSource(`/events?token=${encodeURIComponent(token)}`)
  es.onmessage = (e) => {
    w = JSON.parse(e.data) as WindowView
    lost = false
    ctl.receive(w.view)
    ctl.draw()
  }
  es.onerror = () => {
    lost = true
    ctl.draw()
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
