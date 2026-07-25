import { basename, dirname, extname, isAbsolute, relative } from "node:path";

export const KNOWLEDGE_MODES = ["explore", "write", "review", "plan"] as const;
export type KnowledgeMode = (typeof KNOWLEDGE_MODES)[number];

const readOnlyTools = [
	"read",
	"vault_semantic_search",
	"vault_search",
	"vault_read",
	"vault_connections",
	"research_web",
	"ask_user",
];

export function toolsForMode(mode: KnowledgeMode): string[] {
	void mode;
	return [...readOnlyTools, "vault_save"];
}

export function canWriteInMode(mode: KnowledgeMode): boolean {
	return mode === "write";
}

export function parseModeSwitchRequest(text: string): KnowledgeMode | undefined {
	const match = text
		.trim()
		.toLowerCase()
		.match(
			/^(?:(?:can|could|would|will)\s+you\s+)?(?:please\s+)?(?:(?:switch|change|go|move|get|put)\s+(?:(?:me|us)\s+)?(?:(?:to|into|in)\s+)?)?(explore|write|review|plan)\s+mode(?:\s+(?:now|please))?[.!?]?$/,
		);
	const requested = match?.[1];
	return requested && KNOWLEDGE_MODES.includes(requested as KnowledgeMode) ? (requested as KnowledgeMode) : undefined;
}

export function isPathInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function extractWikiLinks(text: string): string[] {
	const links = new Set<string>();
	for (const match of text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)) {
		const target = match[1]?.trim();
		if (target) links.add(target);
	}
	return [...links];
}

function escapeMarkdownLinkLabel(label: string): string {
	return label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function renderObsidianWikiLinks(text: string, vaultName: string): string {
	return text.replace(/(?<!!)\[\[([^\]|\n]+?)(?:\|([^\]\n]+))?\]\]/g, (wikilink, rawTarget, rawAlias) => {
		const target = String(rawTarget).trim();
		if (!target) return wikilink;
		const targetWithoutHeading = target.split("#", 1)[0] ?? target;
		const fallbackLabel = basename(targetWithoutHeading) || target;
		const label = String(rawAlias ?? fallbackLabel).trim() || fallbackLabel;
		const href = `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(target)}`;
		return `[${escapeMarkdownLinkLabel(label)}](${href})`;
	});
}

export function stripPlexProgress(output: string): string {
	const marker = output.lastIndexOf("complete —");
	if (marker === -1) return output.trim();
	const contentStart = output.indexOf("\n", marker);
	return contentStart === -1 ? output.trim() : output.slice(contentStart + 1).trim();
}

