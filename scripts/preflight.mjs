#!/usr/bin/env node
// 只读预检：转移前审计源仓库，判定能否在不中断已部署 Actions 的前提下转移。
// 不做任何写操作。需要已登录的 gh（GitHub CLI）。
// 用法: node scripts/preflight.mjs <owner/repo> --to <target-owner> [--local <path>] [--json <out>]

import { execFileSync } from 'node:child_process';
import { writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const USAGE =
  '用法: node scripts/preflight.mjs <owner/repo> --to <target-owner> [--local <path>] [--json <out>]';

function gh(args) {
  try {
    const out = execFileSync('gh', ['api', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, data: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    const text = (e.stderr || e.stdout || e.message || '').toString();
    const m = /"status":\s*(\d+)/.exec(text) || /HTTP (4\d\d|5\d\d)/.exec(text);
    return { ok: false, code: m ? Number(m[1]) : 0, message: text.split('\n')[0].slice(0, 160) };
  }
}

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['to', 'local', 'json']);
const pos = [];
const opts = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const key = a.slice(2);
    if (VALUE_FLAGS.has(key)) {
      opts[key] = argv[++i];
    } else {
      opts[key] = true;
    }
  } else {
    pos.push(a);
  }
}
const flag = (name) => (typeof opts[name] === 'string' ? opts[name] : null);

if (pos.length !== 1 || !flag('to')) {
  console.error(USAGE);
  process.exit(2);
}
const [source] = pos;
const target = flag('to');
const localPath = flag('local');
const jsonOut = flag('json');
const [srcOwner, srcName] = source.split('/');
if (!srcOwner || !srcName || srcName.includes('/')) {
  console.error('仓库须写成 owner/repo 形式：' + source);
  process.exit(2);
}

const findings = [];
const manifest = { source, target, checked_at: new Date().toISOString(), items: {} };
const add = (level, id, text) => {
  findings.push({ level, id, text });
  console.log(`${level === 'block' ? 'BLOCK' : level === 'warn' ? 'WARN ' : level === 'fail' ? 'FAIL ' : 'OK  '} ${id}  ${text}`);
};

// 1. 源仓库元数据
const repo = gh([`repos/${source}`]);
if (!repo.ok) {
  console.error(`读不到源仓库 ${source}：${repo.message || 'HTTP ' + repo.code}`);
  console.error('确认 gh 已登录且对该仓库有 admin 权限。');
  process.exit(2);
}
const r = repo.data;
manifest.items.repo = {
  id: r.id,
  full_name: r.full_name,
  private: r.private,
  fork: r.fork,
  parent: r.parent ? r.parent.full_name : null,
  default_branch: r.default_branch,
  archived: r.archived,
  pushed_at: r.pushed_at,
};
add(
  r.archived ? 'block' : 'pass',
  'repo.reachable',
  `${r.full_name} id=${r.id} ${r.private ? 'private' : 'public'} default=${r.default_branch}` +
    (r.archived ? ' —— 已归档，须先 unarchive 再转移' : ''),
);
if (r.fork) {
  add('warn', 'repo.fork', '源仓库是 fork：从私有上游网络分叉的单仓库不能转移，先确认上游可见性');
}
if (r.owner.login.toLowerCase() === target.toLowerCase()) {
  add('block', 'target.same', '目标 owner 与当前 owner 相同，转移无意义');
}

// 2. 目标位置不能已有同名仓库。注意：已转移走的旧位置仍会被 API 解析成重定向，
//    返回 200 但 full_name 指向别处——那不是占用，反而证明重定向链完好。
const clash = gh([`repos/${target}/${srcName}`]);
if (clash.ok) {
  const got = clash.data.full_name || '';
  if (got.toLowerCase() === `${target}/${srcName}`.toLowerCase()) {
    add('block', 'target.collision', `${target}/${srcName} 已被真实占用（id=${clash.data.id}），转移会失败；先改名或删除它`);
  } else {
    add(
      'pass',
      'target.collision',
      `${target}/${srcName} 未占用——API 把它解析成到 ${got} 的重定向（同一 id=${clash.data.id}），转移不受影响`,
    );
  }
} else if (clash.code === 404) {
  add('pass', 'target.collision', `${target}/${srcName} 未被占用`);
} else {
  add('warn', 'target.collision', `探测目标位置返回 HTTP ${clash.code}，无法判定是否占用`);
}

