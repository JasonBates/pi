---
name: knowledge-work
description: Use for Obsidian-centered research, synthesis, writing, review, note connection, capture, and daily orientation in Jason's Trinity vault.
---

# Knowledge Work

Work from the question or desired artifact, not from the mechanics of operating the vault.

## Choose the working posture

- **Explore** is read-only. Retrieve notes, trace connections, run grounded web research, and synthesise.
- **Write** enables precise vault changes. Read the governing context and the current artifact before changing it.
- **Review** is read-only criticism. Identify the few changes that materially improve truth, structure, voice, or coherence.
- **Plan** turns current reality into a concrete next breadcrumb. Do not generate another framework when an adequate plan already exists.

Use `/write`, `/explore`, `/review`, or `/plan` for a direct switch; `/mode` opens the selector and `/mode write` also works. A plain explicit instruction such as “switch to write mode” is handled directly. Never change mode merely to make an unrequested mutation.

## Retrieval

Use this decision rule:

- **Named note** → direct read.
- **Open-ended vault question** → semantic search first.
- **Exact phrase or terminology audit** → keyword search first.

For a named `[[wikilink]]`, look in `070 Note Base/` first and read the named note before searching more broadly.

For an open-ended question such as “What does my vault say about affect?”:

1. Call `vault_semantic_search` first with 3–6 genuinely different hypothetical phrasings: the user's wording, conceptual paraphrases, and propositions likely to appear in relevant notes. The tool runs each through `obsidian-cli eval` and Smart Connections `smart_sources.lookup`, then deduplicates and ranks the combined results.
2. Read the strongest ranked notes with `vault_read`.
3. Follow with `vault_search` for exact terminology, aliases, and named concepts that could have been missed or conflated.
4. Check the emerging synthesis against the current canonical notes governing the topic. Prefer current stable notes and model/MoC spine notes over old drafts or scaffolding.
5. Follow backlinks or outgoing links only where their contents could change the conclusion.

If `vault_semantic_search` reports that semantic search is unavailable, state that limitation explicitly and continue with `vault_search` as the fallback. Never silently present keyword-only retrieval as semantic coverage.

For Subjectiv research interpretation, read `010 Private Notes/Alix/subjectiv-research-context.md` before judging what a source does to the model.

## Research

Use grounded web research for current or externally sourced claims. Standard mode is the default. Use deep research or council only when the user explicitly asks for it. Restate what was investigated, the finding, what existing claim or chapter it touches, and the implication.

## Writing and notes

- Preserve Obsidian frontmatter, wikilinks, and callout syntax.
- Never overwrite an existing note wholesale. Use a unique exact replacement or append.
- Before creating a paper note, read `120 Templates/Source Imports/Literature Note — Best-of-Breed.md`.
- Main synthesis notes belong in `070 Note Base/` and normally include a `## Connected` section linking relevant Component, Dynamic, and School MoCs.
- Source status progresses `inbox` → `done`; note status progresses `seed` → `develop` → `stable`.
- In Subjectiv book sessions, collaborate on Jason's prose rather than producing a disposable ghostwritten draft.

## Presentation

Keep tool names, paths, shell concepts, and implementation commentary out of the conversational surface unless the user asks. Lead with the intellectual outcome.
