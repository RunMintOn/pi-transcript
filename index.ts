// Compression heuristics, measured token savings, pitfalls and open questions: NOTES.md
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToClipboard, parseSkillBlock, type ExtensionAPI, type SessionProjection } from "@earendil-works/pi-coding-agent";

const argumentKeys = ["path", "file_path", "pattern", "glob", "exclude", "offset", "limit", "context"] as const;
const copyMarkdown = "Copy Markdown";
const saveMarkdown = "Save temporary file and copy path";
const absolutePath = /(?<![\p{L}\p{N}_./:@%+$~\\-])(?:\/[\p{L}\p{N}._@%+-]+)+\/?/gu;
const shellPath = String.raw`(?:[\p{L}\p{N}_./@%+~-]+|'[^'\r\n]+'|"[^"$\x60\\\r\n]+")`;
const shellDirectory = new RegExp(String.raw`^(cd[ \t]+${shellPath})[ \t]*&&[ \t]*`, "u");
const catWrite = new RegExp(String.raw`^cat[ \t]*(>>?)[ \t]*(${shellPath})$`, "u");
const teeWrite = new RegExp(String.raw`^tee[ \t]+(?:(-a|--append)[ \t]+)?(?!-)(${shellPath})(?:[ \t]*>[ \t]*/dev/null)?$`, "u");
const heredoc = /<<(-?)[ \t]*(?:(['"])([A-Za-z_]\w*)\2|(\\?)([A-Za-z_]\w*))(?=[ \t>]|$)/;
const scriptCommand = /^(?:python(?:\d+(?:\.\d+)?)?|node|ego-browser|(?:ba|z)?sh)(?:[ \t]+[-\w./:=]+)*$/;
const shellBudget = 800;
const recentShellBudget = 1_400;
const shellOmission = "\n[... command text omitted ...]\n";
type FormatPaths = (text: string) => string;

function pathAliases() {
	const counts = new Map<string, number>();
	const directories = new Set<string>();
	return {
		collect(text: string) {
			for (const [path] of text.matchAll(absolutePath)) {
				for (let end = path.length; end > 1; end = path.lastIndexOf("/", end - 1)) {
					const prefix = path.slice(0, end);
					counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
					if (end < path.length) directories.add(prefix);
				}
			}
			return text;
		},
		build(original: string) {
			const aliases = new Map<string, string>();
			const rows: string[] = [];
			let candidates = [...directories].filter((path) => counts.get(path)! > 1);
			for (let number = 1; candidates.length && rows.length < 24; number++) {
				const alias = `$P${number}`;
				if (original.includes(alias)) continue;
				let best = "";
				let gain = 0;
				const row = (path: string) => `- \`${alias}\` = \`${path}\`\n`;
				for (const path of candidates) {
					const saved = counts.get(path)! * (path.length - alias.length) - row(path).length;
					if (saved > gain) {
						best = path;
						gain = saved;
					}
				}
				if (!best) break;
				aliases.set(best, alias);
				rows.push(row(best));
				candidates = candidates.filter((path) =>
					path !== best && !path.startsWith(`${best}/`) && !best.startsWith(`${path}/`),
				);
			}
			return {
				header: rows.length ? `## Path aliases\n\n${rows.join("")}\n` : "",
				replace(text: string) {
					return text.replace(absolutePath, (path) => {
						for (let end = path.length; end > 1; end = path.lastIndexOf("/", end - 1)) {
							const alias = aliases.get(path.slice(0, end));
							if (alias) return alias + path.slice(end);
						}
						return path;
					});
				},
			};
		},
	};
}

function code(value: string) {
	const length = Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));
	if (value.includes("\n")) {
		const fence = "`".repeat(Math.max(3, length + 1));
		return `\n\n  ${fence}\n${value.split("\n").map((line) => `  ${line}`).join("\n")}\n  ${fence}`;
	}
	const fence = "`".repeat(length + 1);
	const pad = value.startsWith("`") || value.endsWith("`") ? " " : "";
	return ` ${fence}${pad}${value}${pad}${fence}`;
}

function patchChanges(patch: string, formatPaths: FormatPaths) {
	return [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)(?:\r?\n\*\*\* Move to: (.+))?/gm)]
		.map(([, action, path, destination]) => destination
			? `Move ${formatPaths(path)} → ${formatPaths(destination)}`
			: `${action} ${formatPaths(path)}`);
}

function shellExcerpt(command: string, budget: number) {
	const text = compactShellWrites(command);
	if (text.length <= budget) return text;

	const available = budget - shellOmission.length;
	const head = Math.floor(available * 0.4);
	const tail = text.length - (available - head);
	const first = text.lastIndexOf("\n", head);
	const last = text.indexOf("\n", tail - 1);
	// Prefer whole lines near the cut. A large single line still has to fit.
	const start = first >= head - 80 ? first : head;
	const end = last >= 0 && last < tail + 80 ? last + 1 : tail;
	return text.slice(0, start).replace(/[\uD800-\uDBFF]$/, "") + shellOmission + text.slice(end).replace(/^[\uDC00-\uDFFF]/, "");
}

