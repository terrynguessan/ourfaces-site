# OurFaces website

@AGENTS.md

## Approved baseline
- Production (`main`, https://www.ourfaces.net) is the approved design. Refine; never redesign without approval.
- Preserve the logo, the green/cream/gold tokens (`src/app/globals.css` `:root`), the Earth visual (green colour blend, drift animation, reduced-motion stop), page imagery and the contact form.
- English/French parity: every page exists at `/x` and `/fr/x` with equivalent content. Add or change pages in both languages.
- EN | FR stays visible in the header on mobile (≤1100px) without opening the menu.
- Every page sets `alternates: pageAlternates(locale, enPath)` (`src/lib/i18n.ts`) for canonical and hreflang URLs.
- Reference the optimized assets (WebP page photos, `bluemarble-2048.jpg`, `ourfaces-logo-564.png`, `favicon-192.png`), not the large originals.

## How we work
- Auto mode is the preferred operating mode. Work toward the assigned objective autonomously.
- Handle routine investigation, testing and troubleshooting independently; report consolidated results, not every command.
- Make minimal, targeted source changes. Don't reformat files: `npm run format:check` is report-only.
- Ask for approval before: changes outside the approved scope, adding or upgrading dependencies, permission or security settings, commits, pushes, merges and deployments.

## Verification
- Verify in a scratch copy of the repo, not the working tree (`next dev`/`next build` regenerate files). Keep screenshots and logs outside the repo.
- Visual regression with Playwright at 320, 390, 1024, 1280 and 1440px, in English and French, with reduced motion; compare against the approved baseline.
- Accessibility: WCAG AA contrast (4.5:1 for body text, including over the green side bands), keyboard focus, labels, `lang`, no horizontal overflow at 320px.
- Confirm the production build passes and English/French navigation, metadata and the contact API still work.

## Tools
- Impeccable skill (`.claude/skills/impeccable`, pinned `skill-v4.6.0`; see its `SOURCE.md`): use its reference guidance only. Never run `scripts/impeccable` or `scripts/impeccable.cmd` and never enable its telemetry: they download a binary and send usage data. Use the skill's "launcher unavailable" fallback. Project deny rules in `.claude/settings.json` back this up.
- ESLint is deferred until typescript-eslint supports TypeScript 7.
