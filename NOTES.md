# pi-transcript 设计记录

`/transcript` 把当前 Pi 会话导出成 Markdown，供用户粘进新对话交接工作。目标：在保住「对话怎么走到现在」的前提下尽量少占 token。代码入口 `index.ts`。

## 管线与已丢弃的内容

`renderTranscript(projection, turns)` → `renderMessages`，输入来自 `ctx.sessionManager.buildSessionProjection().messages`。

已经不进导出的：工具输出、thinking、`write`/`edit` 的正文与具体替换内容、`codemode` 外层参数。保留：user/assistant 可见正文（逐字）、compaction/branch summary、工具调用的名字与关键参数。

硬约束（用户已定）：可见正文逐字保留，不做摘要、不调用 AI，只用确定性启发式。

## 实测数据（2026-11，137 份本地会话）

样本：`~/.pi/agent/sessions/**/*.jsonl`，40 KB–15 MB，按 mtime 取最近 150 份后用 `buildSessionProjection` 过滤，只留助手消息模型可判定为 GPT / DeepSeek 的会话。分组按每条 assistant 消息的 `model` 字段（`/@deepseek|dpsk/i` vs `/gpt|codex/i`）。另有 22 份属于「末尾 1–2 轮才切 DeepSeek」。

导出内容的字符构成（去掉 Bash 命令正文本体后测得的中位占比）：GPT 37%、DeepSeek 55%、混用 35%。这是导出文本里的占比，不等于原会话上下文占比。

各方案相对旧版导出的 token 降幅（`o200k_base`，整批合计 / 单会话中位数）：

| 方案 | 合计 | 中位 |
|---|---:|---:|
| 相同命令只写一次 + 短编号引用 | 0.1% | 0% |
| 明确写文件命令剥载荷 | 3.9% | 0% |
| 再按头尾截断长脚本（1000 字符阈值） | 13.4% | 0.7% |
| 通用长度上限（现行） | 12.7% | 0.8% |

现行方案分组：GPT 7.6%、DeepSeek 15.8%、混用 7.8%。

结论：去重收益可忽略，不必再做。收益集中在长命令多的会话，中位数低是正常的，不要用中位数判断方案好坏。

## 现行启发式（`index.ts`）

1. 写文件剥离。识别 `cat >file` / `cat >>file` / `tee [-a] file` / `apply_patch` 的 heredoc，且要求 body 字面量（`compactShellWrites`）：带引号 heredoc，或 body 内不含 `$`、反引号、`\`。输出 `Write <path> [file content omitted]`，只删 heredoc 段，同一命令里的其他步骤（如 `&& npm test`）保留。
2. 通用长度上限。所有 Bash 命令都过 `shellExcerpt`：超过**最近两轮 1,400 / 更早 800** 字符时保留头约 40%、尾约 60%，插入 `[... command text omitted ...]`；尽量切在行边界，并按 budget 精确截断。
3. 状态标记。`toolResult.isError` 和 `nestedCalls[].status === "error"` 加 `[error]`；手动 Bash 用 `[exit N]`、`[cancelled]`（`bashExecution` 有 `exitCode`，tool 结果里没有）。

早期版本只给白名单命令（python/node/ego-browser）截断，导致多行管道命令（如 `set -o pipefail` + `node ... | python ...`）完全绕过，用户实测发现 6,489 字符命令原样导出。先做白名单是错的，通用长度上限才是基线，写文件剥离是叠加在上面的文本缩短。

## 实现陷阱（已验证）

- heredoc 结束标记必须整行等于 tag；`<<-` 只在比较前剥离前导 tab。
- `cat >'dir <<EOF name'` 这类路径内含 `<<` 的写法：先按引号感知的路径正则切出 prefix 和 after，不要用字符串 `indexOf` 找 `<<`。
- `tee --append` 应在 `--append` 之后匹配路径，避免把选项当文件名；`tee file > /dev/null` 的 `> /dev/null` 不算写文件后缀。
- `codemode` 的 Bash 命令在 `toolResult.nestedCalls[].arguments.command`，外层 toolCall 没有 `command`。`renderMessages` 同时处理三种来源：assistant `toolCall`、`nestedCalls`、`bashExecution`。
- 导出的 Bash 命令需按 800/1400 两个 budget 分别渲染：整体重渲染一遍（路径别名压缩）时，`recentStart` 要基于**切片后**的 messages 计算，否则 `/transcript N` 的预算会错。
- 截断要避免切坏 UTF-16 代理对（emoji），切点前后做一次 surrogate 修补。

## 复测方法（可复用）

不需要装依赖：

- 用 `node --experimental-strip-types` 或 `node:module` 的 `stripTypeScriptTypes` + `data:text/javascript;base64,` 动态 import `index.ts`，把 `@earendil-works/pi-coding-agent` 的 import 换成 `file://<dist>/index.js`。
- 用 `dist/core/session-manager.js` 的 `buildSessionProjection(entries, leafId)` 从 jsonl 还原消息（jsonl 每行一个 entry，去掉首行 header）。
- 用 `o200k_base` 计数：`uv` 缓存里已有 tiktoken 0.12.0 wheel，`PYTHONPATH=~/.cache/uv/archive-v0/<hash>` 直接 `python3.12 -c 'import tiktoken'`，并把 `tiktoken.load.read_file` 打补丁喂 curl 下来的 bpe 文件，避免 tiktoken 自己走缓存目录。

## 行为约定

- 输出结构：`# Transcript` + metadata（`Session file:`、`Session started:` 本地时区带偏移、`Scope: Last N user turns`）+ 对话正文 + `---` + `*End of transcript.*`。复制和保存走同一份 Markdown。
- 该目录**不是 git 仓库**（同级只有 `33-pi-consolidate` 有 `.git`），改动无法提交，无需尝试。
- 插件在 `~/.pi/agent/settings.json` 里以绝对路径注册；运行中的 Pi 需 `/reload` 才生效，重启 Pi 自然加载。

## 未决 / 未验证

- 长命令头尾截断仍可能丢掉命中的断言。已观察到一次实例：`assert b'Copy Markdown' in output` 落在脚本中段被省掉。尚未设计出只在「中段是检查逻辑」时保留更宽的规则。
- 全部 token 数据只用 `o200k_base` 测过，DeepSeek 分词器未复测；DeepSeek 的 CJK 与代码 token 密度不同，占比可能偏移。
- 800/1400 两个预算值来自一次样本扫描，未做按会话长度的自适应。
