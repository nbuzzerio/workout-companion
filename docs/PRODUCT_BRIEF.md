# Workout Companion

A lightweight personal workout tracker for desktop, phones, and tablets.
The current baseline is only a placeholder; the features below belong to
future, separately authorized Studio tickets.

## Intended capabilities

1. Import an existing weekly workout spreadsheet.
2. Display scheduled exercises and prior performances.
3. Record weights, reps, sets, holds, and notes.
4. Show progress over time.
5. Display front and back anatomical muscle diagrams.
6. Show muscle exposure or training heat for the current week.
7. Export workout data to Google Sheets-compatible files.
8. Work well on desktop, phones, and tablets.

Preserve exercise-specific performance notation conceptually, including:

- `46×10 | 55×10 | 63×10 | 72×8`
- `P9×12 | P10×10 | P11×10`

Parsing is intentionally deferred.

## Proposed muscle metadata

An optional spreadsheet column named `Muscles` may contain entries such as:

`chest:3,front-delts:2,triceps:1`

Each entry pairs a muscle identifier with a relative training-heat value. This
could drive muscle visualization and weekly accumulation. This interchange
format is a proposal subject to later owner approval. Do not implement its
parser, select a final heat scale, or install a muscle visualization package yet.

## Architecture direction

- React + TypeScript + Vite, producing a static build for an Nginx-served directory.
- No runtime Node server or required backend.
- IndexedDB is planned for local workout sessions.
- Google Sheets CSV import/export is planned for existing workout history.
- PWA and offline support are optional future work.
- No environment secrets or Google authentication configuration are needed.

The bootstrap does not implement tracking, exercise data, charts, diagrams,
imports/exports, persistence, authentication, APIs, or offline support.
