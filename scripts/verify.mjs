#!/usr/bin/env node
// 转移后核验：逐项比对 preflight 清单，证明 secrets/workflows/调度/issues 真的随仓库过来了。
// 默认只读。--dispatch 会真的触发一次 workflow 运行（写操作），需显式传入。
// 用法: node scripts/verify.mjs <old-owner/repo> <new-owner/repo> [--manifest <preflight.json>] [--dispatch <workflow-file>] [--timeout <sec>]

import { execFileSync } from 'node:child_process';

const USAGE =
  '用法: node scripts/verify.mjs <old-owner/repo> <new-owner/repo> [--manifest <preflight.json>] [--dispatch <workflow-file>] [--timeout <sec>]';

function gh(args) {
  try {
    const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, data: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    const text = (e.stderr || e.stdout || e.message || '').toString();
    const m = /"status":\s*(\d+)/.exec(text) || /HTTP (4\d\d|5\d\d)/.exec(text);
    return { ok: false, code: m ? Number(m[1]) : 0, message: text.split('\n')[0].slice(0, 160) };
  }
}

function sh(cmd, args) {
  try {
    return { ok: true, data: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, message: ((e.stderr || '') + '').split('\n')[0].slice(0, 160) };
  }
}

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['manifest', 'dispatch', 'timeout']);
const pos = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    if (VALUE_FLAGS.has(k)) opts[k] = argv[++i];
    else opts[k] = true;
  } else pos.push(a);
}
if (pos.length !== 2) {
  console.error(USAGE);
  process.exit(2);
}
const [oldRepo, newRepo] = pos;

let manifest = null;
if (opts.manifest) {
  try {
    manifest = JSON.parse((await import('node:fs')).readFileSync(opts.manifest, 'utf8'));
  } catch (e) {
    console.error(`读不到清单 ${opts.manifest}：${e.message}`);
    process.exit(2);
  }
}

const results = [];
let fails = 0;
let warns = 0;
const rec = (level, id, text) => {
  results.push({ level, id, text });
  if (level === 'fail') fails++;
  if (level === 'warn') warns++;
  console.log(`${level === 'fail' ? 'FAIL' : level === 'warn' ? 'WARN' : 'PASS'}  ${id}  ${text}`);
};

// 1. 新位置可达，且与清单里的 id 一致（证明是转移而不是复制）
const now = gh([`repos/${newRepo}`]);
if (!now.ok) {
  console.error(`新位置 ${newRepo} 读不到（HTTP ${now.code}）：${now.message}`);
  console.error('转移可能尚未生效或未完成，稍后重跑本脚本。');
  process.exit(1);
}
const expectedId = manifest?.items?.repo?.id;
if (expectedId && now.data.id !== expectedId) {
  rec('fail', 'repo.identity', `id 不匹配：新仓库=${now.data.id}，清单=${expectedId} —— 这不是同一仓库的转移结果`);
} else {
  rec('pass', 'repo.identity', `${newRepo} id=${now.data.id}${expectedId ? '（与清单一致，确为转移）' : '（未提供清单，无法比对 id）'}`);
}
if (manifest) {
  const m = manifest.items.repo;
  rec(
    now.data.private === m.private ? 'pass' : 'fail',
    'repo.visibility',
    `可见性=${now.data.private ? 'private' : 'public'}，清单=${m.private ? 'private' : 'public'}`,
  );
  rec(
    now.data.default_branch === m.default_branch ? 'pass' : 'fail',
    'repo.default_branch',
    `默认分支=${now.data.default_branch}，清单=${m.default_branch}`,
  );
}

// 2. 旧位置重定向到新位置（API 层与 git 层都要通）
const oldApi = gh([`repos/${oldRepo}`]);
if (!oldApi.ok) {
  rec('warn', 'redirect.api', `旧位置 ${oldRepo} 读取失败（HTTP ${oldApi.code}）——私有仓库匿名 404 属正常，用认证态仍不通才需查`);
} else if ((oldApi.data.full_name || '').toLowerCase() === newRepo.toLowerCase()) {
  rec('pass', 'redirect.api', `API 层 ${oldRepo} → ${oldApi.data.full_name} 重定向生效`);
} else {
  rec('fail', 'redirect.api', `${oldRepo} 解析到 ${oldApi.data.full_name}，不是 ${newRepo}——旧位置可能被新仓库占掉了，重定向链已断`);
}
const [oOwner, oName] = oldRepo.split('/');
const gitOld = sh('git', ['ls-remote', `https://github.com/${oOwner}/${oName}.git`, 'HEAD']);
const gitNew = sh('git', ['ls-remote', `https://github.com/${newRepo}.git`, 'HEAD']);
if (gitOld.ok && gitNew.ok && gitOld.data.split(/\s+/)[0] === gitNew.data.split(/\s+/)[0]) {
  rec('pass', 'redirect.git', `git 层旧 URL 可解析且与新 URL 同 sha（${gitNew.data.split(/\s+/)[0].slice(0, 7)}）`);
} else {
  rec('warn', 'redirect.git', `git 层比对未完成：old=${gitOld.ok ? gitOld.data.slice(0, 7) : 'ERR'} new=${gitNew.ok ? gitNew.data.slice(0, 7) : 'ERR'}`);
}

