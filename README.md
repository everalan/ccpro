# ccpro

在 macOS 上切换 Claude Code 的登录账号，并在列表里显示各账号的剩余额度。

## 安装

需要 Node.js 20 或更高版本，且 `claude` 在 `PATH` 中。

```sh
npm install
npm link
```

## 使用

```sh
ccpro save        # 保存当前登录的账号，邮箱取自账号信息
ccpro             # 选择账号并切换
ccpro --update    # 更新到最新版本
ccpro --version
ccpro --help
```

添加账号时，先保存当前账号，再登录下一个：

```sh
ccpro save
claude auth login    # 不要用 claude auth logout，它会吊销 token
ccpro save
```

切换对整台机器生效。切换后请重开 Claude Code 窗口，用 `claude --resume` 接回对话。

## 账号列表

运行 `ccpro` 会显示已保存的账号和各自的剩余额度：

```
╭─ ccpro · 切换 Claude Code 账号 ───────────────────────────────────╮
│                                                                   │
│   work@example.com ∗  5h ▰▰▰▰▰▰▰▰▰▰▰▱  93%   周 ▰▰▰▰▰▰▰▰▰▰▰▱  95% │
│ ❯ SoulMateuoc@gmx.es  5h ▱▱▱▱▱▱▱▱▱▱▱▱   0%   周 ▰▰▰▰▰▱▱▱▱▱▱▱  40% │
│   old@example.com     额度未知                                    │
│                                                                   │
├───────────────────────────────────────────────────────────────────┤
│ SoulMateuoc@gmx.es · 5h 额度 19:23 重置 · 周额度 11-09 重置       │
╰─ ↑↓ 选择 · 回车切换 · Esc 取消 ───────────────────────────────────╯
```

- `∗` 标出当前登录的账号，这一行用绿色显示。还没保存过的当前账号也会列出来，切换前会自动保存。
- `5h` 是 5 小时额度，`周` 是本周额度。进度条和百分比都表示剩余量：剩余 50% 及以上为绿色，20% 到 49% 为黄色，低于 20% 为红色。百分比的颜色跟所在行一致。
- 底部一行显示光标所在账号的重置时间。重置时间不在今天时，会带上日期，例如 `11-04 02:05`。时间统一按北京和新加坡时间（UTC+8）显示，不受电脑时区设置影响。
- 额度在后台查询，查询中显示转圈动画。查询失败或登录已失效时显示“额度未知”，不影响切换。
- 光标默认停在第一个非当前账号上。用 ↑↓ 选择，回车切换，Esc 或 Ctrl+C 取消。
- 终端太窄时，过长的邮箱会用 `…` 截断。设置了环境变量 `NO_COLOR` 时不显示颜色。

## 工作方式

每个已保存的账号是一个目录 `~/.ccpro/profiles/<email>/`，加上一条钥匙串记录，也就是 Claude Code 给这个 `CLAUDE_CONFIG_DIR` 使用的 `Claude Code-credentials-<hash>`。

切换时，ccpro 持有 Claude Code 使用的锁，依次执行：

1. 把当前账号的最新 token 写回它的目录对应的钥匙串记录。refresh token 会轮换，只有在用的这份一定有效。
2. 替换默认钥匙串记录里的 `claudeAiOauth`，同一条记录里的 `mcpOAuth` 不动。
3. 替换 `~/.claude.json` 里的 `oauthAccount`。如果这一步失败，第 2 步会回滚。

列表里的额度来自 `claude -p /usage`：当前账号用默认配置，其他账号用各自的 `CLAUDE_CONFIG_DIR`，token 刷新由 Claude Code 自己完成。查询不消耗模型额度，每个账号约需 4 秒，并行执行。查询过程中 Claude Code 可能会刷新 token，所以选定账号后，ccpro 会等这些查询结束再切换，确保挪动的是刷新后的 token。

## 限制

- 依赖 Claude Code 的内部存储格式和 `/usage` 的英文输出，Claude Code 升级后可能需要调整。额度解析不出来时显示“额度未知”，不影响切换。
- 重置时间只按 UTC+8（北京、新加坡）处理，其他时区下显示的时间会不对。
- 在 ccpro 之外用 `claude auth login` 换账号前，先运行 `ccpro save`，否则原账号之后轮换过的 token 会丢失，需要重新登录。
- `--update` 通过 `npm install -g` 更新，包发布到 npm 之后才能使用。

## 测试

```sh
npm test
```

测试使用 `test/helpers/bin` 里的 `security`、`claude` 和 `npm` 替身，不接触真实钥匙串。这些替身在 `HOME` 不是测试沙盒时会直接退出。
