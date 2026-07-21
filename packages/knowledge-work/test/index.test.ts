import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSemanticLookupCode,
	extractWikiLinks,
	formatEffort,
	formatModelLabel,
	formatPromptSize,
	isPathInside,
	limitSearchPassages,
	parseObsidianEvalJson,
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

test("removes Plex polling chatter from the final response", () => {
	const output = "[3s] loading\n[6s] complete — text stable for 6s, extracting\nGrounded answer";
	assert.equal(stripPlexProgress(output), "Grounded answer");
});

test("only enables mutation in write mode", () => {
	assert.equal(toolsForMode("explore").includes("vault_semantic_search"), true);
	assert.equal(toolsForMode("explore").includes("vault_save"), false);
	assert.equal(toolsForMode("review").includes("vault_save"), false);
	assert.equal(toolsForMode("plan").includes("vault_save"), false);
	assert.equal(toolsForMode("write").includes("vault_save"), true);
});

test("builds and parses the Smart Connections semantic route", () => {
	const code = buildSemanticLookupCode(["affect in experience", "felt valence", "affective inference"], 20);
	assert.match(code, /smart-connections/);
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

test("formats the knowledge-work status in plain language", () => {
	assert.equal(formatModelLabel("Claude Opus 4.6", "claude-opus-4-6"), "Opus 4.6");
	assert.equal(formatEffort("high"), "High");
	assert.equal(formatPromptSize(32000, 200000, 16), "32k / 200k (16%)");
	assert.equal(formatPromptSize(null, 200000, null), "— / 200k (—)");
});
