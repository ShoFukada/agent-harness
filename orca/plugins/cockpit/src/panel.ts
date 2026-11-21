// サイドバーのパネル。操作のつなぎは controller.ts、ファイルと端末は worker が受け持つ。
import { mount } from './controller.ts'

const ctl = mount({
  op: (input) => orca.plugin.request('cockpit.op', input),
  notify: () => orca.plugin.request('cockpit.notify'),
  open: (_root, path) => orca.plugin.request('cockpit.open', { path }),
  // 押した操作の中で呼ぶ（Orca はクリックやキー操作の中でしか外部のブラウザを開かせない）。初めてのホストは Orca が確かめる。
  openUrl: async (url) => (orca.shell ? orca.shell.openExternal(url) : { opened: false, reason: 'この Orca では外部のブラウザを開けません' }),
  focusAgent: async (terminalId) => (terminalId ? orca.plugin.request('cockpit.focus', { terminalId }) : { focused: false })
})

orca.plugin.on('cockpit.changed', (next) => {
  ctl.receive(next)
  ctl.draw()
})
void orca.plugin.request('cockpit.get').then((next) => {
  ctl.receive(next)
  ctl.draw()
})
