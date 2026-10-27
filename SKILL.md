---
name: gh-zero-downtime-transfer
description: 把 GitHub 仓库从一个 owner 转移到另一个 owner/组织，而不中断已部署的 Actions 定时任务（cron、secrets、通知投递链路）。提供只读预检、转移后逐项核验、以及实测过的 API 行为与陷阱清单。当用户要把仓库换 owner、迁进新组织、在转移前后改写 README/历史、提到「转移后 cron 会不会停」「secrets 还在吗」「旧链接能不能继续用」，或要判断某次 transfer 是否安全时使用。不用于从零建新仓库、clone 镜像同步、GHE 迁移工具（gh gei / migrator）与本地 git remote 改名（那属普通改配置）。
---

# GitHub 仓库零中断转移

把「转移仓库」当成一次**生产变更**来做：先审计，再执行，后端到端验证，最后观察真实 cron。Pele 是渲染器不是流程引擎——同理，本 skill 提供判定与证据，不替你决定何时该停手。

基线：GitHub REST `POST /repos/{owner}/{repo}/transfer`；实测环境为私有仓库、org→org、两个 schedule 触发的 workflow。核验日期 2026-10-27。

## 选择工作路径

| 当前任务 | 按需读取 |
| --- | --- |
| 判断能不能转、要准备什么 | [references/sop.md](references/sop.md)（七步运行手册） |
| GitHub 到底保留什么、重定向与名称退役规则、cron 会不会停 | [references/facts-and-traps.md](references/facts-and-traps.md) |
| 执行前审计 | `scripts/preflight.mjs`（只读） |
| 执行后核验 | `scripts/verify.mjs`（默认只读，`--dispatch` 为写操作） |

需要 Node 20+ 与已登录的 `gh`。脚本不自动安装依赖、不写仓库内容。

## 执行流程

1. **定顺序**。内容与转移互不阻塞；force-push 不影响 cron。选一个先做，别两边各推一半。
2. **预检**。`node scripts/preflight.mjs <owner/repo> --to <target> --local <本地路径> --json preflight.json`。退出码 1 表示有阻断项。带上 `--local`，工作树里写死旧 owner 的字符串是转移后最常漏的功能性失效。
3. **选窗口**。看预检打印的下次 cron 时刻，留 30 分钟以上余量，避免一次 run 跨越转移点。
4. **执行**。`gh api -X POST repos/<owner>/<repo>/transfer -F new_owner=<target>`。字段名是 `new_owner`，写成 `newowner` 会 422。转入组织且权限齐则即时生效。
5. **核验元数据**。`node scripts/verify.mjs <old> <new> --manifest preflight.json`。逐项比对 id、可见性、默认分支、API 与 git 两层重定向、workflow 集合与 active、secrets/variables 名称集合。
6. **端到端验证**。元数据全 PASS 不等于链路可用。用 `--dispatch <workflow>` 真跑一次——这是写操作，挑一个只读型或幂等（自带去重）的 workflow 当靶子，绝不要拿「会发通知/会改数据且无去重」的任务。跑成功还要看日志确认行为符合预期，否则可能掩盖「其实什么都没做」。
7. **更新引用**。`git remote set-url`，再按预检列出的硬编码逐条判定：功能性引用须改，测试夹具通常可留。
8. **观察下一个真实 cron**。只有它能证明调度器仍认这个仓库。若通知投递是产品功能，job 绿灯不算通过。

完成条件：预检无阻断项；verify 全 PASS 且至少一次 `--dispatch` 真实成功；本地远端与硬编码引用已对齐；下一个 cron 窗口被确认或被 dead-man switch 覆盖。

## 始终保留的判断边界

- **不要靠文档断言「转移不会停 cron」**。官方文档没写它会停，也没写它不会停；组织级 Actions 策略还可能限制第三方 actions。唯一可信判定是转移后实跑一次。
- **重定向不是持久保障**。在旧位置创建同名仓库或 fork 会**永久删除**指向已转移仓库的重定向。转移后不要在旧位置重建同名仓库。
- **名称可能退役**。转移前一周 >100 次 clone 或 >100 次 Actions 使用，或含 Marketplace 列出的 actions，会让 `OWNER/REPO` 组合被永久退役。预检会报这一项。
- **scheduled workflow 有 actor**。最后一次修改 cron 的用户若失去仓库访问权，定时任务不跑。跨 org 转移时确认该人在目标 org 仍有权限。
- **私有仓库的 `raw.githubusercontent.com` 匿名 404 属正常**，不代表文件丢失；核验资产走 `gh api .../contents/<path>`。
- **目标位置探测要区分重定向与占用**。`GET /repos/<target>/<name>` 对已转移的旧位置返回 200 且 `full_name` 指向别处——那是重定向。只有 `full_name` 与请求路径一致才是真占用（`preflight.mjs` 已按此判定）。
- **转 public 会改变两条规则**：Actions 分钟数不再计费，但公开仓库满 60 天无活动会自动停用 scheduled workflow。转之前先过公开面（描述、topics、README 首屏、LICENSE、本机路径与用户名残留）。
- **转移可原路转回**，但重定向链跟着反向、旧位置一旦被占就回不去；要回退越早越干净。

## Resources

- `scripts/preflight.mjs` — 只读预检，九项审计 + 可绑定的 JSON 清单。退出码 1 = 有阻断项。
- `scripts/verify.mjs` — 转移后逐项核验，`--manifest` 绑定预检清单，`--dispatch` 端到端实跑（写操作，需显式传入）。
- `references/sop.md` — 七步运行手册，含窗口选择、靶子挑选原则、回退说明。
- `references/facts-and-traps.md` — 已核验的 GitHub 行为：随仓库转移/丢失的东西、重定向与名称退役、定时任务语义、可见性与计费、owner 硬编码分类、与历史改写的相互影响。
