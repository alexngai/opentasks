# OpenTasks Implementation Plans

This directory contains the implementation specifications for OpenTasks, mirrored from sudocode specs.

## Spec Hierarchy

```
CORE-ARCHITECTURE.md (s-9jju)
├── PHASE-1.md (s-9hf5) — Single-Location + Provider URIs [v1]
│   └── Deliverables: core types, storage, 3-tool interface, providers
│
├── PHASE-2.md (s-7es6) — Cross-Location References [v2]
│   ├── depends-on: PHASE-1
│   └── Deliverables: daemon, registry, opentasks:// URIs, redirects
│
└── PHASE-3.md (s-2qms) — Multi-Location Queries [v3]
    ├── depends-on: PHASE-2
    └── Deliverables: discovery, expansion modes, conditional redirects
```

## Quick Links

| Document | Description | Status |
|----------|-------------|--------|
| [CORE-ARCHITECTURE.md](./CORE-ARCHITECTURE.md) | Overall design and decisions | Active |
| [PHASE-1.md](./PHASE-1.md) | v1: Single-location, provider URIs | **Current Focus** |
| [PHASE-2.md](./PHASE-2.md) | v2: Cross-location, daemon | Planned |
| [PHASE-3.md](./PHASE-3.md) | v3: Discovery, expansion | Planned |

## Key Design Decisions

| Decision | Choice |
|----------|--------|
| Core identity | Graph connector (not task replacement) |
| Interface | 3 tools: `link`, `query`, `annotate` |
| Edge storage | Short IDs for local, URIs for external |
| Worktree model | Clone + redirect rules |
| Daemon | Required for Phase 2+ (multi-agent) |

## Sudocode Spec IDs

These plans are mirrored from sudocode specs:

- `s-9jju` — OpenTasks Core Architecture
- `s-9hf5` — Phase 1: Single-Location + Provider URIs
- `s-7es6` — Phase 2: Cross-Location References
- `s-2qms` — Phase 3: Multi-Location Queries

To view specs with relationships and feedback, use:
```bash
sudocode show s-9jju
sudocode list --search "opentasks"
```
