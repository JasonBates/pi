import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import dashboardWikilinks from "../src/dashboard-wikilinks.ts";
import {
	buildSemanticLookupCode,
	canWriteInMode,
	extractFrontmatterNames,
	extractWikiLinks,
	formatEffort,
	formatModelLabel,
	formatPromptSize,
	isPathInside,
	limitSearchPassages,
	normalizeVaultNoteRequest,
	parseModeSwitchRequest,
	parseObsidianEvalJson,
	rankVaultNotePaths,
	renderObsidianWikiLinks,
	stripPlexProgress,
	toolsForMode,
} from "../src/utils.ts";

test("keeps resolved paths inside the vault", () => {
	assert.equal(isPathInside("/vault", "/vault/070 Note Base/note.md"), true);
	assert.equal(isPathInside("/vault", "/vault-other/note.md"), false);
	assert.equal(isPathInside("/vault", "/tmp/note.md"), false);
});

test("extracts and deduplicates Obsidian wikilinks", () => {
	assert.deepEqual(extractWikiLinks("[[Action]] [[Loops#Acute|the spiral]] [[Action]]"), ["Action", "Loops"]);
});

test("renders vault wikilinks as clickable Obsidian links", () => {
	assert.equal(
		renderObsidianWikiLinks(
			"Read [[Papers/Panksepp et al 1994 - Effects of Neonatal Decortication#Findings|the Panksepp study]].",
			"Trinity",
		),
		"Read [the Panksepp study](obsidian://open?vault=Trinity&file=Papers%2FPanksepp%20et%20al%201994%20-%20Effects%20of%20Neonatal%20Decortication%23Findings).",
	);
	assert.equal(renderObsidianWikiLinks("Embed ![[Panksepp figure.png]]", "Trinity"), "Embed ![[Panksepp figure.png]]");
});

test("rewrites the finalized assistant message through Pi's message_end contract", async () => {
	let messageEndHandler: ((event: MessageEndEvent) => unknown) | undefined;
	const originalVaultName = process.env.PI_KNOWLEDGE_VAULT_NAME;
	process.env.PI_KNOWLEDGE_VAULT_NAME = "Trinity";
	try {
		dashboardWikilinks({
			on(event: string, handler: (event: MessageEndEvent) => unknown) {
				if (event === "message_end") messageEndHandler = handler;
			},
		} as unknown as ExtensionAPI);
	} finally {
		if (originalVaultName === undefined) delete process.env.PI_KNOWLEDGE_VAULT_NAME;
		else process.env.PI_KNOWLEDGE_VAULT_NAME = originalVaultName;
	}

	assert.ok(messageEndHandler);
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "See [[Affect]]." }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	assert.deepEqual(await messageEndHandler({ type: "message_end", message }), {
		message: {
			...message,
			content: [
				{
					type: "text",
					text: "See [Affect](obsidian://open?vault=Trinity&file=Affect).",
				},
			],
		},
	});
});

test("removes Plex polling chatter from the final response", () => {
	const output = "[3s] loading\n[6s] complete — text stable for 6s, extracting\nGrounded answer";
	assert.equal(stripPlexProgress(output), "Grounded answer");
});

test("keeps the save route stable while mode controls mutation authorization", () => {
	assert.equal(toolsForMode("explore").includes("vault_semantic_search"), true);
	assert.equal(toolsForMode("explore").includes("vault_save"), true);
	assert.equal(toolsForMode("write").includes("vault_save"), true);
	assert.equal(canWriteInMode("explore"), false);
	assert.equal(canWriteInMode("review"), false);
	assert.equal(canWriteInMode("plan"), false);
	assert.equal(canWriteInMode("write"), true);
});

test("recognizes explicit natural-language mode switches without hijacking writing requests", () => {
	assert.equal(parseModeSwitchRequest("Write mode"), "write");
	assert.equal(parseModeSwitchRequest("please switch to review mode"), "review");
	assert.equal(parseModeSwitchRequest("change to plan mode."), "plan");
	assert.equal(parseModeSwitchRequest("can you go into write mode now?"), "write");
	assert.equal(parseModeSwitchRequest("could you put us in explore mode please?"), "explore");
	assert.equal(parseModeSwitchRequest("write a new paragraph"), undefined);
});

test("builds and parses the Smart Connections semantic route", () => {
	const code = buildSemanticLookupCode(["affect in experience", "felt valence", "affective inference"], 20);
	assert.match(code, /smart-connections/);
	assert.match(code, /readinessDeadline = Date\.now\(\) \+ 30000/);
	assert.match(code, /typeof sources\?\.lookup === "function"/);
	assert.match(code, /sources\.lookup\(\{ hypotheticals:/);
	assert.match(code, /rrfScore/);
	assert.deepEqual(parseObsidianEvalJson('plugin log\n=> {"ok":true,"results":[]}'), {
		ok: true,
		results: [],
	});
});

test("globally bounds exact-search passages before they enter model context", () => {
	assert.deepEqual(limitSearchPassages("a\nb\nc\nd\n", 3), ["a", "b", "c"]);
});

test("heals guessed and moved vault note paths without losing folder intent", () => {
	const paths = [
		"070 Note Base/predictive processing.md",
		"030 MoC/Schools/MoC - Predictive Processing.md",
		"080 Projects/⭐️ Subjectiv/Book/0 - Canon & Reference/Subjectiv — Positions on the Major Schools (Jun 2026).md",
	];
	assert.equal(
		rankVaultNotePaths("030 MoC/Schools/Predictive Processing.md", paths)[0]?.path,
		"030 MoC/Schools/MoC - Predictive Processing.md",
	);
	assert.equal(
		rankVaultNotePaths("070 Note Base/MoC - Predictive Processing.md", paths)[0]?.path,
		"030 MoC/Schools/MoC - Predictive Processing.md",
	);
	assert.equal(
		rankVaultNotePaths("070 Note Base/Subjectiv — Positions on the Major Schools (Jun 2026).md", paths)[0]?.path,
		"080 Projects/⭐️ Subjectiv/Book/0 - Canon & Reference/Subjectiv — Positions on the Major Schools (Jun 2026).md",
	);
});

test("normalizes wikilinks and reads frontmatter names", () => {
	assert.equal(normalizeVaultNoteRequest("[[MoC - Affect#Definition|affect]]"), "MoC - Affect");
	assert.deepEqual(
		extractFrontmatterNames('---\ntitle: "Canonical Affect"\naliases:\n  - Affect\n  - "Feeling tone"\n---\nBody'),
		["Canonical Affect", "Affect", "Feeling tone"],
	);
});

test("formats the knowledge-work status in plain language", () => {
	assert.equal(formatModelLabel("Claude Opus 4.6", "claude-opus-4-6"), "Opus 4.6");
	assert.equal(formatEffort("high"), "High");
	assert.equal(formatPromptSize(32000, 200000, 16), "32k / 200k (16%)");
	assert.equal(formatPromptSize(null, 200000, null), "— / 200k (—)");
});
