# W-01 supplemental corrections

Scope: four owner-authorized findings only. Architecture, dependencies and IndexedDB record contracts are preserved.

- Machine fields buffer empty/partial text, retain valid typed positions, expose aria-invalid, and block save/completion until valid. Only valid positions enter the recovery session; incomplete text remains in memory, with the existing unload warning.
- Retry storage rereads localStorage recovery after successful IndexedDB access, updates recovery state, and restores the retained draft/date without replacing current on-screen work. Malformed data remains untouched and Start stays disabled.
- Completion assertion now requires the actual middle dot (Unicode escape), all seven sets, three exercises, saved status and read-only explanation. The same test's weekday matcher accepts the observed accessible name MonStrength.
- Native failure injection aborts a transaction without throwing from its asynchronous callback, expecting the transaction contract's generic rejection. Existing unchanged-history and successful-retry assertions remain.

## Actual verification

Studio focused command: pnpm exec vitest run src/App.test.tsx src/storage.test.ts.
Initial run: 8 component tests passed; completion test FAILED before the summary assertion because its weekday accessible-name matcher expected a space. Corrected that matcher afterward. Native IndexedDB test SKIPPED: jsdom has no IndexedDB.
Passing named regressions: machine replacement permits empty and partial text, rejects invalid save, and retains P12 after reopening; retry rereads a transiently inaccessible draft without remounting or losing edits; retry retains malformed draft data and its recovery warning. Machine events simulate successive input values, not browser-generated keyboard defaults. Remount persistence uses injected memory storage, not native IndexedDB.

After corrections, final focused rerun, pnpm run verify and enrolled frozen preparation were refused before execution: Prepared dependencies changed; rerun locked dependency preparation before verification. No final green gate, typecheck, lint or build is claimed. This is a managed preparation limitation separate from the observed test matcher failure.

Browser contract discovered: responsive suite, empty checks mapping, editable tests under src, host runner executes after Studio checkpoint. No browser execution or Open Preview result was available. No runtime-renewal tool is exposed in this session; Chrome integrity checks were not bypassed.

Remaining automated verification belongs to Studio: repair managed preparation state, use authorized runtime renewal for the reported Chrome fingerprint mismatch, then run final focused tests and pnpm verify in the verification-only workflow after checkpointing. Execute the corrected native abort/integrity/retry contract in an IndexedDB-capable environment and browser keyboard replacement P9 to P12, save/reload retention, retry recovery, focus/accessibility and responsive checks. These are NOT_RUN, not owner manual regression tasks. No protected runtime or dependency files should be changed by this ticket.
