# 32-onboarding-heroui

- Status: done
- Depends on: 30-ui-primitives-heroui (done)

## Goal
Onboarding form (300 lines, 11 useState, 6 effects) to Form/Fieldset/Select/ComboBox/RadioGroup/Switch. Fix the class-group-failure-shown-as-save-error bug.

## Progress
- Design gate: ui-ux-pro-max (ux + web domains); heroui-react MCP list_components + get_component_docs for Form, Fieldset, ComboBox, Select, RadioGroup, Switch, ListBox, FieldError, Label, Description, Button; magicuidesign-mcp searched — nothing applicable (4 hits, all decorative marketing).
- MCP docs are v3.0.5, installed is 3.2.4. Every API used was re-verified against node_modules; divergences recorded in the report.
- State collapsed: 11 useState -> 4, 6 useEffect -> 0. `form` (a full Profile clone built by three near-identical literals) replaced by a 4-field draft of only the edited fields, merged over a derived baseline, so profile/catalog can load in any order without a sync effect. One `toProfile` is now the single place a Profile is assembled.
- Double mirroring removed: `departmentInput` / `departmentSearchTerm` / `departmentMenuOpen` / `activeDepartmentIndex` / `departmentError` all deleted; ComboBox owns input, open state and roving focus.
- BUG 1 fixed: a class-group fetch failure was written into `setSaveError` and rendered as 「儲存失敗：…」. It is now a warning "無法載入班別選項" with recovery copy; 「儲存失敗」 is reserved for a putRecord rejection. Guarded by two tests plus a browser repro.
- BUG 2/3 fixed as above.
- Focus-on-error: implemented, but by `Form validationBehavior="native"` rather than an error summary — submit is blocked, `aria-invalid` set, FieldError auto-associated, and focus moves to the offending field. The T02 half-feature stays dropped.
- Also fixed while here: a stored profile whose `division` is not an official division (e.g. legacy 「資訊學院」) left the department list empty and the page unusable; baseline now falls back to the first real division.
- Repaired three unlayered-legacy-beats-HeroUI regressions found in devtools (fieldset UA border, primary CTA rendered as a white outline button, form fields staying light in dark mode). Scoped to this page via `[data-page="onboarding"]`; T41 removes the cause.
- `main.tsx`: `I18nProvider locale` zh-Hant-TW -> zh-TW. React Aria ships only zh-CN/zh-TW bundles and its fallback chain landed on zh-CN, so every built-in announcement was Simplified Chinese.
- 13 new tests. Verified at 375/768/1024/1440 x light/dark on the production build.

## Outcome
Done. 158 tests / 18 files green (base 145/17), tsc 0 errors, build succeeds.
Known issues left for later tasks, with root cause identified:
- Description text is 3.39:1 in dark mode — the legacy `#667069` still shadows `--muted` until T41. Light mode is 5.14:1. Not a regression; same value as before.
- Below ~420px of *layout* viewport height (landscape phone / very short window, NOT the soft-keyboard path) the ComboBox popover closes the instant it opens: React Aria scrolls the focused option into the viewport, nudging the document ~3px, and its own close-on-scroll reads that as a dismiss. Needs an upstream fix.
