# Pi harness research for knowledge work

Research date: 2026-07-21

## Upstream state

The checkout is `badlogic/pi-mono` at release v0.81.1 (`dd6bea41`, 2026-07-21). The project now publishes under the `@earendil-works/*` package namespace, although the legacy GitHub URL still resolves.

Pi is already split at the right seams for this project:

- `pi-ai` handles model providers.
- `pi-agent-core` supplies the agent loop and state.
- `pi-coding-agent` supplies sessions, resource discovery, the interactive TUI, RPC, and SDK embedding.
- `pi-tui` supplies the terminal component system.

The supported customization boundary is a Pi package containing TypeScript extensions, skills, prompt templates, and themes. Extensions can change the active tool set, inject mode-specific instructions, replace the header and footer, register high-level tools and commands, and render tool activity compactly. A different application shell can use RPC or the SDK, but that is not necessary for the first knowledge-work surface.

Useful upstream examples:

- [`minimal-mode.ts`](../coding-agent/examples/extensions/minimal-mode.ts) replaces low-level tool rendering with a collapsed action summary and Ctrl+O detail.
- [`preset.ts`](../coding-agent/examples/extensions/preset.ts) switches tool sets and system instructions as named working modes.
- [`custom-header.ts`](../coding-agent/examples/extensions/custom-header.ts) and [`custom-footer.ts`](../coding-agent/examples/extensions/custom-footer.ts) replace coding-oriented chrome.
- [`dynamic-resources`](../coding-agent/examples/extensions/dynamic-resources/index.ts) bundles skills, prompts, and themes with an extension.

## Ecosystem patterns worth reusing

### Modular extensions, not one giant fork

[`emanuelcasco/pi-mono-extensions`](https://github.com/emanuelcasco/pi-mono-extensions) packages focused capabilities independently. The most relevant patterns are structured questions, context guards that cap reads and block duplication, hidden side questions, configurable status lines, and domain integrations that pair tools with a workflow skill.

Knowledge-work implication: expose a few domain-level actions (`vault_search`, `vault_read`, `vault_connections`, `research_web`, `vault_save`) and place workflow policy in a skill. Do not make the user watch shell commands or general filesystem tools.

### Full forks prove possibility but carry the wrong defaults

[`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi) is a substantial Pi fork with many built-in tools, LSP/DAP support, browser and research integrations, subagents, native Rust components, ACP, and more aggressive model-specific optimization.

Knowledge-work implication: it demonstrates that the harness can support a far richer product, but its batteries-included coding orientation increases exactly the surface area this project wants to remove. Reusing a few design ideas is preferable to adopting its fork burden.

### Shared skills can make a vault agent-agnostic

[`Ar9av/obsidian-wiki`](https://github.com/Ar9av/obsidian-wiki) installs the same knowledge-management skills into Pi and other harnesses. [`tomsej/pi-ext`](https://github.com/tomsej/pi-ext) similarly distributes Pi extensions, skills, and themes as a coherent bundle.

Knowledge-work implication: reuse Jason's existing Subjectiv and Obsidian skills selectively instead of cloning their instructions into a new monolithic prompt. Avoid loading the entire coding-oriented global catalog.

### A thin editor shell remains a later option

Projects such as [`Zetaphor/pi-vscode-extension`](https://github.com/Zetaphor/pi-vscode-extension) and [`YishenTu/claudian`](https://github.com/YishenTu/claudian) show the value of putting agent conversation, expandable actions, and reviewable diffs inside the editor where the artifact already lives.

Knowledge-work implication: an Obsidian side panel driven through Pi RPC or the SDK is a credible second phase. It is not required to validate the workflow model, and building it first would spend effort on transport and rendering before the modes and tool semantics are proven.

## Resulting design

The implementation uses two layers:

1. A self-contained `@jasonbates/pi-knowledge-work` Pi package for the personal interface and workflows.
2. One generic upstream-core change, `--quiet-startup`, to suppress startup help and loaded-resource details for one run without mutating global settings.

The launcher deliberately disables built-in coding tools and globally discovered coding resources, then loads only the knowledge package. Four modes alter capability rather than merely changing the prompt:

- **Explore:** retrieval, connections, structured questions, and grounded research; read-only.
- **Write:** Explore plus guarded create, append, and exact replacement.
- **Review:** read-only critical evaluation.
- **Plan:** read-only orientation toward a concrete next breadcrumb.

This keeps ordinary Pi available for code while `pi-knowledge` presents Trinity as the product surface.

Semantic retrieval now runs through `obsidian-cli eval` and Smart Connections before exact search for open-ended vault questions. Several query phrasings are fused into one deduplicated ranking; exact search remains the explicit fallback when Obsidian or Smart Connections is unavailable.

## Later experiments

- Add a review overlay that accepts or rejects individual CriticMarkup suggestions.
- Add Zotero-native paper retrieval and literature-note creation as a narrow tool-plus-skill bundle.
- Evaluate an Obsidian panel over RPC only after the terminal modes have seen sustained real use.
- Add calendar, task, and WHOOP adapters for the Plan mode without exposing generic MCP or shell machinery.
