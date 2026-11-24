# pi-transcript

Pi 扩展，把当前会话导出成紧凑的 Markdown，用于把工作交给新对话。

`/transcript` 复制整段对话，`/transcript 3` 只导出最近 3 轮用户发言。工具输出、thinking、文件写入正文不进导出；长 Bash 命令按长度保留头尾，越近的轮次保留越多。

设计与实测数据见 [NOTES.md](NOTES.md)。

## 安装

在 `~/.pi/agent/settings.json` 的扩展列表里加入本目录的 `index.ts` 绝对路径，然后重启 Pi 或执行 `/reload`。
