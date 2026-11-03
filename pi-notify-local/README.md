# pi-notify-local

给 Pi coding agent 的桌面通知，只在终端失焦时发，共两条：

| 触发 | 标题 | 正文 |
|---|---|---|
| `agent_settled`：Pi 不再自己继续，等你输入 | `IDLE` | 无 |
| `permissions:ui_prompt`：权限对话框即将弹出 | `Needs Approval` | 工具名，如 `bash` |

正文为空时通知只显示标题行。通知由 Ghostty 显示，归属于 Ghostty，点一下回到对应的终端窗口。

## 为什么走 OSC 777 而不是 osascript

`osascript -e 'display notification ...'` 也能弹通知，但通知的 identifier 属于 Script Editor
宿主进程，扩展拿不到也删不掉，于是每条都永久留在通知中心；此外还要处理 AppleScript 字符串转义，
并且每次通知都要起一个子进程。

Ghostty 从 1.1.0 起支持 rxvt 的 OSC 777 通知协议（配置项 `desktop-notifications` 默认开启），
所以这里直接在 stdout 写一段转义序列：没有子进程，没有转义问题，而且**通知的生命周期由 Ghostty
托管**——该 surface 重新获得焦点时从通知中心清除，聚焦状态下投递的通知几秒后自动删除。

## 安装

```bash
cp -R pi-notify-local ~/.pi/agent/extensions/
```

没有 npm 依赖，不需要 `npm install`，也不需要配置文件：扩展直接读 Pi 自己的
`~/.pi/agent/settings.json`。装完在 Pi 里 `/reload`，或开新会话。

## 配置项

全部可选，写在 `~/.pi/agent/settings.json` 的 `piNotify` 对象里，缺省即用默认值：

| 键 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 后不再发任何通知 |
| `unfocusedActivityThresholdSecs` | `30` | 仅在终端不上报焦点时使用的兜底：超过这么多秒没有键盘输入才当作失焦 |

```json
{
  "piNotify": {
    "enabled": true,
    "unfocusedActivityThresholdSecs": 30
  }
}
```

改完 `/reload` 生效；整个 `piNotify` 对象不存在时也能正常工作。

## 工具与命令

没有。这个扩展不注册任何工具或斜杠命令，只订阅上面两条事件。

（原先的 `/notify-test` 已移除：命令只能在有焦点的终端里敲，必然被失焦 gate 拦住，
看不到实际效果，留着只会误导。）

## 已知限制

- **只支持 Ghostty**。判定条件是 `TERM_PROGRAM=ghostty` 且 stdout 是 TTY；其他终端、
  `pi -p` / JSON 模式、ssh 会话下一律静默不发。要支持别的终端就改 `notifier.ts` 里的
  `supported()`。
- **聚焦时不发**。刻意的：你正看着 Pi 就不需要被告知它在做什么；而且 Ghostty 会丢弃聚焦状态下
  投递的横幅（约 3 秒后连历史一起删除），发了也看不见。
- 权限通知依赖 `@gotgenes/pi-permission-system` 广播的 `permissions:ui_prompt`。没装这个扩展
  就没有这条通知；被策略自动放行（`policy_allow`、`session_approved`、`auto_approved` 等）
  的请求不广播该事件，同样不会通知。
- 通知的副标题由 Ghostty 填成该终端窗口的标题（Pi 设的 `π — <目录名>`），扩展无法控制。
- 只覆盖两条事件：不通知工具调用、后台任务、会话开始/结束。
