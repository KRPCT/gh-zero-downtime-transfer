# 已核验事实与陷阱

事实来自 `docs.github.com` 的「Transferring a repository」与 `rest/repos` 文档，以及一次真实转移（私有仓库、org→org、两个 cron workflow）的实测。标注「实测」的条目本机验证过；标注「文档」的是官方声明但本机未独立复现。

## 执行入口

- REST 端点存在：`POST /repos/{owner}/{repo}/transfer`，202 Accepted。**不是只能网页点**——常见误解。
- 字段名是 `new_owner`。写成 `newowner` 返回 422 `Invalid request. "new_owner" wasn't supplied.`（实测）
- 转入组织：需要「对该仓库有 admin」+「在目标组织有建仓库权限」，满足即即时生效，无需邮件确认（实测）。
- 转给个人账号：对方收到确认邮件，1 天内不接受则过期（文档）。
- 目标组织「成员可建仓库」是 org 开关，无 `admin:org` 作用域时查不到。角色=member 时不能自动判定可行与否，须人工确认或请 owner 代跑（实测：`GET /orgs/{org}/actions/permissions` 会 403）。

## 随仓库过去 / 不过去

随仓库转移（文档 + 实测）：webhooks、services、**secrets**、deploy keys、issues、pull requests、wiki、stars、watchers、fork 网络关系、Git LFS 对象（后台搬运，量大时耗时）、提交与 GPG 签名（实测转移后 `verified=true` 不变）。

需要注意的丢失：

- 组织→个人方向，只读协作者不转移（个人仓库无只读档）。
- 部分方向的 issue assignee 被清空；org→org 也可能移除 issue types（文档）。
- **GitHub Pages 不做 URL 重定向**（只重定向仓库网页与 git 链接）。
- 包（Packages）可能失去与仓库的链接，取决于注册表。

## 重定向与名称退役

- 指向旧位置的所有网页与 git 链接自动重定向；`clone`/`fetch`/`push` 都跟着走（文档 + 实测：`git ls-remote` 旧 URL 返回与新 URL 相同 sha）。
- **一旦在旧位置创建同名仓库或 fork，指向已转移仓库的重定向被永久删除**（文档）。这条决定了「先转移、后在旧 org 建同名仓库」是危险操作。
- 名称退役：若仓库含 GitHub Marketplace 列出的 Actions，或转移前一周内 >100 次 clone 或 >100 次 Actions 使用，转移会**永久退役** `OWNER/REPO` 组合，之后无法在该位置重建同名仓库（文档）。低流量定时任务通常远低于该阈值（实测：每日 2–3 跑 ≈ 23 次/周）。
- API 层重定向会让「目标位置是否被占用」的探测返回 200 且 `full_name` 指向别处——那是重定向，不是占用。判占用必须比对 `full_name` 与请求路径（实测踩过）。

## 定时任务（本 skill 的核心关切）

- 文档没有说转移会停用 scheduled workflow；实测 org→org 后两个 workflow 仍 `state: active`，cron 未断。
- 但**不要靠文档下结论**：组织级 Actions 策略可能只允许本地 actions 或整体禁用，转移后仓库会受目标 org 的默认 Actions 设置与成员资格权限约束（文档）。唯一可信判定是**跑一次**。
- scheduled workflow 有一个「actor」= 最后一次修改 cron 的用户。若该用户失去仓库访问权或被停用，定时任务不会跑。跨 org 转移时确认 actor 在目标 org 仍有访问权（文档；企业托管账号 EMU 场景另有约束）。
- 已停用的 scheduled workflow 的复活方式：由有 write 权限的人提交一次**改动 cron 表达式**的提交（文档）。
- 公开仓库满 60 天无活动会自动停用 scheduled workflow；**私有仓库无此规则**（文档）。转 public 后要把它算进风险。
- 高负载时排队的 scheduled 任务可能被静默丢弃，且无官方通知（文档）。这就是为什么长期跑的定时任务应该自带 dead-man switch。

## 可见性与计费

- 转移保留可见性（实测 private → private）。
- 私有仓库的 Actions 分钟数计入**新 owner** 的额度；org 免费计划同样 2000 分钟/月。
- 私有仓库转给 GitHub Free 账号会失去受保护分支、Pages 等能力（文档）。
- 私有仓库在 `raw.githubusercontent.com` 匿名访问返回 404，**不代表文件缺失**。核验资产用 `gh api repos/{owner}/{repo}/contents/<path>`（实测踩过）。

## 代码里的 owner 硬编码

转移后最容易漏的是写死 owner 的字符串。扫描范围要覆盖整个工作树，不只是 README 和 workflow：

- 功能性引用（运维脚本默认仓库、部署目标、镜像 tag）→ 必须改。
- 测试夹具（stub 的 `GITHUB_REPOSITORY`、示例 deploymentName）→ 通常无断言依赖，可留；改它属 churn。
- 运行时由平台注入的值（如 Actions 的 `GITHUB_REPOSITORY`）→ 自动跟着变，不用改。

逐条判定，不要一把 sed。

## 与历史改写的相互影响

- force-push 改写历史不影响 cron（cron 只看默认分支 tip 的 workflow 文件）。
- 若同时有「改写历史」和「转移」两件事，先做内容工作再转移，可以少一次跨位置协调；反过来也行，只是 force-push 要打到新远端。
- 改写含 GPG 签名的历史时，`git commit-tree` **不遵循** `commit.gpgsign`，必须显式 `-S`，否则整段变 Unverified。普通 `git commit` / `cherry-pick` / `--amend` 遵循配置。
- 校验 squash 是否零漂移要比树哈希：`git rev-parse <a>^{tree}`。拿 squash 前的**旧 tip** 做 `git diff --stat` 会显示全部改动，那是基线选错，不是回归。