export function buildSemanticLookupCode(queries: string[], limit: number): string {
	const distinctQueries = [...new Set(queries.map((query) => query.trim()).filter(Boolean))];
	const resultLimit = Math.min(30, Math.max(1, Math.floor(limit)));
	const perQueryLimit = Math.min(100, Math.max(20, resultLimit * 3));
	const serializedQueries = JSON.stringify(distinctQueries)
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");

	return `(async () => {
	try {
		const pluginId = "smart-connections";
		const readinessDeadline = Date.now() + 30000;
		let plugin;
		let env;
		let sources;
		do {
			plugin = app.plugins.plugins[pluginId];
			env = plugin?.env;
			sources = env?.smart_sources;
			if (typeof sources?.lookup === "function") break;
			await new Promise((resolve) => setTimeout(resolve, 750));
		} while (Date.now() < readinessDeadline);
		if (typeof sources?.lookup !== "function") {
			const stage = !plugin ? "plugin object missing" : !env ? "environment missing" : !sources ? "smart_sources missing" : "lookup method missing";
			const enabled = app.plugins.enabledPlugins?.has(pluginId) ?? false;
			return JSON.stringify({
				ok: false,
				error: \`Smart Connections did not become ready within 30 seconds (\${stage}; enabled: \${enabled})\`,
			});
		}
		const queries = ${serializedQueries};
		const fused = new Map();
		for (let queryIndex = 0; queryIndex < queries.length; queryIndex++) {
			const hits = await sources.lookup({ hypotheticals: [queries[queryIndex]], k: ${perQueryLimit} });
			const seenForQuery = new Set();
			let sourceRank = 0;
			for (const hit of hits) {
				const rawKey = hit?.key ?? hit?.item?.key ?? hit?.item?.path;
				if (!rawKey) continue;
				const path = String(rawKey).split("#", 1)[0];
				if (!path.endsWith(".md") || seenForQuery.has(path)) continue;
				seenForQuery.add(path);
				sourceRank++;
				const score = Number.isFinite(hit?.score) ? hit.score : null;
				const existing = fused.get(path) ?? {
					path,
					rrfScore: 0,
					bestScore: null,
					queryIndexes: [],
				};
				existing.rrfScore += 1 / (60 + sourceRank);
				if (score !== null && (existing.bestScore === null || score > existing.bestScore)) existing.bestScore = score;
				existing.queryIndexes.push(queryIndex + 1);
				fused.set(path, existing);
			}
		}
		const results = [...fused.values()]
			.sort((a, b) => b.rrfScore - a.rrfScore || (b.bestScore ?? -Infinity) - (a.bestScore ?? -Infinity) || a.path.localeCompare(b.path))
			.slice(0, ${resultLimit})
			.map((item, index) => ({
				rank: index + 1,
				path: item.path,
				queryHits: item.queryIndexes.length,
				queryIndexes: item.queryIndexes,
				rrfScore: Number(item.rrfScore.toFixed(6)),
				bestScore: item.bestScore === null ? null : Number(item.bestScore.toFixed(6)),
			}));
		return JSON.stringify({ ok: true, queries, results });
	} catch (error) {
		return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
	}
})()`;
}

export function parseObsidianEvalJson<T>(output: string): T {
	const marker = output.lastIndexOf("=>");
	if (marker === -1) throw new Error("Obsidian eval returned no result marker");
	const payload = output.slice(marker + 2).trim();
	if (!payload) throw new Error("Obsidian eval returned an empty result");
	return JSON.parse(payload) as T;
}

export function limitSearchPassages(output: string, limit: number): string[] {
	return output
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(0, Math.max(0, Math.floor(limit)));
}

export function normalizeVaultNoteRequest(request: string): string {
	let normalized = request.trim();
	if (normalized.startsWith("[[")) {
		const closing = normalized.indexOf("]]", 2);
		normalized = normalized.slice(2, closing === -1 ? undefined : closing);
		const alias = normalized.indexOf("|");
		if (alias !== -1) normalized = normalized.slice(0, alias);
	}
	const heading = normalized.indexOf("#");
	if (heading !== -1) normalized = normalized.slice(0, heading);
	return normalized.trim();
}