// 3. 我在目标组织的角色（org→org 需要建仓库权限）
const me = gh(['user']);
if (me.ok) {
  manifest.items.actor = me.data.login;
  const org = gh([`orgs/${target}`]);
  if (org.ok) {
    const m = gh([`user/memberships/orgs/${target}`]);
    if (m.ok) {
      manifest.items.target_membership = { role: m.data.role, state: m.data.state };
      if (m.data.state !== 'active') {
        add('block', 'target.membership', `在 ${target} 的成员状态=${m.data.state}，须先激活`);
      } else if (m.data.role === 'admin') {
        add('pass', 'target.membership', `在 ${target} 的角色=admin，具备建仓库权限`);
      } else {
        // 「成员可建仓库」是 org 开关，没有 admin:org 作用域时查不到，只能交人工确认。
        add(
          'warn',
          'target.membership',
          `在 ${target} 的角色=member：转移进组织需要该组织的建仓库权限，` +
            '而该开关无法匿名查询（需 admin:org）。确认 Settings → Administration → Repository permissions → Members can create repositories 覆盖到你，或请 org owner 代跑转移',
        );
      }
    } else {
      add('block', 'target.membership', `不是 ${target} 的成员（HTTP ${m.code}），无法把仓库转入该组织`);
    }
  } else {
    // 目标可能是个人账号
    const user = gh([`users/${target}`]);
    add(
      user.ok ? 'warn' : 'block',
      'target.membership',
      user.ok
        ? `目标是个人账号 ${target}：转移会发出确认邮件，需对方在 1 天内接受`
        : `目标 ${target} 既不是组织也不是用户，账号名写错了`,
    );
  }
}

// 4. workflow 清单与调度
const wfs = gh([`repos/${source}/actions/workflows`]);
const schedules = [];
if (wfs.ok) {
  const list = wfs.data.workflows || [];
  manifest.items.workflows = list.map((w) => ({ name: w.name, path: w.path, state: w.state }));
  const inactive = list.filter((w) => w.state !== 'active');
  add(
    inactive.length ? 'warn' : 'pass',
    'workflows.active',
    `${list.length} 个 workflow，active ${list.length - inactive.length}` +
      (inactive.length ? ` —— 非 active: ${inactive.map((w) => w.name).join(', ')}` : ''),
  );
  for (const w of list) {
    const one = gh([`repos/${source}/contents/${w.path}`]);
    if (!one.ok) continue;
    let text = '';
    try {
      text = Buffer.from(one.data.content, 'base64').toString('utf8');
    } catch {
      continue;
    }
    const crons = [...text.matchAll(/^\s*-\s*cron:\s*['"]([^'"]+)['"]/gm)].map((x) => x[1]);
    if (crons.length) {
      schedules.push({ name: w.name, crons });
      for (const c of crons) {
        const next = nextDailyUtc(c);
        add(
          next && next.minutesUntil < 30 ? 'warn' : 'pass',
          'schedule.window',
          `${w.name} cron「${c}」` +
            (next
              ? ` → 下次约 ${next.iso}（${next.minutesUntil} 分钟后）` +
                (next.minutesUntil < 30 ? ' —— 太近，等这一跑结束再转移' : '')
              : ' —— 非每日固定时刻表达式，请人工核对窗口'),
        );
      }
    }
  }
  if (!schedules.length) add('pass', 'schedule.window', '没有 schedule 触发的 workflow，转移窗口不受 cron 约束');
} else {
  add('warn', 'workflows.active', `读不到 workflow 列表（HTTP ${wfs.code}）`);
}
manifest.items.schedules = schedules;

// 5. secrets / variables 名称（值不可读，也不需要）
const secrets = gh([`repos/${source}/actions/secrets`]);
if (secrets.ok) {
  const names = (secrets.data.secrets || []).map((s) => s.name).sort();
  manifest.items.secrets = names;
  add(names.length ? 'pass' : 'warn', 'secrets', `${names.length} 个 Actions secrets: ${names.join(', ') || '（空）'}`);
} else {
  add('warn', 'secrets', `读不到 secrets 列表（HTTP ${secrets.code}）`);
}
const vars = gh([`repos/${source}/actions/variables`]);
if (vars.ok) {
  manifest.items.variables = (vars.data.variables || []).map((v) => v.name).sort();
  add('pass', 'variables', `${manifest.items.variables.length} 个 Actions 变量: ${manifest.items.variables.join(', ') || '（空）'}`);
}

// 6. 一并转移的对象
for (const [id, path] of [
  ['issues', `repos/${source}/issues?state=all&per_page=1`],
  ['releases', `repos/${source}/releases?per_page=1`],
]) {
  const res = gh([path]);
  add(res.ok ? 'pass' : 'warn', 'transfer.' + id, res.ok ? `${id} 可读，随仓库转移` : `${id} 读取返回 HTTP ${res.code}`);
}

