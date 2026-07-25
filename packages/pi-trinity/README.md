# Pi Trinity

A Trinity-specific Pi surface that can evolve independently while the working `pi-knowledge` interface remains available as a fallback.

## Start

```bash
./packages/pi-trinity/bin/pi-trinity
```

Pi Trinity opens in the Trinity vault with the proven knowledge-work retrieval, research, linking, question, save, theme, prompt, and dashboard foundations. It has its own launcher, configuration, system prompt, and extension entrypoints.

The first boundary intentionally reuses the knowledge-work engine. The next implementation stage replaces the inherited Explore, Write, Review, and Plan modes with persistent Manual and Auto postures without changing `pi-knowledge`.

## Configuration

The launcher reads `config/jason.json`. Set `PI_TRINITY_CONFIG` for a different config file or `PI_TRINITY_VAULT` for a different vault.

Set `PI_TRINITY_DASHBOARD=0` to launch without PI Dashboard, or `PI_TRINITY_DASHBOARD_BRIDGE` to use a non-standard bridge path.

Pi extensions are loaded at process start. Exit and relaunch Pi Trinity after changing the package.