function compactShellWrites(command: string) {
	if (!command.includes("<<") || !command.includes("\n")) return command;
	const lines = command.split("\n");
	const sections: string[] = [];
	let start = 0;
	while (start < lines.length) {
		const head = lines[start];
		const marker = heredoc.exec(head);
		if (!marker) break;
		const [, stripTabs, quote, quotedTag, escaped, plainTag] = marker;
		const tag = quotedTag ?? plainTag;
		const prefix = shellDirectory.exec(head)?.[0] ?? "";
		if (marker.index < prefix.length) break;
		const before = head.slice(prefix.length, marker.index).trim();
		const after = head.slice(marker.index + marker[0].length).trim();
		const cat = after ? before === "cat" ? catWrite.exec(`cat ${after}`) : null : catWrite.exec(before);
		const tee = !after || /^>[ \t]*\/dev\/null$/.test(after) ? teeWrite.exec(`${before} ${after}`.trim()) : null;
		const write = cat ?? tee;
		const isPatch = !after && before === "apply_patch";
		const isScript = !after && scriptCommand.test(before);
		if (!(write || isPatch || isScript)) break;

		// A shell here-document ends at the exact delimiter, apart from <<- stripping tabs.
		let end = start + 1;
		for (; end < lines.length; end++) {
			const line = lines[end];
			if ((stripTabs ? line.replace(/^\t+/, "") : line) === tag) break;
		}
		if (end === lines.length) break;
		const body = lines.slice(start + 1, end).join("\n");
		const literal = !!(quote || escaped) || !/[$`\\]/.test(body);
		let summary: string | undefined;
		if (literal && write) {
			const append = !!write[1] && write[1] !== ">";
			summary = `${append ? "Append to" : "Write"} ${write[2]} [file content omitted]`;
		} else if (literal && isPatch && body.startsWith("*** Begin Patch\n") && body.endsWith("\n*** End Patch")) {
			const changes = patchChanges(body, (path) => path);
			if (changes.length) summary = `${changes.join(", ")} [patch omitted]`;
		}
		const original = lines.slice(start, end + 1).join("\n");
		const shortened = summary ? prefix + summary : original;
		sections.push(shortened.length < original.length ? shortened : original);
		start = end + 1;
	}
	return [...sections, ...lines.slice(start)].join("\n");
}

function toolCall(name: string, args: Record<string, unknown> | undefined, formatPaths: FormatPaths, budget: number, status?: string) {
	const prefix = `- **${name}**${status ? ` [${status}]` : ""}`;
	if (name === "codemode" || !args) return prefix;
	if (typeof args.command === "string" && args.command) {
		const command = name === "bash" || name === "bash_sync" ? shellExcerpt(args.command, budget) : args.command;
		return prefix + code(formatPaths(command));
	}

	if (name === "apply_patch" && typeof args.patch === "string") {
		const changes = patchChanges(args.patch, formatPaths);
		return changes.length ? prefix + code(changes.join(", ")) : prefix;
	}

	const fields = argumentKeys.flatMap((key) => {
		const value = args[key];
		if (typeof value === "number") return [`${key}=${value}`];
		if (key === "exclude" && Array.isArray(value)) {
			return [`${key}=${JSON.stringify(value.map((item) => typeof item === "string" ? formatPaths(item) : item))}`];
		}
		if (typeof value !== "string" || !value) return [];
		const formatted = key === "path" || key === "file_path" || key === "glob" || key === "exclude" ? formatPaths(value) : value;
		return [`${key}=${/[\s"]/.test(value) ? JSON.stringify(formatted) : formatted}`];
	});
	if (name === "edit") {
		const count = Array.isArray(args.edits) ? args.edits.length : typeof args.oldText === "string" ? 1 : undefined;
		if (count !== undefined) fields.push(`${count} replacement${count === 1 ? "" : "s"}`);
	}
	return fields.length ? prefix + code(fields.join(" ")) : prefix;
}

function collapseSkills(text: string) {
	const blocks: string[] = [];
	for (let skill = parseSkillBlock(text); skill; skill = parseSkillBlock(text)) {
		blocks.push(`\`/skill:${skill.name}\``);
		text = skill.userMessage ?? "";
	}
	blocks.push(text);
	return blocks.filter(Boolean).join("\n\n");
}

function userTurnStart(messages: SessionProjection["messages"], count: number) {
	let start = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "user") continue;
		start = i;
		if (--count === 0) break;
	}
	return start;
}

