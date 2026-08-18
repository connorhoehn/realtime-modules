# Tag normalization — 2026-08-18

All release tags are semantic (`vX.Y.Z`) as of this date — same
playbook as distributed-core's 2026-08-17 normalization: consumers
resolve latest by semver-sorting tag names, and `realtime-modules-v*`
prefixed names break that. Each prefixed-only version got an annotated
semantic twin at the same commit; prefixed names were deleted.

Versions v0.8.x–v0.18.x were mostly never tagged (releases were pinned
by commit SHA during that era). No tags were invented for them.

| old tag | commit | new tag |
|---------|--------|---------|
| realtime-modules-v0.5.3 | f9b11b491f10 | v0.5.3 |
| realtime-modules-v0.6.0 | 3a619ccab82e | v0.6.0 |
| realtime-modules-v0.7.0 | a18f44a717e0 | v0.7.0 |
| realtime-modules-v0.7.1 | 8acb750885e9 | v0.7.1 |
| realtime-modules-v0.7.2 | b91a432da591 | v0.7.2 |
| realtime-modules-v0.7.3 | dacecac169eb | v0.7.3 |
| realtime-modules-v0.7.4 | f3c84e0905cd | v0.7.4 |
| realtime-modules-v0.7.5 | f0435cdb1956 | v0.7.5 |
| realtime-modules-v0.7.6 | d6bf111a4e05 | v0.7.6 |
| realtime-modules-v0.7.7 | 5f417f273f88 | v0.7.7 |
| realtime-modules-v0.7.8 | 045a56fdedbb | v0.7.8 |
| realtime-modules-v0.11.1 | 41df99a87b33 | v0.11.1 |
