---
title: summarize daemon
permalink: /docs/commands/daemon.html
kicker: command
summary: "Manage the local daemon and Chrome Native Messaging bridge used by the Side Panel."
---

# `summarize daemon`

```text
summarize daemon <subcommand> [options]
```

Manages the local HTTP daemon and its browser integration. The daemon binds to `127.0.0.1` only and requires a shared bearer token. Chrome reaches it through an optional exact-ID Native Messaging host; Firefox retains its existing loopback integration. The daemon autostarts via the right service manager for your platform.

| Platform | Service               |
| -------- | --------------------- |
| macOS    | LaunchAgent (launchd) |
| Linux    | systemd user service  |
| Windows  | Scheduled Task        |

If you only use the CLI, you don't need any of this.

## Subcommands

### `install`

Install or upgrade the autostart service, write `~/.summarize/daemon.json`, and register Chrome native host `com.steipete.summarize` on macOS/Linux.

```bash
summarize daemon install --token <TOKEN>
summarize daemon install --token <TOKEN> --port 8787
summarize daemon install --token <TOKEN> --dev --extension-id <UNPACKED_ID>
```

`--token <token>` is **required** on first install; the extension prints one after pairing. Re-running `install` with a new token adds another paired browser instead of invalidating the old one. The native host manifest allows only Chrome Web Store extension ID `cejgnmmhbbpdmjnfppjdfkocebngehfg`.

### `restart`

Restart the autostart service. Useful after upgrading summarize or editing `daemon.json`.

```bash
summarize daemon restart
```

### `status`

Probe the autostart service, Chrome native-host registration, and the running daemon's health endpoint.

```bash
summarize daemon status
```

### `uninstall`

Unload the autostart service and remove the user-level Chrome native host. On macOS the daemon plist is moved to Trash so you can undo.

```bash
summarize daemon uninstall
```

### `run`

Run the daemon in the foreground. The autostart entry uses this internally; use it directly inside containers, on systems without launchd/systemd, or while debugging.

```bash
summarize daemon run --port 8787
```

## Options

`--port <n>`
: TCP port. Default `8787`. For a non-default port, set the same value in the extension under **Options → Runtime → Daemon → Port**. The native host reads `daemon.json` and rejects mismatched requests.

`--token <token>`
: Bearer token. Required for `install`. Stored in `~/.summarize/daemon.json` (mode `0600`).

`--dev`
: Install a service that runs `src/cli.ts` via Node's native TypeScript support from the current repo. Useful while hacking on the daemon — don't ship it to users.

`--extension-id <id>`
: With `--dev`, bind the native host to an unpacked Chrome extension ID. Production installs always use the exact Web Store ID.

## HTTP endpoints

The daemon is documented in detail in [Chrome extension](../chrome-extension.md) and [Agent / daemon](../agent.md). At a glance:

- `POST /summarize/execute` — start a run. Bearer-auth required. Streams progress + final summary.
- `GET /session/{id}/status` — poll an in-progress run.
- `GET /health` — health probe (used by `status`).

## Files

`~/.summarize/daemon.json`
: Token, port, paired browser fingerprints. Mode `0600`.

`~/.summarize/daemon.log`
: Rolling log written by the autostart service.

## Notes

- **Containers** — `install` starts the daemon for the current container session but does not register a Scheduled Task / unit. Run `summarize daemon run` from your entrypoint. Do not expose the port as a Chrome Native Messaging substitute.
- **Token rotation** — running `install --token <NEW>` adds a new paired browser; old browsers keep working. Edit `daemon.json` by hand to revoke.
- **Multiple installs** — only one daemon per user. Reinstall to upgrade; omitting `--port` preserves the configured port.
- **Windows** — the npm-installed CLI still needs a packaged native-host `.exe`; do not route daemon traffic through the Direct-provider loopback grants as a workaround. Direct and Browser modes continue to work.

## See also

- [Chrome extension](../chrome-extension.md) — pairing flow + Side Panel UI.
- [Agent / daemon](../agent.md) — automation surface.
