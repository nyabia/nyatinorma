---
name: computer-use
description: Reuse visual computer-operation lessons across applications in nyatinorma.
---

Use saved knowledge as a starting point, then inspect the current window. Coordinates and screenshots describe a past state; re-ground targets before input. A driver accepting input does not establish that the application responded.

Keep reusable lessons in `notes/`. Record the applicable conditions and distinguish an observed result from a hypothesis. Evidence referenced by a note lives in `evidence/` inside this package. Application-specific rules belong in that application's package; do not promote them to universal behavior after one example.

The tools are domain-neutral. `intent` is a free description, action `data` is optional JSON metadata, and `ny_checkpoint` uses `key`, `data`, `state`, `snapshotId` and `note`. When reading older presets, place their named domain facts inside `data`/`state`; do not pass them as obsolete top-level tool arguments. Task rules and retry limits are instructions for the planner, not hardcoded input filters.
