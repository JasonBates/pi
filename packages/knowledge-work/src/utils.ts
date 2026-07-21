import { isAbsolute, relative } from "node:path";

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
	return mode === "write" ? [...readOnlyTools, "vault_save"] : [...readOnlyTools];
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
		const plugin = app.plugins.plugins["smart-connections"];
		const sources = plugin?.env?.smart_sources;
		if (!sources?.lookup) return JSON.stringify({ ok: false, error: "Smart Connections smart_sources.lookup is unavailable" });
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
