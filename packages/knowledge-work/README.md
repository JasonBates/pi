# Pi Knowledge Work

A quiet, Obsidian-first Pi surface for Jason's Trinity workflows. It keeps Pi's upstream core intact and packages the personal behavior as an extension, skill, prompts, theme, and launcher.

## Start

```bash
./packages/knowledge-work/bin/pi-knowledge
```

The launcher opens in the Trinity vault with only knowledge-work tools enabled. Existing Pi authentication and sessions are reused.

## Modes

- **Explore**: semantic and exact vault retrieval, connections, and grounded web research; read-only.
- **Write**: Explore plus precise note creation, appending, and exact replacement.
- **Review**: read-only critical review.
- **Plan**: read-only orientation toward the smallest useful next move.

Use `/mode` to switch. The chosen mode persists in the Pi session.

## Commands

- `/today` reads today's daily note and orients to the next breadcrumb.
- `/capture <thought>` appends directly to `+📥 inbox/Pi Captures.md`.
- `/research <question>` checks the vault and uses Perplexity through a dedicated Comet tab.
- `/synthesize <topic>` builds one argued synthesis across related notes.
- `/draft <note or move>` starts a paragraph-level writing collaboration.
- `/review-note <note>` performs a critical, read-only review.
- `/connect <note>` finds useful backlinks, outgoing links, and MoCs.

Press Ctrl+O to reveal the underlying detail for a knowledge action. The default display only shows a human-readable action and outcome.

## Configuration

The launcher uses `config/jason.json`. Override it with `PI_KNOWLEDGE_CONFIG`, or override only the vault with `PI_KNOWLEDGE_VAULT`.

The extension also reads, in precedence order:

1. `~/.pi/agent/knowledge-work.json`
2. `<cwd>/.pi/knowledge-work.json`
3. `PI_KNOWLEDGE_CONFIG`

`skillPaths` can add selected existing skills without loading the full coding-oriented global skill catalog. `obsidianCliPath` selects the Obsidian CLI used for live Smart Connections semantic retrieval.

## Design boundary

Use ordinary `./pi-test.sh` for coding. Use `pi-knowledge` for knowledge work. This keeps the supported Pi extension boundary intact and avoids a long-lived core fork while upstream is changing rapidly.
