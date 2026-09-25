# Third-party notices and provenance

nyatinorma's MIT OR Apache-2.0 choice applies to its original contributions.
It does not replace the licenses of dependencies or upstream material.

## oh-my-pi — design reference (MIT)

The persistent-plan/reminder design referenced
[todo-tracker.ts](https://github.com/can1357/oh-my-pi/blob/ea8b54247afb85fa10ba784b35b54f90d7b28c7f/packages/coding-agent/src/session/todo-tracker.ts).
The original consultation revision was not recorded; this link pins the revision
reviewed on 2026-09-25. nyatinorma implements its plan in `src/plan.ts` and its pi
context/tool integration in `extensions/nyatinorma.ts`. The reviewed files do not
contain identical substantive normalized source lines from that tracker. This
limited comparison is not proof of a complete historical provenance audit.
No oh-my-pi package or tracker implementation is bundled.

The upstream copyright and MIT permission notice are retained conservatively in
[licenses/oh-my-pi-MIT.txt](licenses/oh-my-pi-MIT.txt). Any upstream-derived material
retains that MIT notice; it is not silently relicensed as Apache-only material.

## pi — runtime dependencies (MIT)

- `@earendil-works/pi-coding-agent` 0.87.1
- `@earendil-works/pi-ai` 0.87.1

These are unmodified npm dependencies, not a vendored fork. The license is from
[the upstream v0.87.1 tag](https://github.com/earendil-works/pi/blob/v0.87.1/LICENSE)
and is included in [licenses/pi-MIT.txt](licenses/pi-MIT.txt).

## TypeBox and sharp — runtime dependencies

- TypeBox 1.3.27: MIT; notice in `licenses/typebox-MIT.txt`.
- sharp 0.35.4: Apache-2.0; license in `licenses/sharp-Apache-2.0.txt`.

sharp's optional native packages include LGPL-3.0-or-later components and mixed
license expressions. Do not describe the complete dependency bundle as only
MIT/Apache. Source installation retrieves dependencies separately. A future
binary/native-library release must retain the exact shipped components' notices,
license texts and applicable source/relinking materials; this document does not
complete those binary-distribution obligations.

## Qwen Code — macOS event API reference

`native/Bridge.swift` identifies Qwen Code's macOS driver as a reference for
window-targeted event APIs. The original reference revision was not recorded.
The root license checked at QwenLM/qwen-code commit
`790bd83c2b1b3e242e0487d92183b053ceb44ed8` is Apache-2.0 and is retained in
`licenses/qwen-code-Apache-2.0.txt`. This is not a claim that every separately
licensed component in that upstream repository uses Apache-2.0. No Qwen driver
source tree or binary is bundled here. Check the exact source and its local
notices before incorporating further implementation from it.

## External components and lockfile inventory

Ollama, models and cua-driver are externally installed, not bundled or relicensed
by nyatinorma. Their own licenses apply.

`docs/dependency-licenses.json` records package names, versions and declared
licenses from `package-lock.json`, including development/optional/platform
packages. Regenerate with `npm run licenses:report`. It is metadata inventory,
not a substitute for all notices in a future bundled release.
