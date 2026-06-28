# ok-graph 'all' mode — cluster full graph (02: retrieved-only summaries)

## Goal
With the **full** k-hop graph now the base (subtask 01), each cluster contains
retrieved papers **and** hidden intermediate connectors. Cluster summaries must
be generated from the **retrieved papers only** (user decision), so summary text
never describes connector papers that aren't shown.

Clustering itself still runs over the full graph (so community ids match the view
and the Clustering page) — only the *member set fed to the prompt* is filtered.

## Change (`cluster-summary.service.ts`, `start()`)
- Read the hide flag once: `const hideIntermediates = this.okGraphState.hideIntermediates();`
  and a predicate `isHidden = (i) => hideIntermediates && nodes[i].hop > 0;`.
- Cluster over the **full** `nodes`/`edges` as today (`this.cluster(...)`) →
  community ids unchanged (must match the view).
- When building `membersAt` from `commAt`, **skip hidden indices**. Clusters whose
  members are all hidden simply never get an entry, so:
  - they are not summarized,
  - they are not counted in `progress.total`,
  - `representativeTitle` / `clusterFingerprint` / `summarizeFinest` operate on
    retained-only members,
  - higher-level composition (`summarizeHigher`, `parentAt`) still resolves because
    any parent cluster with a retained member has a child cluster with that same
    retained member (so the child was not dropped).
- `rawCommunityMap` / `commAt` stay computed over the full node set (no change) —
  intermediates simply aren't displayed, so mapping them is harmless.
- `hydrate()` (snapshot restore) needs no change: it only restores already-saved
  (retrieved-only) summaries keyed by full-graph (level, community); it does not
  regenerate.

## Test / verify
- `npx tsc --noEmit -p tsconfig.app.json` clean.
- Existing cluster-summary spec(s) still pass; add/adjust a spec asserting hidden
  (`hop>0`) members are excluded from a cluster's summary input when
  `hideIntermediates` is on, and that a fully-intermediate cluster is skipped.
