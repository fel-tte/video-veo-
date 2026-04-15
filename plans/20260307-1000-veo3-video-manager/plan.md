# Veo3 Video Manager - Implementation Plan

**Date:** 2026-03-07 | **Status:** Ready for Implementation

## Summary

Desktop app (Windows) to automate video generation on Google Labs Flow (Veo 3.1). Uses Chrome automation via Rod to submit prompts, wait for generation, intercept blob video URLs via CDP, and save videos to disk. Wails v2 provides the desktop shell with React+TS frontend.

## Tech Stack

- **Backend:** Go 1.22+, Wails v2, go-rod/rod + stealth, modernc.org/sqlite
- **Frontend:** React 18, TypeScript, Vite, Tailwind CSS, shadcn/ui, Zustand

## Research

- [Researcher 01](research/researcher-01-report.md) - Wails v2, Rod, SQLite
- [Researcher 02](research/researcher-02-report.md) - Google Labs UI, bot detection, video download

## Phases

| # | Phase | File | Priority |
|---|-------|------|----------|
| 1 | Foundation & Chrome Core | [phase-01](phase-01-foundation-chrome-core.md) | Critical |
| 2 | Automation Engine | [phase-02](phase-02-automation-engine.md) | Critical |
| 3 | Frontend UI | [phase-03](phase-03-frontend-ui.md) | High |
| 4 | Polish & Distribution | [phase-04](phase-04-polish-distribution.md) | Medium |

## Key Risks

1. **Google UI changes** - selectors break; mitigate with configurable selectors stored in DB
2. **Bot detection** - stealth evasion may degrade; session persistence is primary defense
3. **Blob URL interception** - CDP approach may need adjustment; have DOM fallback strategy
4. **Rate limits** - ~3 videos/day consumer tier; queue must respect this with configurable delays

## Architecture Overview

```
[React UI] <--Wails Bindings/Events--> [Go Backend]
                                            |
                        +-------------------+-------------------+
                        |                   |                   |
                  [Queue Manager]    [Chrome/Rod]        [SQLite DB]
                        |                   |
                  [Worker Loop]      [Flow Automation]
                        |                   |
                        +----> [Video Downloader] ----> [Disk]
```

## Constraints

- Sequential video generation only (one at a time on Flow UI)
- Session reuse via Chrome user-data-dir (user logs in once manually)
- Windows-first distribution (single .exe via Wails build)

## Unresolved Questions

- Exact CSS selectors for Flow UI elements (must be discovered during Phase 2 implementation)
- Whether Flow UI supports concurrent generation tabs (assumed no)
- Blob URL transfer mechanics across page navigations
