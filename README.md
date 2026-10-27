# gh-zero-downtime-transfer

转移 GitHub 仓库（换 owner / 迁进组织），而不打断已经部署好的 Actions 定时任务。

一个 Qoder skill，附带两个可直接跑的脚本。核心不是「怎么点转移按钮」，而是**转移前后到底哪些东西会坏**——这件事官方文档讲得不完整，社区经验又常常是错的。

## 为什么需要它

仓库转移看起来是个按钮，实际会牵动：cron 调度、Actions secrets、通知投递、旧 URL 重定向、代码里写死的 owner 字符串、组织级 Actions 策略。其中几条**没有任何报警**：

| 常见假设 | 实际 |
| --- | --- |
| 转移只能网页上点 | 有 REST 端点：`POST /repos/{owner}/{repo}/transfer`，字段名 `new_owner`（写成 `newowner` 返回 422） |
| 文档没提 cron 会停，所以不会停 | 文档既没写会停也没写不会停；组织级 Actions 策略还可能限制第三方 action。**唯一可信判定是转移后实跑一次** |
| 旧 URL 会一直重定向 | 在旧位置建同名仓库或 fork，会**永久删除**整条重定向链 |
| 目标位置返回 404 才算没被占用 | 已转移的旧位置返回 200 且 `full_name` 指向别处——那是重定向，不是占用。判占用必须比对 `full_name` |
| 私有仓库文件 404 说明丢了 | `raw.githubusercontent.com` 对私有仓库匿名访问本来就 404 |
| secrets 会丢 | secrets、webhooks、deploy keys、issues、PRs、GPG 签名验证都随仓库走 |
| 改完 README 和 workflow 就够了 | 最容易漏的是运维脚本里写死的 `REPO="旧owner/..."`，要扫整个工作树 |

## 安装

`SKILL.md` 是入口，仓库根目录即 skill 目录。把本仓库接到 Qoder 的技能发现路径上：

```sh
git clone https://github.com/KRPCT/gh-zero-downtime-transfer.git
```

**Linux / macOS**（技能根为 `~/.agents/skills/`）：

```sh
ln -s "$PWD/gh-zero-downtime-transfer" ~/.agents/skills/gh-zero-downtime-transfer
```

**Windows**（用 junction，不需要管理员权限；`mklink /J` 或 PowerShell）：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.agents\skills\gh-zero-downtime-transfer" `
  -Target "$env:USERPROFILE\Documents\GitHub\gh-zero-downtime-transfer"
```

若 `~/.agents/skills` 本身是指向某个 git 仓库的符号链接（例如 `~/AGENTS/.agents/skills`），把链接加进该仓库的 `.git/info/exclude`，避免污染 tracked 文件：

```
.agents/skills/gh-zero-downtime-transfer/
```

装好后重启会话或 `/skills reload`，用 `/skills list` 确认 `gh-zero-downtime-transfer` 出现。

需要 Node 20+、Git 与已登录的 `gh`（`gh auth login`）。脚本纯本地运行，不联网上传任何东西；除 `--dispatch` 外全部只读。

## 用法

### 1. 转移前审计（只读）

```sh
node scripts/preflight.mjs octo/repo --to new-owner --local ./repo --json preflight.json
```

退出码 1 = 有阻断项。九项检查：

- 仓库元数据（是否 fork、是否归档）
- 目标位置占用（区分真占用与重定向）
- 我在目标组织的角色与成员状态
- workflow 清单与 `active` 状态
- 每条 cron 的下次 UTC 触发时刻与距今余量
- Actions secrets / variables 名称
- issues / releases 可读性
- 近 7 天 Actions 用量（对照名称退役阈值 100）
- 工作树里写死旧 owner 的位置
- 默认分支保护规则

`--json` 产出的清单留给第 4 步做逐项比对。

### 2. 执行转移

```sh
gh api -X POST repos/octo/repo/transfer -F new_owner=new-owner
```

转入组织且权限齐 → 202 即时生效。转给个人账号 → 对方收确认邮件，1 天内须接受。

### 3. 转移后核验（默认只读）

```sh
node scripts/verify.mjs octo/repo new-owner/repo --manifest preflight.json
```

逐项比对：仓库 id（证明是转移而非复制）、可见性、默认分支、API 与 git 两层重定向、workflow 集合与 active、secrets/variables 名称集合、issues。

### 4. 端到端实跑（写操作，需显式开启）

```sh
node scripts/verify.mjs octo/repo new-owner/repo --manifest preflight.json \
  --dispatch sentinel.yml --timeout 300
```

元数据全 PASS 不等于链路可用。**挑靶子的原则**：优先只读型 workflow（活性检查、报告类）；若任务会调外部服务，挑幂等或自带去重的；绝不要拿「会发通知/会改数据且无去重」的任务当验证。

跑成功还要看日志确认行为符合预期——否则可能掩盖「其实什么都没做」。

## 剩下的两步靠人

脚本能证明「现在可用」，但有两件事它做不到：

1. **观察下一个真实 cron**。只有它能证明调度器仍认这个仓库。若通知投递本身是产品功能，job 绿灯不算通过。
2. **组织级 Actions 策略**。没有 `admin:org` 作用域时该 API 返回 403，脚本查不到目标 org 是否限制第三方 action——只能靠第 4 步实跑判定。

完整七步（含窗口选择、与历史改写的先后关系、回退路径）见 [`references/sop.md`](references/sop.md)；已核验的 GitHub 行为与陷阱清单见 [`references/facts-and-traps.md`](references/facts-and-traps.md)。

## 不适用范围

- 从零建新仓库、把内容 push 到新位置（那不是转移，没有 id 继承与重定向）。
- GitHub Enterprise Importer / `gh gei` / GHE 迁移归档——那条路径上 scheduled workflow **导入后不会自动跑**，需要一次提交重新激活，语义与本 skill 不同。
- 单纯改本地 `git remote` 名字。
- GitLab / Bitbucket。

## 验证情况

两个脚本都在一次真实的私有仓库 org→org 转移上跑通：预检正确区分了「旧位置的重定向」与「真占用」；核验在 11 项上 PASS，并通过 `--dispatch` 真实触发并完成了一次 workflow（`conclusion: success`）。

写作过程中被实测纠正的自身缺陷：`--to` 的值曾被当成位置参数；目标占用判定曾把重定向误报为冲突；dispatch 曾错用 `/runs`（只读列表端点）而非 `/dispatch`，且 raw API 在本地凭据下 404，最终改用 `gh workflow run`。

## License

MIT
