# dsh-fixchain

DeepSeek Harness（dsh）插件：对在 dsh 里做的迁移和返修做返修链路归因（→ 情景卡 → 经验库新版本），也能只看轨迹不分析。

分析全部用 a2h-memory 自带的工具链：`distill/distill.py`（prepare / check）、`migloop/src/migloop/inquiry`（索引与查看界面）、`migloop/skills`（triage → 制卡 → 归并）。插件只做三件事：通过 dsh 的 `sessionPersistence` 找到会话日志；启动这些 Python 进程；在 dsh 里起一个 headless 会话跑制卡。

## 要求

| 项 | 版本 |
|---|---|
| dsh | `>=0.2.2-rc.1 <0.3.0`（在 0.2.2-rc.1 上验证；会话格式 v4） |
| Node.js / pnpm | 随 dsh；`dsh plugin` 用 pnpm 装插件 |
| a2h-memory | 带 dsh 支持的版本（分支 `feat/dsh-adapter`），在配置里给出路径 |
| Python | 3.10+，装有 PyYAML 6.0.3（distill 打 skill 包时用）；不需要 numpy 等检索依赖 |
| 工程 | 迁移目标是 git 仓库：迁移结束的提交打标签 `execute-end`，返修一处一个提交 |
| 制卡模型 | 制卡会话用 worker profile（默认 shipped `headless`）的模型和凭据，默认 `deepseek-flash` + `DEEPSEEK_API_KEY` |

## 安装

```sh
dsh plugin --profile web add /path/to/dsh-fixchain
```

在该 profile 的 `cordis.patch.yml` 里指向 a2h-memory（覆盖会替换整段 config）：

```yaml
- id: dsh-fixchain
  config:
    a2hMemory: /path/to/a2h-memory
    python: ''              # 空 = DSH_FIXCHAIN_PYTHON，否则 Windows `py -3`，其他 python3
    runsDir: ''             # 空 = $DSH_HOME/fixchain-runs
    workerProfile: headless
    workerModel: deepseek-flash   # 记进 analysis-runtime.json，卡片的分析模型
    dshCommand: []          # 空 = 用当前进程的 dsh 启动器起制卡会话
```

## 命令

| 输入 | 结果 |
|---|---|
| `/fixchain view <会话> [<会话>…]` | 把会话（含子代理）冻结成 `dsh-events/1`，建 inquiry 索引，起本机查看界面：文件 × agent 的时间证据树。只浏览，不做归因 |
| `/fixchain stop` | 关掉查看界面 |
| `/fixchain prepare --migration <id> --repair <id> [--repair <id>] [--project DIR] [--source DIR] [--out DIR] [--app NAME] [--base NAME \| --base-store DIR --base-memory DIR]` | `distill.py prepare --platform dsh --worker-host dsh`：材料池、git 检查点、证据、起点库、skills、job.json、CLAUDE.md。`--project` 默认是迁移会话的 cwd |
| `/fixchain cards <run 目录> [--resume]` | 在 run 目录里起一个 headless dsh 会话，按 CLAUDE.md / job.json 走 migloop-session-to-memory；结束后自动跑 `distill.py check`，结果写进 `dsh-worker-state.json`。立即返回 |
| `/fixchain status <run 目录>` | 制卡会话状态、completion、最近一次检查 |
| `/fixchain check <run 目录>` | 只跑 `distill.py check` |

会话 id 可以是 `session-<uuid>` 或 uuid 前缀。命令本身不花 token；只有 `cards` 起的制卡会话调用模型。

制卡会话的工作区就是 run 目录（dsh 的 workspace-write 沙箱只放行这里的写入），工程、安卓源码和 skills 只读。Windows 上 skill 包是在 Python 临时目录里打的，带一份只给属主的 ACL，dsh 沙箱读不了；`cards` 启动前会把 run 下的 `skills/` 改回继承 run 目录的权限（`icacls skills /reset /T`）。

## 独立离线材料入口

