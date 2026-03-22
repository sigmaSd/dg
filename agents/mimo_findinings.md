# Mimo Code Review Findings

## Overview

DG Launcher is a modern, cross-platform application launcher
(Linux/macOS/Windows) built with Deno and GTK4 via `@sigmasd/gtk`. Features a
plugin system, Firefox history search, calculator, and a JSR-based plugin store.

---

## Strengths

**Architecture** — Clean separation of concerns. The `Source` interface is
well-designed, core plugins vs worker plugins are properly distinguished, and
the RPC protocol between host/worker is solid.

**Plugin Security** — Worker-based sandboxing with Deno permissions. Metadata
loads in a restricted sandbox before full plugin init. Permission change
detection with user prompts is a nice touch.

**Cross-Platform** — App discovery handles Linux `.desktop` files (including
Flatpak), macOS `.app` bundles, and Windows Start Menu apps. The Firefox profile
selection algorithm (preferring `default-release`, then by mtime) is thoughtful.

**Code Quality** — Good use of TS private fields, JSDoc on public APIs, and a
proper debounce + abort controller pattern in the store plugin.

---

## Bugs / Resource Leaks

### 1. Firefox temp file never cleaned up

**File:** `src/plugins/core/firefox.ts:141-149`

`cleanup()` is defined but never called. The temp SQLite copy leaks on disk.

### 2. Blob URL leak in worker init

**File:** `src/plugins/worker/host.ts:136`

`URL.createObjectURL()` in `init()` is never revoked. Only `loadMetadata`
properly calls `revokeObjectURL`.

### 3. Sequential global plugin search

**File:** `src/main.ts:222-225`

Global plugins are searched sequentially (`for...of` with `await`). Should use
`Promise.all` for parallel execution.

---

## Security Concerns

### 4. Calculator uses eval-like pattern

**File:** `src/plugins/core/calculator.ts:37`

`new Function(\`return ${clean}\`)()`is essentially`eval`. The regex gate helps,
but a dedicated math parser would be safer.

---

## Robustness

### 5. App exec splitting breaks on paths with spaces

**File:** `src/plugins/core/apps.ts:33`

`app.exec.split(" ")` breaks on paths with spaces. Desktop file exec strings
need proper shell-aware splitting.

### 6. Missing error handling on activation

**File:** `src/main.ts:297`

`await result.onActivate()` has no try/catch. A failing activation (e.g.,
missing binary) would crash the UI flow.

---

## Platform Issues

### 7. Config path ignores XDG_CONFIG_HOME

**File:** `src/config.ts:17`

Only checks `$HOME`. Should use `XDG_CONFIG_HOME` on Linux and `%APPDATA%` on
Windows for proper config location.

---

## CI Issues

### 8. Tests never run in CI

**File:** `.github/workflows/deno.yml`

`deno test` is missing from the workflow. Tests in `test/` are effectively dead
code in CI.

---

## Minor Issues

- `src/main.ts:302-307` — `#escapeMarkup` only handles `&`, `<`, `>`. GTK Pango
  markup also needs `"` escaped to `&quot;` in attribute contexts.
- `src/plugins/core/store.ts:81-93` — Debounce wrapping a Promise + setTimeout
  is slightly awkward. A cleaner pattern would resolve with cached results
  immediately and update asynchronously.
- `src/plugins/worker/host.ts:94` — `as unknown as` cast to bypass Worker
  permissions type.

---

## Summary

Solid project. Clean plugin architecture with proper sandboxing, good
cross-platform support, and well-structured code. Main action items: fix the two
resource leaks (Firefox temp file, blob URL), parallelize global search, add
`deno test` to CI, and harden exec splitting for paths with spaces.