export function renderTranscript(projection: SessionProjection, turns?: number) {
	const messages = turns === undefined ? projection.messages : projection.messages.slice(userTurnStart(projection.messages, turns));
	const paths = pathAliases();
	const original = renderMessages(messages, paths.collect);
	const { header, replace } = paths.build(original);
	if (!header) return original;
	const compressed = header + renderMessages(messages, replace);
	return compressed.length < original.length ? compressed : original;
}

function renderMessages(messages: SessionProjection["messages"], formatPaths: FormatPaths) {
	// Pi stores nested call inputs on the parent result, separately from its output.
	const results = new Map(messages.flatMap((message) =>
		message.role === "toolResult"
			? [[message.toolCallId, message] as const]
			: [],
	));
	const sections: string[] = [];
	const recentStart = userTurnStart(messages, 2);
	let assistant = false;
	for (const [index, message] of messages.entries()) {
		const budget = index >= recentStart ? recentShellBudget : shellBudget;
		switch (message.role) {
			case "user": {
				const text = typeof message.content === "string"
					? message.content
					: message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
				if (text.trim()) sections.push(`## User\n\n${collapseSkills(text)}`);
				assistant = false;
				break;
			}
			case "assistant": {
				const blocks = message.content.flatMap((part) => {
					if (part.type === "text") return part.text.trim() ? [part.text] : [];
					if (part.type !== "toolCall") return [];
					const result = results.get(part.id);
					const lines = [toolCall(part.name, part.arguments, formatPaths, budget, result?.isError ? "error" : undefined)];
					const children = result?.nestedCalls;
					for (const child of children?.calls ?? []) {
						lines.push(toolCall(child.name, child.arguments, formatPaths, budget, child.status === "error" ? "error" : undefined).replace(/^/gm, "  "));
					}
					if (children && !children.complete) lines.push("  - *Nested call record incomplete*");
					return [lines.join("\n")];
				});
				if (blocks.length) {
					const text = blocks.join("\n\n");
					sections.push(assistant ? text : `## Assistant\n\n${text}`);
					assistant = true;
				}
				break;
			}
			case "compactionSummary":
			case "branchSummary":
				sections.push(`## Context Summary\n\n${message.summary}`);
				assistant = false;
				break;
			case "bashExecution":
				if (!message.excludeFromContext) {
					const status = message.cancelled ? " [cancelled]" : message.exitCode ? ` [exit ${message.exitCode}]` : "";
					sections.push(`## User\n\n- **bash (manual)**${status}${code(formatPaths(shellExcerpt(message.command, budget)))}`);
					assistant = false;
				}
				break;
		}
	}
	return sections.length ? sections.join("\n\n") + "\n" : "";
}

function transcriptDocument(body: string, sessionFile: string | undefined, started: string | undefined, turns?: number) {
	const metadata = [`- Session file:${sessionFile ? code(sessionFile) : " (in memory)"}`];
	if (started) {
		const time = new Intl.DateTimeFormat("sv-SE", {
			year: "numeric", month: "2-digit", day: "2-digit",
			hour: "2-digit", minute: "2-digit", timeZoneName: "longOffset",
		}).format(new Date(started));
		metadata.push(`- Session started: ${time}`);
	}
	if (turns !== undefined) metadata.push(`- Scope: Last ${turns} user turn${turns === 1 ? "" : "s"}`);
	return `# Transcript\n\n${metadata.join("\n")}\n\n${body}\n---\n\n*End of transcript.*\n`;
}

export async function writeTranscript(markdown: string) {
	const directory = await mkdtemp(join(tmpdir(), "pi-transcript-"));
	const path = join(directory, "transcript.md");
	await writeFile(path, markdown);
	return path;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("transcript", {
		description: "Export the active conversation or its last N user turns as Markdown",
		handler: async (args, ctx) => {
			const arg = args.trim();
			const turns = arg ? Number(arg) : undefined;
			if (arg && (!/^[1-9]\d*$/.test(arg) || !Number.isSafeInteger(turns))) {
				ctx.ui.notify("Usage: /transcript [number of user turns]", "warning");
				return;
			}
			const choice = await ctx.ui.select("Export transcript", [copyMarkdown, saveMarkdown]);
			if (!choice) return;

			const session = ctx.sessionManager;
			const body = renderTranscript(session.buildSessionProjection(), turns);
			if (!body) {
				ctx.ui.notify("No conversation to export", "info");
				return;
			}
			const markdown = transcriptDocument(body, session.getSessionFile(), session.getHeader()?.timestamp, turns);
			if (choice === copyMarkdown) {
				await copyToClipboard(markdown);
				ctx.ui.notify("Transcript copied", "info");
			} else {
				const path = await writeTranscript(markdown);
				ctx.ui.notify(`Transcript saved to ${path}`, "info");
				await copyToClipboard(path);
			}
		},
	});
}
