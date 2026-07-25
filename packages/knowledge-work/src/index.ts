import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, open, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	buildSemanticLookupCode,
	canWriteInMode,
	extractWikiLinks,
	formatEffort,
	formatModelLabel,
	formatPromptSize,
	frontmatterNameMatches,
	isPathInside,
	KNOWLEDGE_MODES,
	type KnowledgeMode,
	limitSearchPassages,
	normalizeVaultNoteRequest,
	parseModeSwitchRequest,
	parseObsidianEvalJson,
	rankVaultNotePaths,
	stripPlexProgress,
	toolsForMode,
} from "./utils.ts";

export type { KnowledgeMode } from "./utils.ts";
export {
	buildSemanticLookupCode,
	canWriteInMode,
	extractWikiLinks,
	formatEffort,
	formatModelLabel,
	formatPromptSize,
	frontmatterNameMatches,
	isPathInside,
	KNOWLEDGE_MODES,
	limitSearchPassages,
	normalizeVaultNoteRequest,
	parseModeSwitchRequest,
	parseObsidianEvalJson,
	rankVaultNotePaths,
	stripPlexProgress,
	toolsForMode,
} from "./utils.ts";

interface KnowledgeConfig {
	vaultPath: string;
	vaultName: string;
	capturePath: string;
	initialMode: KnowledgeMode;
	theme: string;
	obsidianCliPath: string;
	plexHelperPath?: string;
	skillPaths: string[];
}

interface ReadDetails {
	label: string;
	lineCount: number;
}

interface SearchDetails {
	count: number;
}

interface SemanticSearchDetails {
	queryCount: number;
	resultCount: number;
}

interface SemanticSearchPayload {
	ok: boolean;
	queries?: string[];
	results?: Array<{
		rank: number;
		path: string;
		queryHits: number;
		queryIndexes: number[];
		rrfScore: number;
		bestScore: number | null;
	}>;
	error?: string;
}

interface ConnectionsDetails {
	outgoing: number;
	backlinks: number;
}

interface SaveDetails {
	action: "create" | "append" | "replace";
	path: string;
}

interface ResearchDetails {
	mode: "standard" | "deep" | "council";
	query: string;
}

interface AskDetails {
	answered: boolean;
}

interface ResolvedVaultNote {
	absolutePath: string;
	relativePath: string;
	healed: boolean;
}

const modeLabels: Record<KnowledgeMode, string> = {
	explore: "Explore",
	write: "Write",
	review: "Review",
	plan: "Plan",
};

const modeWorkingMessages: Record<KnowledgeMode, string> = {
	explore: "Following the thread…",
	write: "Shaping the prose…",
	review: "Reading closely…",
	plan: "Finding the next move…",
};

function isKnowledgeMode(value: unknown): value is KnowledgeMode {
	return typeof value === "string" && KNOWLEDGE_MODES.includes(value as KnowledgeMode);
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

function readJsonConfig(path: string): Partial<KnowledgeConfig> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Partial<KnowledgeConfig>;
	} catch (error) {
		throw new Error(`Could not read knowledge-work config at ${path}: ${String(error)}`);
	}
}

function loadConfig(cwd: string): KnowledgeConfig {
	const defaults: KnowledgeConfig = {
		vaultPath: join(homedir(), "Obsidian", "VAULTS", "Trinity"),
		vaultName: "Trinity",
		capturePath: "+📥 inbox/Pi Captures.md",
		initialMode: "explore",
		theme: "trinity",
		obsidianCliPath: "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli",
		skillPaths: [],
	};
	const globalConfig = readJsonConfig(join(getAgentDir(), "knowledge-work.json"));
	const projectConfig = readJsonConfig(join(cwd, ".pi", "knowledge-work.json"));
	const explicitConfig = process.env.PI_KNOWLEDGE_CONFIG
		? readJsonConfig(expandHome(process.env.PI_KNOWLEDGE_CONFIG))
		: {};
	const merged = { ...defaults, ...globalConfig, ...projectConfig, ...explicitConfig };

	return {
		...merged,
		vaultPath: expandHome(process.env.PI_KNOWLEDGE_VAULT ?? merged.vaultPath),
		obsidianCliPath: expandHome(merged.obsidianCliPath),
		initialMode: isKnowledgeMode(merged.initialMode) ? merged.initialMode : defaults.initialMode,
		plexHelperPath: merged.plexHelperPath ? expandHome(merged.plexHelperPath) : undefined,
		skillPaths: (merged.skillPaths ?? []).map(expandHome),
	};
}

