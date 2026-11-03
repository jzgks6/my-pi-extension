# my-pi-extension

自用的 [Pi coding agent](https://github.com/earendil-works/pi) 本地扩展集合。

每个扩展是一个独立子目录，通过 Pi 的扩展自动发现机制加载（`~/.pi/agent/extensions/*/index.ts`），
不需要构建步骤，TypeScript 直接由 Pi 加载。

**每个扩展怎么装、怎么配、有哪些限制，写在该扩展子目录的 `README.md` 里**，本文件只维护清单和目录约定。

## 扩展清单

| 目录 | 提供的能力 | 状态 |
|---|---|---|
| [`pi-web-access-local/`](./pi-web-access-local/README.md) | `web_search`（Exa 搜索）+ `fetch_content`（本地抓取转 markdown） | 使用中 |
| [`pi-notify-local/`](./pi-notify-local/README.md) | 失焦时的桌面通知：Pi 空闲待输入、权限对话框弹出 | 使用中 |

## 命名约定

自写的本地扩展统一用 `pi-<功能>-local` 形式，`-local` 后缀表示“本机自维护、不从 npm 安装”，与同名的 npm 包区分开（例如本仓库的 `pi-web-access-local` 与 npm 上的 `pi-web-access`）。

## 目录约定

```
my-pi-extension/
├── README.md            # 本文件：扩展清单
├── AGENTS.md            # 本地 agent 规范（提交、脱敏、文档），不进版本库
├── .gitignore
└── <extension-name>/    # 一个扩展一个目录
    ├── README.md        # 这个扩展的细则：安装、配置项、参数、已知限制
    ├── package.json     # 有 npm 依赖时才需要
    ├── config.example.json  # 有配置文件时提供模板，真实配置不提交
    └── *.ts             # 源码，index.ts 是入口
```

## 安装一个扩展

```bash
cp -R <extension-name> ~/.pi/agent/extensions/
cd ~/.pi/agent/extensions/<extension-name> && npm install   # 有依赖时
cp config.example.json config.json && chmod 600 config.json # 有配置时，填入自己的值
```

然后在 Pi 里 `/reload`，或开新会话。

## 新增扩展的步骤

1. 建目录 `<extension-name>/`，写 `index.ts`（默认导出 `(pi: ExtensionAPI) => void`）
2. 写 `<extension-name>/README.md`：怎么装、有哪些配置项（含默认值）、工具/命令参数、已知限制。没有可配项或没有命令就直说，不用凑章节
3. 更新本文件的扩展清单表格
4. 按本地 `AGENTS.md` 的脱敏清单自查后再提交

Pi 扩展 API 文档：`~/.pi/agent/install/releases/<version>/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
