// サイドバーのパネル（前面の案件 1 つ）。操作のつなぎは controller.ts、ファイルと端末は worker が受け持つ。
import { mount } from './controller.ts'
import type { CockpitView } from './protocol.ts'

const ctl = mount(
  {
    op: (input) => orca.plugin.request('cockpit.op', input),
    talk: (root, item_id, item_rev) => orca.plugin.request('cockpit.talk', { root, item_id, item_rev }),
    notify: () => orca.plugin.request('cockpit.notify'),
    open: (_root, path) => orca.plugin.request('cockpit.open', { path }),
    // 押した操作の中で呼ぶ（Orca はクリックやキー操作の中でしか外部のブラウザを開かせない）。初めてのホストは Orca が確かめる。
    openUrl: async (url) => (orca.shell ? orca.shell.openExternal(url) : { opened: false, reason: 'この Orca では外部のブラウザを開けません' }),
    focusAgent: async (terminalId) => (terminalId ? orca.plugin.request('cockpit.focus', { terminalId }) : { focused: false }),
    clip: (text, format) => orca.plugin.request('cockpit.clip', { text, format })
  },
  { panel: true }
)

const show = (v: CockpitView) => {
  ctl.receive({ views: v.root ? [v] : [], errors: v.state === 'missing' ? [] : v.errors })
  ctl.draw()
}
orca.plugin.on('cockpit.changed', show)
void orca.plugin.request('cockpit.get').then(show)
setInterval(() => ctl.draw(), 60_000)