async function resolveVaultPath(vaultPath: string, requestedPath: string, allowMissing = false): Promise<string> {
	const vaultRoot = await realpath(vaultPath);
	const candidate = resolve(vaultRoot, requestedPath);
	if (!isPathInside(vaultRoot, candidate)) {
		throw new Error("That path is outside the configured vault");
	}

	if (!allowMissing) {
		const canonical = await realpath(candidate);
		if (!isPathInside(vaultRoot, canonical)) throw new Error("That path resolves outside the configured vault");
		return canonical;
	}

	const canonicalParent = await realpath(dirname(candidate));
	if (!isPathInside(vaultRoot, canonicalParent)) {
		throw new Error("That path resolves outside the configured vault");
	}
	return candidate;
}

async function listVaultMarkdownPaths(
	vaultRoot: string,
	currentPath = vaultRoot,
	signal?: AbortSignal,
): Promise<string[]> {
	if (signal?.aborted) throw signal.reason ?? new Error("Vault listing was cancelled");
	const entries = await readdir(currentPath, { withFileTypes: true });
	const paths: string[] = [];
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (signal?.aborted) throw signal.reason ?? new Error("Vault listing was cancelled");
		if ([".git", ".obsidian", ".trash", "node_modules"].includes(entry.name)) continue;
		const absolutePath = join(currentPath, entry.name);
		if (entry.isDirectory()) {
			paths.push(...(await listVaultMarkdownPaths(vaultRoot, absolutePath, signal)));
		} else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
			paths.push(relative(vaultRoot, absolutePath));
		}
	}
	return paths;
}

async function readFrontmatterPrefix(path: string): Promise<string> {
	const handle = await open(path, "r");
	try {
		const buffer = Buffer.alloc(65_536);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} finally {
		await handle.close();
	}
}