// 7. 名称退役规则：前一周 Actions 用量 >100 会让 OWNER/REPO 组合永久退役
const since = new Date(Date.now() - 7 * 864e5).toISOString();
const runs = gh([`repos/${source}/actions/runs?created=>=${since}&per_page=100`]);
if (runs.ok) {
  const n = runs.data.total_count ?? (runs.data.workflow_runs || []).length;
  manifest.items.actions_runs_last_7d = n;
  add(
    n > 100 ? 'warn' : 'pass',
    'name.retirement',
    `近 7 天 Actions 运行 ${n} 次` +
      (n > 100 ? ' —— 超过 100，转移后旧 OWNER/REPO 组合会被永久退役，不能再在该位置重建同名仓库' : ' —— 未触发名称退役阈值'),
  );
} else {
  add('warn', 'name.retirement', `读不到运行历史（HTTP ${runs.code}），无法判定名称退役风险`);
}

// 8. 代码里硬编码的 owner 引用（转移后最容易漏的功能性失效）
if (localPath) {
  const dir = resolve(localPath);
  const hits = grepOwner(dir, srcOwner);
  manifest.items.hardcoded_owner_refs = hits;
  if (hits.length) {
    add(
      'warn',
      'code.owner-refs',
      `工作树里有 ${hits.length} 处写死了 "${srcOwner}"：\n` +
        hits.map((h) => `        ${h.file}:${h.line}  ${h.text}`).join('\n') +
        '\n      逐条判定是功能性引用（须改）还是测试夹具（可留）',
    );
  } else {
    add('pass', 'code.owner-refs', `工作树没有写死 "${srcOwner}" 的地方`);
  }
} else {
  add('warn', 'code.owner-refs', '未传 --local <仓库路径>，跳过硬编码 owner 扫描（强烈建议做）');
}

// 9. 分支保护（私有仓库免费计划不支持，属正常）
const prot = gh([`repos/${source}/branches/${r.default_branch}/protection`]);
if (prot.ok) {
  add('warn', 'branch.protection', `默认分支有保护规则，转移后须复核其是否仍满足要求`);
} else {
  add('pass', 'branch.protection', `默认分支无保护规则（HTTP ${prot.code}）`);
}

const blockers = findings.filter((f) => f.level === 'block');
const warns = findings.filter((f) => f.level === 'warn');
console.log('---');
console.log(
  `结论: ${blockers.length ? `${blockers.length} 项阻断` : '无阻断项'}，${warns.length} 项需人工判定。` +
    (blockers.length ? '先解决阻断项再转移。' : '可以转移；转移后用 verify.mjs 对照本清单核验。'),
);

if (jsonOut) {
  manifest.findings = findings;
  manifest.blockers = blockers.length;
  manifest.warnings = warns.length;
  writeFileSync(resolve(jsonOut), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`清单已写入 ${jsonOut}`);
}
process.exit(blockers.length ? 1 : 0);

// 只处理 `M H * * *` 这种每日固定时刻；其它表达式返回 null 交给人工。
function nextDailyUtc(cron) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, mon, dow] = parts;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour) || dom !== '*' || mon !== '*' || dow !== '*') return null;
  const now = Date.now();
  for (let d = 0; d <= 1; d++) {
    const t = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate() + d,
      Number(hour),
      Number(min),
    );
    if (t > now) {
      return { iso: new Date(t).toISOString().slice(0, 16).replace('T', ' ') + 'Z', minutesUntil: Math.round((t - now) / 6e4) };
    }
  }
  return null;
}

function grepOwner(dir, owner) {
  const skip = new Set(['.git', 'node_modules', '.output', 'dist', 'build', '.codegraph', '.next', 'coverage', '.venv', '__pycache__']);
  const out = [];
  const ext = /\.(md|ya?ml|json|jsonc|mjs|c?js|ts|tsx|sh|toml|txt|py|go|rs|Dockerfile)$|(^|\/)(Dockerfile|Makefile)$/;
  const walk = (d, depth) => {
    if (depth > 8 || out.length > 60) return;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const full = d + '/' + e.name;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (ext.test(e.name)) {
        let text;
        try {
          text = readFileSync(full, 'utf8');
        } catch {
          continue;
        }
        if (text.length > 2e6) continue;
        text.split(/\r?\n/).forEach((line, i) => {
          if (line.includes(owner + '/') || line.includes(owner + ':')) {
            out.push({ file: full.replace(d.replace(dir, ''), '').replace(/^\//, '') || e.name, line: i + 1, text: line.trim().slice(0, 120) });
          }
        });
      }
    }
  };
  walk(dir.replace(/\\/g, '/'), 0);
  return out.map((h) => ({ ...h, file: h.file.startsWith(dir) ? h.file.slice(dir.length + 1) : h.file }));
}
