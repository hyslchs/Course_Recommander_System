# 50-portal-and-tag-styling

- Status: done
- Depends on: wave-3 review findings

## Goal
Replace five duplicated page-scoped revert-layer repairs with one global unlayered block; fix the two uncovered portals (DataPage Modal, schedule Drawer/Dialog controls) and Tag.RemoveButton rendering as a white box.

## Progress
- worktree reset to 1aa620a; baseline green 232/26, tsc 0, build ok, CSS 787076 B
- design gate: ui-ux-pro-max (ux + web domains), heroui-react MCP (list_components + Button/TagGroup/CloseButton docs, re-verified against node_modules 3.2.4), magicuidesign-mcp (2 searches, nothing applicable)
- verified real class names in node_modules/@heroui/styles/dist/components/*.css and data-slot values in @heroui/react/dist/components/**
- confirmed Tag.RemoveButton IS a CloseButton: class="close-button close-button--default tag__remove-button"
- deleted the five superseded blocks (T32/T33/T34/T35/T36) + T35's min-height:44px rule + T33's tag-remove sizing pair
- added one global HEROUI CONTROL REPAIR block at end of styles.css: rule 1 buttons, rule 2 fields, rule 3 44px min-height, rule 3b 44px min-width (icon-only families only), rule 4 tag remove paint + glyph
- chrome-devtools MCP NOT used (coordinator reassigned it to 51); drove my own headless Chrome over raw CDP instead
- measured before/after on two production builds served side by side (baseline dist copied to /tmp) at 375 + 1440 x fju + fju-dark
- sampled real sRGB bytes via canvas fillStyle + getImageData, never string-parsing oklch(); scrolled with behavior:'instant' and asserted scrollY===0 before each capture
- caught and fixed two self-inflicted regressions the diff exposed: min-width on flex:1 toggle text, and .course-disclosure-trigger losing its accent
- FINDING: the reported "white box" on /recommend tag pills did NOT reproduce; baseline was HeroUI's own bg-default filled 44x44 chip, not #fff, and it did flip to dark under fju-dark
- the white-box claim DID reproduce on the schedule Drawer close, the slot dialog close + retry Button, and both DataPage import-dialog buttons

## Outcome
Changed: frontend/src/styles.css only (165 insertions, 89 deletions). No TSX change was required.

Verified (measured, production build, own headless Chrome + CDP, 375 & 1440 x fju & fju-dark):
- pnpm test 232/26 green (baseline 232/26), npx tsc -b 0 errors, pnpm build ok
- CSS 787076 -> 785562 bytes (-1514 B)
- /data import Modal (role=dialog, portalled outside [data-page]): base had both buttons rgb(255,255,255) + 1px legacy border; now 取消 = bg-default, 匯入並合併 = accent fill (26,78,138 light / 140,184,240 dark), both 44px
- /recommend Tag.RemoveButton: own background rgba(0,0,0,0), 0px border, 44x44 target, 16px glyph, both themes
- /schedule CourseDetails SideDrawer close: base rgb(255,255,255) + 1px legacy border + 10px radius in BOTH themes; now HeroUI close button, 44x44
- /schedule SlotRecommendationDialog retry Button (forced via blocked /api): same white box -> secondary variant, 44px
- legacy non-HeroUI buttons unchanged everywhere checked (schedule button.primary, .schedule-slot-button, .slot-category-filter, the dialog's 全選)
- .course-disclosure-trigger (explore) and .filter-accordion-trigger (recommend) byte-identical to baseline

Follow-ups:
- No honest unit test exists: styles.css is imported only by main.tsx, no test loads it, and jsdom resolves neither the @imports nor cascade layers. Asserting the CSS text would test nothing. Not written.
- .filter-advanced-trigger on /recommend now gets its authored accent colour again (baseline had it clobbered to muted by T33's over-broad .disclosure__trigger arm). Intentional, matches explore.
- /onboarding ComboBox trigger was never covered by T32 and rendered as a legacy white box; the global block now styles it like explore's. Intentional.
- The TSX min-h-11 / min-w-11 classes are now redundant (same 2.75rem) but were left in place to keep this CSS-only.
- T41 still owns deleting the unlayered legacy declarations; this block becomes unnecessary then.