function normalizedNoteName(value: string): string {
	return value.normalize("NFKC").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

function withoutMocPrefix(value: string): string {
	return value.replace(/^moc\s*-\s*/i, "");
}

export interface RankedVaultNotePath {
	path: string;
	score: number;
}

export function rankVaultNotePaths(request: string, candidatePaths: string[]): RankedVaultNotePath[] {
	const cleanedRequest = normalizeVaultNoteRequest(request);
	const requestedBase = normalizedNoteName(basename(cleanedRequest, extname(cleanedRequest)));
	const requestedWithoutMoc = withoutMocPrefix(requestedBase);
	const requestedHasMocPrefix = requestedBase !== requestedWithoutMoc;
	const requestedDir = normalizedNoteName(dirname(cleanedRequest));
	const requestedDirParts = requestedDir === "." ? [] : requestedDir.split("/").filter(Boolean);
	const requestedMocFolder = requestedDirParts.some((part) => part.includes("moc") || part === "schools");

	return candidatePaths
		.map((path): RankedVaultNotePath | undefined => {
			const candidateBase = normalizedNoteName(basename(path, extname(path)));
			const candidateWithoutMoc = withoutMocPrefix(candidateBase);
			const exactName = candidateBase === requestedBase;
			const mocEquivalent = candidateWithoutMoc === requestedWithoutMoc;
			if (!exactName && !mocEquivalent) return undefined;

			const candidateDir = normalizedNoteName(dirname(path));
			const candidateDirParts = candidateDir === "." ? [] : candidateDir.split("/").filter(Boolean);
			let score = exactName ? 100 : 80;
			const candidateHasMocPrefix = candidateBase !== candidateWithoutMoc;
			if (candidateHasMocPrefix && (requestedHasMocPrefix || requestedMocFolder)) score += 50;
			if (requestedDirParts.length > 0 && candidateDir === requestedDir) score += 30;
			for (const part of requestedDirParts) {
				if (candidateDirParts.includes(part)) score += 15;
			}
			return { path, score };
		})
		.filter((candidate): candidate is RankedVaultNotePath => Boolean(candidate))
		.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
}

function stripYamlScalar(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

export function extractFrontmatterNames(text: string): string[] {
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return [];
	const end = lines.slice(1).findIndex((line) => line.trim() === "---");
	if (end === -1) return [];

	const frontmatter = lines.slice(1, end + 1);
	const names: string[] = [];
	for (let index = 0; index < frontmatter.length; index++) {
		const line = frontmatter[index] ?? "";
		const title = line.match(/^title:\s*(.+)$/i);
		if (title?.[1]) names.push(stripYamlScalar(title[1]));

		const aliases = line.match(/^aliases:\s*(.*)$/i);
		if (!aliases) continue;
		const inline = aliases[1]?.trim() ?? "";
		if (inline.startsWith("[") && inline.endsWith("]")) {
			for (const alias of inline.slice(1, -1).split(",")) {
				const value = stripYamlScalar(alias);
				if (value) names.push(value);
			}
		} else if (inline) {
			names.push(stripYamlScalar(inline));
		} else {
			for (let aliasIndex = index + 1; aliasIndex < frontmatter.length; aliasIndex++) {
				const alias = frontmatter[aliasIndex]?.match(/^\s+-\s+(.+)$/);
				if (!alias?.[1]) break;
				names.push(stripYamlScalar(alias[1]));
				index = aliasIndex;
			}
		}
	}
	return [...new Set(names.filter(Boolean))];
}

export function frontmatterNameMatches(request: string, text: string): boolean {
	const cleanedRequest = normalizeVaultNoteRequest(request);
	const requested = normalizedNoteName(basename(cleanedRequest, extname(cleanedRequest)));
	return extractFrontmatterNames(text).some((name) => normalizedNoteName(name) === requested);
}

export function formatModelLabel(name: string | undefined, id: string | undefined): string {
	const label = name?.trim() || id?.trim() || "No model";
	return label.replace(/^(?:Anthropic\s+)?Claude\s+/i, "");
}

export function formatEffort(level: string): string {
	const labels: Record<string, string> = {
		off: "Off",
		minimal: "Minimal",
		low: "Low",
		medium: "Medium",
		high: "High",
		xhigh: "Extra high",
		max: "Max",
	};
	return labels[level] ?? level;
}

export function formatTokenCount(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatPromptSize(
	tokens: number | null | undefined,
	contextWindow: number | undefined,
	percent: number | null | undefined,
): string {
	const limit = contextWindow ? formatTokenCount(contextWindow) : "—";
	if (tokens == null) return `— / ${limit} (—)`;

	const calculatedPercent = percent ?? (contextWindow ? (tokens / contextWindow) * 100 : null);
	const percentLabel = calculatedPercent == null ? "—" : `${Math.round(calculatedPercent)}%`;
	return `${formatTokenCount(tokens)} / ${limit} (${percentLabel})`;
}
