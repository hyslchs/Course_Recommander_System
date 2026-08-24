# 30-ui-primitives-heroui

Status: done

## Progress
- Design gate: ui-ux-pro-max skill (ux domain), heroui-react MCP `list_components` +
  `get_component_docs` (Modal, AlertDialog, Toast, Alert, Skeleton, Button, Drawer, Tooltip),
  magicuidesign-mcp searched — nothing applicable, recorded explicitly.
- Docs are v3.0.5, installed package is 3.2.4; every API verified against node_modules.
- `components/ui.tsx` + `components/EmptyState.tsx` -> `components/ui/**` (7 files).
- Preflight re-enabled; `:where()` revert shim appended; 8 per-component HeroUI CSS
  imports; `tw-animate-css` added as a direct dep (build fails without it).
- 13 `.notice` sites -> StateAlert; `.undo-toast` + ManualCoursePanel `.notice` -> Toast.
- AppShell nav Modal -> HeroUI Drawer; legacy `.toast` / `.schedule-dialog` /
  `.navigation-drawer` collisions neutralised with `revert-layer`.
- Verified in Chrome: focus trap, Tab wrap, Escape, return-focus, `inert` on `#root`,
  scroll lock, 6.25s undo timeout, danger=assertive, 375/768/1024/1440 no h-scroll.
- 145/145 tests (3 consecutive runs), `tsc -b` clean, build succeeds.

## Outcome
- `frontend/src/components/ui/` — Modal, Drawer, FeedbackProvider, StateAlert, EmptyState,
  LoadingSkeleton, index.ts, ui.test.tsx.
- `frontend/src/styles.css` — preflight back on, HeroUI per-component imports, appended
  compatibility shims (prepend/append only, legacy block untouched).
- `frontend/src/test/setup.ts`, `frontend/vitest.config.ts` — ResizeObserver/matchMedia stubs.
- Bundle: JS 232.27 -> 444.23 kB entry (+170 kB total across chunks), CSS 557.81 -> 615.68 kB.
