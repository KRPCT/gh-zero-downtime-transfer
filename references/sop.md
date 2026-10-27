# 零中断转移 SOP

按顺序执行。第 1、4 步用本 skill 的脚本，其余是判定与人工动作。

## 0. 定顺序

先想清楚两件事的先后：**内容改写**（README、历史 squash、代码迁移）与**转移**。

- 内容工作先做完再转移：只在新位置推一次，转移时交付的是终态。
- 转移先做：后续推送直接打新远端。
- 两者互不阻塞。force-push 不影响 cron，转移不改 git 历史。

选一个即可，别两边各推一半。

## 1. 预检（只读）

```sh
node scripts/preflight.mjs <owner/repo> --to <target-owner> --local <本地仓库路径> --json preflight.json
```

退出码 1 = 有阻断项，先解决。`--local` 会扫工作树里写死旧 owner 的地方，强烈建议带上。

脚本查的九项：仓库元数据（含是否 fork/归档）、目标位置占用（区分重定向与真占用）、我在目标组织的角色、workflow 清单与 active 状态、每条 cron 的下次触发时刻、secrets 与 variables 名称、issues/releases 可读、近 7 天 Actions 用量（名称退役阈值）、默认分支保护。

人工补判两件事，脚本查不到：

- 目标 org 的 Actions 策略是否限制第三方 actions（无 `admin:org` 时 API 403）。只能靠第 4 步实跑判定。
- 目标 org 是否允许 member 建仓库（角色=member 时脚本给 WARN）。

## 2. 选窗口

看预检输出的下次 cron 时刻。转移本身是秒级的元数据操作，但**要避开「正在跑」的窗口**：一次 run 跨越转移时刻，日志与产物归属容易讲不清。留 30 分钟以上余量。

同时确认：这次转移后到下一次 cron 之间，你是否有别的历史改写要推。有，就先推完。

## 3. 执行转移

```sh
gh api -X POST repos/<owner>/<repo>/transfer -F new_owner=<target-owner>
```

`new_owner` 拼错会 422。转入组织且权限齐 → 202 后立即生效；转个人 → 等对方点邮件确认。

等几秒再进下一步，别假设瞬时完成。

## 4. 核验（关键步骤，别跳）

```sh
node scripts/verify.mjs <old-owner>/<repo> <new-owner>/<repo> --manifest preflight.json
```

逐项比对 id（证明是转移不是复制）、可见性、默认分支、API 与 git 两层重定向、workflow 集合与 active、secrets/variables 名称集合、issues。

**元数据全 PASS 不等于链路可用。** 必须端到端跑一次：

```sh
node scripts/verify.mjs <old>/<repo> <new>/<repo> --manifest preflight.json \
  --dispatch <一个安全的 workflow> --timeout 300
```

`--dispatch` 是写操作，会真跑。挑靶子的原则：

- 首选只读型 workflow（活性检查、报告类）。
- 若是会调外部服务的任务，挑**幂等或自带去重**的：例如当天已跑过的签到，重跑会命中去重判 `skipped` 且真静默，不会重复推送、不会二次签到。
- 绝不要拿「会发通知/会改数据且无去重」的任务当验证靶子。

跑成功还不够，要看日志确认行为符合预期（例如确实输出 `result=skipped`），否则可能掩盖「其实什么都没做」。

## 5. 更新本地与外部引用

```sh
git remote set-url <remote-name> https://github.com/<new-owner>/<repo>.git
git fetch --prune
```

重定向会让旧 URL 继续可用，但官方明确建议更新，且**在旧位置建同名仓库会永久删掉重定向**。别把可用性押在重定向上。

再扫一遍第 1 步列出的硬编码 owner，区分功能性引用与测试夹具后逐条处理。

## 6. 观察下一个真实 cron

脚本能证明「现在可用」，只有下一次定时触发能证明「调度器仍认这个仓库」。到点后确认：

- run 出现且 conclusion 正常；
- 通知真的送达（若通知投递是产品功能，job 绿灯不算通过）；
- 自带 dead-man switch 的话，确认它没有误报。

若 scheduled workflow 意外不跑：确认 actor（最后改 cron 的人）在目标 org 仍有访问权，然后由有 write 权限的人提交一次改动 cron 的提交复活。

## 7. 可选：改可见性

转 public 是独立决定，会改变两条规则：Actions 分钟数不再计费，但**60 天无活动会自动停用 scheduled workflow**。转之前把公开面过一遍：描述、topics、README 首屏、英文摘要、LICENSE 是否与新定位矛盾；仓库内是否残留本机路径、用户名、私有项目名。

## 回退

转移可以原路转回（同一端点，`new_owner` 填旧 owner），但重定向链会跟着反过来，且旧位置一旦被占用就回不去。真要回退，越早越干净。

平台元数据之外没有自动回滚：secrets 值不会丢（随仓库走），但你在第 5 步手改的引用要手动改回。