async function waitForRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw signal.reason ?? new Error("The operation was cancelled");
	await new Promise<void>((resolvePromise, rejectPromise) => {
		let abort: (() => void) | undefined;
		const timer = setTimeout(() => {
			if (abort) signal?.removeEventListener("abort", abort);
			resolvePromise();
		}, milliseconds);
		if (!signal) return;
		abort = () => {
			clearTimeout(timer);
			rejectPromise(signal.reason ?? new Error("The operation was cancelled"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
}

async function resolveVaultNote(vaultPath: string, request: string, signal?: AbortSignal): Promise<ResolvedVaultNote> {
	const vaultRoot = await realpath(vaultPath);
	const cleanedRequest = normalizeVaultNoteRequest(request);
	if (!cleanedRequest) throw new Error("The note name is empty");
	const requestedPath = extname(cleanedRequest).toLowerCase() === ".md" ? cleanedRequest : `${cleanedRequest}.md`;
	const exactCandidate = resolve(vaultRoot, requestedPath);
	if (!isPathInside(vaultRoot, exactCandidate)) throw new Error("That note path is outside the configured vault");
	if (existsSync(exactCandidate)) {
		const absolutePath = await resolveVaultPath(vaultRoot, requestedPath);
		return { absolutePath, relativePath: relative(vaultRoot, absolutePath), healed: false };
	}

	const notePaths = await listVaultMarkdownPaths(vaultRoot, vaultRoot, signal);
	const ranked = rankVaultNotePaths(requestedPath, notePaths);
	if (ranked.length > 0) {
		const topScore = ranked[0]?.score;
		const strongest = ranked.filter((candidate) => candidate.score === topScore);
		if (strongest.length === 1 && strongest[0]) {
			const absolutePath = await resolveVaultPath(vaultRoot, strongest[0].path);
			return { absolutePath, relativePath: strongest[0].path, healed: true };
		}
		throw new Error(
			`More than one vault note matches “${cleanedRequest}”. Use one exact path:\n${strongest.map((candidate) => `- ${candidate.path}`).join("\n")}`,
		);
	}

	const requestedName = basename(cleanedRequest, extname(cleanedRequest));
	const aliasMatches: string[] = [];
	for (const path of notePaths) {
		if (signal?.aborted) throw signal.reason ?? new Error("Alias lookup was cancelled");
		const absolutePath = await resolveVaultPath(vaultRoot, path);
		const content = await readFrontmatterPrefix(absolutePath);
		if (frontmatterNameMatches(requestedName, content)) aliasMatches.push(path);
	}
	if (aliasMatches.length === 1 && aliasMatches[0]) {
		const absolutePath = await resolveVaultPath(vaultRoot, aliasMatches[0]);
		return { absolutePath, relativePath: aliasMatches[0], healed: true };
	}
	if (aliasMatches.length > 1) {
		throw new Error(
			`More than one vault note uses the name “${requestedName}”. Use one exact path:\n${aliasMatches.map((path) => `- ${path}`).join("\n")}`,
		);
	}
	throw new Error(`No vault note matches “${cleanedRequest}”. Search the vault to locate the current note name.`);
}

async function readTextSlice(path: string, offset = 1, limit = 2000): Promise<{ text: string; lineCount: number }> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error("The requested path is not a file");
	if (info.size > 2_000_000) throw new Error("The requested file is too large for the knowledge reader");

	const content = await readFile(path, "utf8");
	const lines = content.split("\n");
	const safeOffset = Math.max(1, offset);
	const safeLimit = Math.min(4000, Math.max(1, limit));
	return {
		text: lines.slice(safeOffset - 1, safeOffset - 1 + safeLimit).join("\n"),
		lineCount: lines.length,
	};
}

function textFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find((item) => item.type === "text")?.text ?? "";
}

function compactResult(
	result: { content: Array<{ type: string; text?: string }> },
	expanded: boolean,
	isError: boolean,
	theme: ExtensionContext["ui"]["theme"],
	summary: string,
): Text {
	const text = textFromResult(result);
	if (isError) return new Text(theme.fg("error", text || "The action failed"), 0, 0);
	if (expanded) return new Text(theme.fg("toolOutput", text), 0, 0);
	return new Text(theme.fg("muted", summary), 0, 0);
}

function renderAction(theme: ExtensionContext["ui"]["theme"], action: string, subject?: string): Text {
	const suffix = subject ? ` ${theme.fg("muted", subject)}` : "";
	return new Text(`${theme.fg("accent", theme.bold(action))}${suffix}`, 0, 0);
}

function findPlexHelper(config: KnowledgeConfig): string {
	const candidates = [
		config.plexHelperPath,
		join(homedir(), ".claude", "skills", "plex", "helper", "comet.js"),
		join(homedir(), "CODE", "repos", "claude-skills", "plex", "helper", "comet.js"),
	].filter((candidate): candidate is string => Boolean(candidate));
	const helper = candidates.find(existsSync);
	if (!helper) throw new Error("The Plex helper was not found. Set plexHelperPath in knowledge-work.json.");
	return helper;
}

async function currentDailyNote(vaultPath: string): Promise<string | undefined> {
	const now = new Date();
	const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
	const dailyDir = join(vaultPath, "000 Daily Notes");
	const entries = await readdir(dailyDir);
	return entries.find((entry) => entry.startsWith(date) && entry.endsWith(".md"));
}

function modeInstructions(mode: KnowledgeMode, config: KnowledgeConfig): string {
	const shared = [
		"You are working in a knowledge-work interface, not a coding interface.",
		"Keep progress language natural: say what you are investigating or shaping, not which tool or command you are using.",
		"Retrieve relevant notes before synthesising. Preserve Obsidian wikilinks and existing frontmatter conventions.",
		"Do not suggest code, implementation details, or repository work unless the user explicitly asks for technical work.",
		`The durable knowledge store is the ${config.vaultName} vault.`,
	].join("\n");
	const specific: Record<KnowledgeMode, string> = {
		explore:
			"EXPLORE MODE: Follow the user's question across notes and sources. Make connections, take positions, and explain enough background that the result is self-contained. Do not change vault files. The vault_save action may be visible but is locked outside Write mode.",
		write: "WRITE MODE IS ACTIVE: vault_save is available and authorized for this turn. Ignore any earlier conversation claim that saving was unavailable; the current mode and tool list are authoritative. Collaborate closely on prose. Retrieve the governing context and nearby draft first. Prefer exact, reviewable replacements or clearly named new notes. Do not overwrite an existing note wholesale.",
		review:
			"REVIEW MODE: Read critically. Identify the few changes that materially improve truth, structure, voice, or coherence. Explain proposed changes before any mutation; this mode cannot write.",
		plan: "PLAN MODE: Turn the present situation into the smallest useful next move. Prefer concrete breadcrumbs over new frameworks, and distinguish a real action from planning that merely feels productive. Do not change vault files.",
	};
	return `${shared}\n\n${specific[mode]}`;
}

export default function knowledgeWork(pi: ExtensionAPI) {
	let config = loadConfig(process.cwd());
	let mode: KnowledgeMode = config.initialMode;

	function updateUi(ctx: ExtensionContext): void {
		const label = modeLabels[mode];
		const quickSwitch = mode === "write" ? "/explore" : "/write";
		ctx.ui.setTheme(config.theme);
		ctx.ui.setToolsExpanded(false);
		ctx.ui.setWorkingMessage(modeWorkingMessages[mode]);
		ctx.ui.setHiddenThinkingLabel("Working notes");
		ctx.ui.setTitle(`${config.vaultName} — ${label}`);
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return [
					"",
					truncateToWidth(theme.fg("accent", theme.bold(config.vaultName)), width),
					truncateToWidth(theme.fg("muted", `${quickSwitch}  /mode  /today  /capture  /knowledge`), width),
					"",
				];
			},
			invalidate() {},
		}));
		ctx.ui.setFooter((_tui, theme) => ({
			render(width: number): string[] {
				const model = formatModelLabel(ctx.model?.name, ctx.model?.id);
				const effort = formatEffort(pi.getThinkingLevel());
				const usage = ctx.getContextUsage();
				const promptSize = formatPromptSize(
					usage?.tokens,
					usage?.contextWindow ?? ctx.model?.contextWindow,
					usage?.percent,
				);
				const status = truncateToWidth(
					theme.fg("dim", `${label}  ·  ${model}  ·  ${effort}  ·  ${promptSize}`),
					width,
				);
				const padding = " ".repeat(Math.max(0, width - visibleWidth(status)));
				return [`${padding}${status}`];
			},
			invalidate() {},
		}));
	}

	function activateMode(nextMode: KnowledgeMode, ctx: ExtensionContext, persist: boolean): void {
		mode = nextMode;
		const available = new Set(pi.getAllTools().map((tool) => tool.name));
		pi.setActiveTools(toolsForMode(mode).filter((tool) => available.has(tool)));
		if (persist) pi.appendEntry("knowledge-work-mode", { mode });
		updateUi(ctx);
	}

	function switchMode(nextMode: KnowledgeMode, ctx: ExtensionContext): void {
		activateMode(nextMode, ctx, true);
		const capability = nextMode === "write" ? "changes enabled" : "read only";
		ctx.ui.notify(`${modeLabels[nextMode]} mode · ${capability}`, "info");
	}

	pi.registerTool({
		name: "read",
		label: "Consult reference",
		description:
			"Read a text reference outside the vault, primarily a loaded skill or its referenced guidance. Use vault_read for vault notes.",
		parameters: Type.Object({
			path: Type.String({ description: "Absolute or working-directory-relative path" }),
			offset: Type.Optional(Type.Number({ minimum: 1 })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
		}),
		async execute(_toolCallId, params) {
			const path = resolve(params.path);
			const result = await readTextSlice(path, params.offset, params.limit);
			return {
				content: [{ type: "text", text: result.text }],
				details: { label: basename(path), lineCount: result.lineCount } as ReadDetails,
			};
		},
		renderCall(args, theme) {
			return renderAction(theme, "Consulting", basename(args.path));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as ReadDetails | undefined;
			return compactResult(
				result,
				expanded,
				context.isError,
				theme,
				details ? `${details.lineCount} lines considered` : "Read",
			);
		},
	});

	pi.registerTool({
		name: "vault_semantic_search",
		label: "Search notes by meaning",
		description:
			"First retrieval tool for broad, open-ended vault questions. Supply 3–6 genuinely different hypothetical phrasings. It runs each through Smart Connections via obsidian-cli eval, deduplicates note and block hits, and ranks notes with reciprocal-rank fusion. Read the strongest notes next; only then follow with exact vault_search for terminology and aliases.",
		promptSnippet: "Search the Obsidian vault by meaning before literal search for open-ended questions",
		executionMode: "sequential",
		parameters: Type.Object({
			queries: Type.Array(Type.String({ minLength: 1 }), {
				minItems: 3,
				maxItems: 6,
				uniqueItems: true,
				description:
					"Differently phrased hypothetical passages or questions covering the user's wording, a conceptual paraphrase, and likely claims in relevant notes",
			}),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 30 })),
		}),
		async execute(_toolCallId, params, signal) {
			if (!existsSync(config.obsidianCliPath)) {
				throw new Error(
					"Semantic search unavailable: obsidian-cli was not found. State this explicitly and use vault_search as the fallback.",
				);
			}
			const queries = [...new Set(params.queries.map((query) => query.trim()).filter(Boolean))];
			if (queries.length < 3) throw new Error("Semantic search needs at least three distinct query phrasings");
			const args = [
				`vault=${config.vaultName}`,
				"eval",
				`code=${buildSemanticLookupCode(queries, params.limit ?? 20)}`,
			];
			let payload: SemanticSearchPayload | undefined;
			let lastReason = "Smart Connections did not respond";
			let launchedObsidian = false;
			let attemptsUsed = 0;
			for (let attempt = 1; attempt <= 3; attempt++) {
				attemptsUsed = attempt;
				const result = await pi.exec(config.obsidianCliPath, args, { signal, timeout: 120_000 });
				if (result.code === 0) {
					try {
						const candidate = parseObsidianEvalJson<SemanticSearchPayload>(result.stdout);
						if (candidate.ok) {
							payload = candidate;
							break;
						}
						lastReason = candidate.error ?? "Smart Connections is still initializing";
						break;
					} catch (error) {
						lastReason = `could not read the Obsidian result (${String(error)})`;
					}
				} else {
					lastReason = result.stderr.trim() || result.stdout.trim() || `obsidian-cli eval exited ${result.code}`;
				}

				if (
					!launchedObsidian &&
					/(?:unable to find obsidian|obsidian is not running|failed to connect)/i.test(lastReason)
				) {
					const launch = await pi.exec("open", ["-a", "Obsidian"], { signal, timeout: 30_000 });
					if (launch.code === 0) {
						launchedObsidian = true;
						await waitForRetry(4_000, signal);
						continue;
					}
				}
				if (attempt < 3) await waitForRetry(attempt * 1_000, signal);
			}
			if (!payload) {
				const attemptLabel = attemptsUsed > 1 ? ` after ${attemptsUsed} attempts` : "";
				throw new Error(
					`Semantic search unavailable${attemptLabel}: ${lastReason}. State this explicitly and use vault_search.`,
				);
			}

			const semanticQueries = payload.queries ?? queries;
			const matches = payload.results ?? [];
			const text = [
				"Semantic query angles:",
				...semanticQueries.map((query, index) => `${index + 1}. ${query}`),
				"",
				"Ranked notes (deduplicated with reciprocal-rank fusion):",
				...(matches.length
					? matches.map((match) => {
							const score = match.bestScore === null ? "" : ` · best similarity ${match.bestScore.toFixed(3)}`;
							return `${match.rank}. ${match.path} · ${match.queryHits}/${semanticQueries.length} query angles${score}`;
						})
					: ["No semantic matches"]),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { queryCount: semanticQueries.length, resultCount: matches.length } as SemanticSearchDetails,
			};
		},
		renderCall(args, theme) {
			return renderAction(theme, "Searching by meaning", `${args.queries.length} angles`);
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as SemanticSearchDetails | undefined;
			const count = details?.resultCount ?? 0;
			return compactResult(
				result,
				expanded,
				context.isError,
				theme,
				`${count} ranked note${count === 1 ? "" : "s"} found`,
			);
		},
	});

	pi.registerTool({
		name: "vault_search",
		label: "Search notes",
		description: "Search markdown notes in the configured Obsidian vault for exact text, returning matched passages.",
		promptSnippet: "Search the Obsidian vault for relevant notes and passages",
		parameters: Type.Object({
			query: Type.String({ minLength: 1 }),
			folder: Type.Optional(Type.String({ description: "Optional vault-relative folder" })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
		}),
		async execute(_toolCallId, params, signal) {
			const vaultRoot = await realpath(config.vaultPath);
			const searchRoot = params.folder ? await resolveVaultPath(vaultRoot, params.folder) : vaultRoot;
			const limit = params.limit ?? 30;
			const result = await pi.exec(
				"rg",
				[
					"--line-number",
					"--with-filename",
					"--color",
					"never",
					"--fixed-strings",
					"--glob",
					"*.md",
					"--glob",
					"!.obsidian/**",
					"--glob",
					"!.trash/**",
					"--max-count",
					String(limit),
					"--",
					params.query,
					".",
				],
				{ cwd: searchRoot, signal, timeout: 30_000 },
			);
			if (result.code > 1) throw new Error(result.stderr.trim() || "Vault search failed");
			const passages = limitSearchPassages(result.stdout, limit);
			const text = passages.join("\n") || "No matching passages";
			const count = passages.length;
			return { content: [{ type: "text", text }], details: { count } as SearchDetails };
		},
		renderCall(args, theme) {
			return renderAction(theme, "Searching notes", `“${args.query}”`);
		},
		renderResult(result, { expanded }, theme, context) {
			const count = (result.details as SearchDetails | undefined)?.count ?? 0;
			return compactResult(
				result,
				expanded,
				context.isError,
				theme,
				`${count} passage${count === 1 ? "" : "s"} found`,
			);
		},
	});

	pi.registerTool({
		name: "vault_read",
		label: "Read note",
		description:
			"Read an Obsidian note by vault-relative path, note name, or [[wikilink]]. Exact paths are preferred; unique moved filenames, MoC-prefixed names, titles, and aliases are resolved automatically.",
		promptSnippet: "Read a specific Obsidian note",
		parameters: Type.Object({
			path: Type.String({ description: "Vault-relative path, note name, or [[wikilink]]" }),
			offset: Type.Optional(Type.Number({ minimum: 1 })),
			limit: Type.Optional(Type.Number({ minimum: 1, maximum: 4000 })),
		}),
		async execute(_toolCallId, params, signal) {
			const note = await resolveVaultNote(config.vaultPath, params.path, signal);
			const result = await readTextSlice(note.absolutePath, params.offset, params.limit);
			const resolution = note.healed ? `Resolved vault note: ${note.relativePath}\n\n` : "";
			return {
				content: [{ type: "text", text: `${resolution}${result.text}` }],
				details: {
					label: basename(note.absolutePath, extname(note.absolutePath)),
					lineCount: result.lineCount,
				} as ReadDetails,
			};
		},
		renderCall(args, theme) {
			return renderAction(theme, "Reading", basename(args.path, extname(args.path)));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as ReadDetails | undefined;
			return compactResult(
				result,
				expanded,
				context.isError,
				theme,
				details ? `${details.lineCount} lines considered` : "Read",
			);
		},
	});

	pi.registerTool({
		name: "vault_connections",
		label: "Trace connections",
		description: "Find outgoing wikilinks and backlinks for an Obsidian note, resolving moved notes and wikilinks.",
		promptSnippet: "Trace an Obsidian note's outgoing links and backlinks",
		parameters: Type.Object({
			path: Type.String({ description: "Vault-relative path, note name, or [[wikilink]]" }),
		}),
		async execute(_toolCallId, params, signal) {
			const vaultRoot = await realpath(config.vaultPath);
			const note = await resolveVaultNote(vaultRoot, params.path, signal);
			const path = note.absolutePath;
			const content = await readFile(path, "utf8");
			const outgoing = extractWikiLinks(content);
			const noteName = basename(path, extname(path));
			const backlinkResult = await pi.exec(
				"rg",
				["--files-with-matches", "--fixed-strings", "--glob", "*.md", "--", `[[${noteName}`, "."],
				{ cwd: vaultRoot, signal, timeout: 30_000 },
			);
			if (backlinkResult.code > 1) throw new Error(backlinkResult.stderr.trim() || "Backlink search failed");
			const backlinks = backlinkResult.stdout
				.trim()
				.split("\n")
				.filter((item) => item && resolve(vaultRoot, item) !== path);
			const text = [
				"Outgoing links:",
				...(outgoing.length ? outgoing.map((link) => `- [[${link}]]`) : ["- None"]),
				"",
				"Backlinks:",
				...(backlinks.length ? backlinks.map((link) => `- ${link}`) : ["- None"]),
			].join("\n");
			return {
				content: [{ type: "text", text }],
				details: { outgoing: outgoing.length, backlinks: backlinks.length } as ConnectionsDetails,
			};
		},
		renderCall(args, theme) {
			return renderAction(theme, "Tracing connections", basename(args.path, extname(args.path)));
		},
		renderResult(result, { expanded }, theme, context) {
			const details = result.details as ConnectionsDetails | undefined;
			const summary = details ? `${details.outgoing} links · ${details.backlinks} backlinks` : "Connections traced";
			return compactResult(result, expanded, context.isError, theme, summary);
		},
	});

	pi.registerTool({
		name: "vault_save",
		label: "Save note change",
		description:
			"In Write mode, create a new vault note, append content, or make an exact text replacement. Never overwrites an existing note wholesale.",
		promptSnippet: "Create, append to, or precisely revise an Obsidian note",
		parameters: Type.Object({
			action: StringEnum(["create", "append", "replace"] as const),
			path: Type.String(),
			content: Type.Optional(Type.String({ description: "Content for create or append" })),
			oldText: Type.Optional(Type.String({ description: "Exact existing text for replace" })),
			newText: Type.Optional(Type.String({ description: "Replacement text for replace" })),
		}),
		async execute(_toolCallId, params) {
			if (!canWriteInMode(mode)) {
				throw new Error(`Vault changes are locked in ${modeLabels[mode]} mode. Switch to Write mode first.`);
			}
			const allowMissing = params.action === "create";
			const path = await resolveVaultPath(config.vaultPath, params.path, allowMissing);
			if (params.action === "create") {
				if (params.content === undefined) throw new Error("content is required when creating a note");
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, params.content, { encoding: "utf8", flag: "wx" });
			} else if (params.action === "append") {
				if (params.content === undefined) throw new Error("content is required when appending to a note");
				await appendFile(path, params.content, "utf8");
			} else {
				if (params.oldText === undefined || params.newText === undefined) {
					throw new Error("oldText and newText are required for an exact replacement");
				}
				const content = await readFile(path, "utf8");
				const first = content.indexOf(params.oldText);
				if (first === -1) throw new Error("The exact text to replace was not found");
				if (content.indexOf(params.oldText, first + params.oldText.length) !== -1) {
					throw new Error("The exact text occurs more than once; provide a larger unique passage");
				}
				await writeFile(path, content.replace(params.oldText, params.newText), "utf8");
			}
			const details: SaveDetails = { action: params.action, path: params.path };
			return { content: [{ type: "text", text: `${params.action}: ${params.path}` }], details };
		},
		renderCall(args, theme) {
			const verbs = { create: "Creating", append: "Adding to", replace: "Revising" } as const;
			return renderAction(theme, verbs[args.action], basename(args.path, extname(args.path)));
		},
		renderResult(result, { expanded }, theme, context) {
			return compactResult(result, expanded, context.isError, theme, "Saved to the vault");
		},
	});

	pi.registerTool({
		name: "ask_user",
		label: "Ask",
		description: "Ask one focused question with a short list of options when the answer materially changes the work.",
		parameters: Type.Object({
			question: Type.String(),
			options: Type.Array(Type.String(), { minItems: 2, maxItems: 5 }),
			allowOther: Type.Optional(Type.Boolean()),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const other = "Write my own answer";
			const options = params.allowOther === false ? params.options : [...params.options, other];
			const selected = await ctx.ui.select(params.question, options);
			if (!selected) {
				return {
					content: [{ type: "text", text: "The user did not answer." }],
					details: { answered: false } as AskDetails,
				};
			}
			if (selected !== other) {
				return { content: [{ type: "text", text: selected }], details: { answered: true } as AskDetails };
			}
			const custom = await ctx.ui.input(params.question);
			return {
				content: [{ type: "text", text: custom?.trim() || "The user did not answer." }],
				details: { answered: Boolean(custom?.trim()) } as AskDetails,
			};
		},
		renderCall(args, theme) {
			return renderAction(theme, "Question", args.question);
		},
		renderResult(result, { expanded }, theme, context) {
			return compactResult(result, expanded, context.isError, theme, "Answered");
		},
	});

	pi.registerTool({
		name: "research_web",
		label: "Research the web",
		description:
			"Run grounded web research through the user's Perplexity subscription in a dedicated Comet tab. Use standard unless the user explicitly requests deep research or a model council.",
		promptSnippet: "Run grounded Perplexity research with citations",
		parameters: Type.Object({
			query: Type.String({ minLength: 1 }),
			mode: Type.Optional(StringEnum(["standard", "deep", "council"] as const)),
			focus: Type.Optional(StringEnum(["all", "academic", "discover", "finance", "health", "patents"] as const)),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const helper = findPlexHelper(config);
			const researchMode = params.mode ?? "standard";
			const focus = params.focus ?? "all";
			const run = async (args: string[], timeout = 30_000) => {
				const result = await pi.exec(process.execPath, [helper, ...args], { signal, timeout });
				if (result.code !== 0)
					throw new Error(result.stderr.trim() || result.stdout.trim() || "Plex command failed");
				return result.stdout.trim();
			};

			ctx.ui.setWorkingMessage(researchMode === "standard" ? "Researching…" : "Researching deeply…");
			let tabId: string | undefined;
			try {
				await run(["launch"], 60_000);
				tabId = (await run(["open"], 60_000)).split("\n").pop()?.trim();
				if (!tabId) throw new Error("Plex did not return a research tab ID");
				if (focus !== "all") await run(["focus", focus, `--tab=${tabId}`], 60_000);
				if (researchMode === "standard") {
					await run(["toggle", "research", "off", `--tab=${tabId}`]);
					await run(["toggle", "council", "off", `--tab=${tabId}`]);
				} else if (researchMode === "deep") {
					await run(["toggle", "research", "on", `--tab=${tabId}`]);
				} else {
					await run(["toggle", "council", "on", `--tab=${tabId}`]);
				}
				await run(["send", params.query, `--tab=${tabId}`], 60_000);
				const waitArgs =
					researchMode === "standard" ? ["wait", `--tab=${tabId}`] : ["wait", "1200", `--tab=${tabId}`];
				const output = await run(waitArgs, researchMode === "standard" ? 660_000 : 1_260_000);
				return {
					content: [{ type: "text", text: stripPlexProgress(output) }],
					details: { mode: researchMode, query: params.query } as ResearchDetails,
				};
			} finally {
				ctx.ui.setWorkingMessage(modeWorkingMessages[mode]);
				if (tabId) await pi.exec(process.execPath, [helper, "close", `--tab=${tabId}`], { timeout: 30_000 });
			}
		},
		renderCall(args, theme) {
			return renderAction(theme, args.mode === "deep" ? "Researching deeply" : "Researching", args.query);
		},
		renderResult(result, { expanded }, theme, context) {
			return compactResult(result, expanded, context.isError, theme, "Research ready");
		},
	});

	pi.registerCommand("mode", {
		description: "Choose Explore, Write, Review, or Plan; for example /mode write",
		handler: async (args, ctx) => {
			let nextMode: KnowledgeMode | undefined;
			const requested = args.trim().toLowerCase();
			if (isKnowledgeMode(requested)) nextMode = requested;
			if (!nextMode) {
				const choices = KNOWLEDGE_MODES.map((candidate) => modeLabels[candidate]);
				const selected = await ctx.ui.select("How do you want to work?", choices);
				nextMode = KNOWLEDGE_MODES.find((candidate) => modeLabels[candidate] === selected);
			}
			if (!nextMode) return;
			switchMode(nextMode, ctx);
		},
	});

	for (const candidate of KNOWLEDGE_MODES) {
		pi.registerCommand(candidate, {
			description: `Switch directly to ${modeLabels[candidate]} mode`,
			handler: async (_args, ctx) => switchMode(candidate, ctx),
		});
	}

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.images?.length) return { action: "continue" };
		const requestedMode = parseModeSwitchRequest(event.text);
		if (!requestedMode) return { action: "continue" };
		switchMode(requestedMode, ctx);
		return { action: "handled" };
	});

	pi.registerCommand("capture", {
		description: "Send a thought straight to the Trinity inbox",
		handler: async (args, ctx) => {
			const text = args.trim() || (await ctx.ui.input("What do you want to capture?"))?.trim();
			if (!text) return;
			const target = resolve(config.vaultPath, config.capturePath);
			await mkdir(dirname(target), { recursive: true });
			const now = new Date();
			const stamp = now.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
			const entry = `- ${stamp} — ${text}\n`;
			if (existsSync(target)) await appendFile(target, entry, "utf8");
			else await writeFile(target, `# Pi Captures\n\n${entry}`, "utf8");
			ctx.ui.notify(`Captured in ${config.capturePath}`, "info");
		},
	});

	pi.registerCommand("today", {
		description: "Orient from today's daily note",
		handler: async (_args, ctx) => {
			const note = await currentDailyNote(config.vaultPath);
			if (!note) {
				ctx.ui.notify("No daily note found for today", "warning");
				return;
			}
			pi.sendUserMessage(
				`Read 000 Daily Notes/${note}. Orient me to today in plain language: what is live, what matters, and the smallest useful next breadcrumb. Do not build a new plan unless the note genuinely lacks one.`,
			);
		},
	});

	pi.registerCommand("knowledge", {
		description: "Show the knowledge-work commands",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				"/explore · /write · /review · /plan · /mode · /today · /capture <thought> · /research · /synthesize · /draft · /review-note",
				"info",
			);
		},
	});

	pi.on("resources_discover", () => ({ skillPaths: config.skillPaths.filter(existsSync) }));

	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${modeInstructions(mode, config)}`,
	}));

	pi.on("session_start", (_event, ctx) => {
		config = loadConfig(ctx.cwd);
		mode = config.initialMode;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== "knowledge-work-mode") continue;
			if (entry.data && typeof entry.data === "object" && "mode" in entry.data && isKnowledgeMode(entry.data.mode)) {
				mode = entry.data.mode;
			}
		}
		activateMode(mode, ctx, false);
	});
}