// 3. workflow 集合与 active 状态
const wfs = gh([`repos/${newRepo}/actions/workflows`]);
if (!wfs.ok) {
  rec('fail', 'workflows', `读不到 workflow 列表（HTTP ${wfs.code}）`);
} else {
  const list = (wfs.data.workflows || []).filter((w) => !w.state || w.path);
  const names = list.map((w) => `${w.name}@${w.path}`).sort();
  const inactive = list.filter((w) => w.state !== 'active').map((w) => w.name);
  rec(
    inactive.length ? 'fail' : 'pass',
    'workflows.active',
    `${list.length} 个 workflow` + (inactive.length ? `，非 active: ${inactive.join(', ')} —— 用 gh workflow enable 恢复` : '，全部 active'),
  );
  if (manifest?.items?.workflows) {
    const before = manifest.items.workflows.map((w) => `${w.name}@${w.path}`).sort();
    const same = JSON.stringify(before) === JSON.stringify(names);
    rec(same ? 'pass' : 'fail', 'workflows.set', same ? `与清单一致（${names.length} 个）` : `不一致：清单=${before.join(',')} 现在=${names.join(',')}`);
  }
}

// 4. secrets / variables 名称集合（值不可读；名称集合一致即视为随仓库保留）
const sec = gh([`repos/${newRepo}/actions/secrets`]);
if (!sec.ok) {
  rec('fail', 'secrets', `读不到 secrets（HTTP ${sec.code}）`);
} else {
  const names = (sec.data.secrets || []).map((s) => s.name).sort();
  if (manifest?.items?.secrets) {
    const before = [...manifest.items.secrets].sort();
    const missing = before.filter((n) => !names.includes(n));
    const extra = names.filter((n) => !before.includes(n));
    rec(
      missing.length ? 'fail' : 'pass',
      'secrets.set',
      `${names.length} 个 secrets` +
        (missing.length ? ` —— 丢失: ${missing.join(', ')}` : '，与清单一致') +
        (extra.length ? `（新增: ${extra.join(', ')}）` : ''),
    );
  } else {
    rec('warn', 'secrets.set', `${names.length} 个 secrets: ${names.join(', ') || '（空）'}（无清单可比对）`);
  }
}
const vrs = gh([`repos/${newRepo}/actions/variables`]);
if (vrs.ok && manifest?.items?.variables) {
  const names = (vrs.data.variables || []).map((v) => v.name).sort();
  const before = [...manifest.items.variables].sort();
  const missing = before.filter((n) => !names.includes(n));
  rec(missing.length ? 'fail' : 'pass', 'variables.set', missing.length ? `丢失: ${missing.join(', ')}` : `${names.length} 个 Actions 变量与清单一致`);
}

// 5. issues 随仓库转移
const iss = gh([`repos/${newRepo}/issues?state=all&per_page=100`]);
if (iss.ok) {
  rec('pass', 'issues', `issues 可读（本页 ${iss.data.length} 条）`);
} else {
  rec('warn', 'issues', `issues 读取返回 HTTP ${iss.code}`);
}

// 6. 可选：真跑一次 workflow，端到端证明 secrets 可读、通知可达
if (opts.dispatch) {
  // 接受 sentinel.yml / .github/workflows/sentinel.yml / schedule-sentinel / 数字 id
  const all = gh([`repos/${newRepo}/actions/workflows`]);
  let wf = null;
  if (all.ok) {
    const q = String(opts.dispatch).trim();
    const base = q.split('/').pop();
    wf =
      all.data.workflows.find((w) => String(w.id) === q) ||
      all.data.workflows.find((w) => w.path === q) ||
      all.data.workflows.find((w) => w.path.endsWith('/' + base)) ||
      all.data.workflows.find((w) => w.name === q) ||
      null;
  }
  if (!wf) {
    rec('fail', 'dispatch', `找不到 workflow「${opts.dispatch}」，可选项: ${(all.data?.workflows || []).map((w) => w.path.split('/').pop()).join(', ') || '（无）'}`);
  } else {
    console.log(`\n— 触发 ${wf.name}（${wf.path}，写操作，会真跑一次）—`);
    const before = gh([`repos/${newRepo}/actions/workflows/${wf.id}/runs?per_page=1`]);
    const beforeId = before.ok ? before.data.workflow_runs?.[0]?.id ?? 0 : 0;
    // 实测：raw `POST .../actions/workflows/{id}/dispatch` 在本地 gh 凭据下返回 404，
    // 而 `gh workflow run` 可用。故走 CLI，不硬撑 REST 端点。
    const trig = sh('gh', ['workflow', 'run', String(wf.id), '-R', newRepo, '--ref', now.data.default_branch]);
    if (!trig.ok) {
      rec('fail', 'dispatch', `触发失败：${trig.message || '未知错误'}`);
    } else {
      const timeout = Number(opts.timeout || 600) * 1000;
      const deadline = Date.now() + timeout;
      let run = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 8000));
        const l = gh([`repos/${newRepo}/actions/workflows/${wf.id}/runs?per_page=5`]);
        if (!l.ok) continue;
        const cand = (l.data.workflow_runs || []).find((x) => x.id !== beforeId);
        if (cand && cand.status === 'completed') {
          run = cand;
          break;
        }
        if (cand) run = cand;
      }
      if (!run) {
        rec('fail', 'dispatch', `${Math.round(timeout / 1000)}s 内没有观察到新 run，或 run 未结束`);
      } else {
        rec(
          run.conclusion === 'success' ? 'pass' : 'fail',
          'dispatch',
          `run ${run.id} → ${run.conclusion}（${run.created_at}）` +
            (run.conclusion === 'success' ? ' —— 该 workflow 端到端可用' : ' —— 看日志定位'),
        );
      }
    }
  }
} else {
  rec('warn', 'dispatch', '未跑 --dispatch：只验证了平台元数据，未端到端验证 secrets 可读与通知可达');
}

console.log('---');
console.log(
  fails
    ? `结论: ${fails} 项失败、${warns} 项提示。失败项须处理，否则视为迁移未完成。`
    : `结论: 平台元数据核验通过（${results.filter((x) => x.level === 'pass').length} 项 PASS，${warns} 项提示）。`,
);
process.exit(fails ? 1 : 0);