离线会话可通过显式材料目录准备，不需要 a2h-memory checkout；制卡与归并仍复用公开 MigLoop skills，不在插件里重写算法。此路径需要带 DSH adapter 的公开 hxy450/migloop 源码、Python 3.10+／PyYAML 和构建后的 skills，例如当前验证版本 c72c0db50ee39ddd5dfe0fbb79ee02e6ef023925（skills 0.10.10）：

```sh
python /absolute/migloop/skills/migloop-memory-maintain/scripts/build_bundle.py --out /absolute/built-skills
```

运行时 JSON 只描述三个必要依赖；无需评测仓库、控制台或 UI：

```json
{"schemaVersion":"migloop.distillation-runtime/1","python":"/absolute/venv/bin/python","skills":"/absolute/built-skills","migloop":{"directory":"/absolute/migloop"}}
```

配置 memoryRuntime 或 HMBOT_MEMORY_RUNTIME 指向此文件。材料配置 JSON 示例：

```json
{"materials":"/absolute/offline-materials","format":"native-pool","app":"example","maxIssues":1,"scope":"Investigate one retained repair using original evidence"}
```

```sh
/fixchain prepare --offline "/absolute/offline-config.json" --out "/absolute/new run"
/fixchain cards "/absolute/new run"
/fixchain check "/absolute/new run"
```

支持 claude／codex／deveco／dsh／a2h-export/4／native-pool，由原生 MigLoop 解析。dsh 格式还需显式 sessions 路径数组；其他格式保留目录中的原文及附件。a2h-export/4 的完整性应由调用方先校验，prepare 本身不是导出校验器。输出必须是材料之外的新目录。可选 baseStore、scope、maxIssues、holdoutApps，以及 checkpointRepository／generationRef／finalRef 用于基线和历史 Git 证据；后者要求 bare Git 仓库。

提供可 import 的 ./offline API 和 memory_distill prepare/check 工具，CLI 与工具共用入口。prepare/check 不调用模型，cards 才启动真实 DSH；最小 runtime 沿用当前 DSH_HOME／PATH，完整运行时可显式提供 dshCli、dshHome。交付检查要求独立卡片、全部派工闭合、精确 store revision 及阅读包摘要；partial／缺片／未完成不能视为成功。

未配置 runtime 时，原来的 a2h-memory 和在线 Session 流程保持。为兼容现有调用方，同时接受 hmbot.rsi.distillation-runtime/1 与 hmbot.memory.runtime/1 运行时 schema；插件不依赖这些调用方的安装程序。离线能力目前验证领域为迁移返修，未证明 PPT 或任意 Skill 优化适用。

## 冒烟测试

```sh
DSH_HOME=... PATH=<pnpm 所在目录>:$PATH \
node scripts/smoke.mjs --dsh <dsh 的 bin.js 或 dsh> --a2h-memory <checkout> \
  --migration <迁移会话 id> --repair <返修会话 id> --source <安卓源码目录> [--with-cards]
```

插件装进临时 profile（从 `sdk` 模板复制），用 profile 补丁配置，启动后由只用于测试的 driver 插件（`--patch` 挂入）在 dsh 进程里经人类命令注册表执行：`help`、`view` + 页面 200、`stop`、`prepare`（核 job.json、冻结的三份材料、边界证据）、`status`、`check`（交付前报缺 completion）。起点库用 a2h-memory 的 `tests/fixtures/library`，不联网。`--with-cards` 再跑一次真实制卡并核 `distill.py check`，这一步调用模型、要凭据。

## 限制

- 只认 dsh 会话格式 v4。
- 制卡质量取决于 worker 模型；用 deepseek-flash 跑出的卡与 Claude Code 输入走同一套 skill、同一个 pack 检查器和同一个 `distill.py check`，但没有和 Opus 制卡做过质量对比。
- `distill.py run`（Claude Code 宿主）不变；dsh 宿主由本插件起会话、管续跑。
- dsh 会话日志不记录 dsh 版本号，卡片里的客户端版本保持未知。
