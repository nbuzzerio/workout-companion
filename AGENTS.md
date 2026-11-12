# Repository guidance

- Use pnpm exclusively for dependencies and scripts. Retain `pnpm-lock.yaml`;
  do not introduce other package-manager lockfiles.
- This is a static React + TypeScript + Vite frontend. Deploy the `dist/`
  output to a static host such as Nginx; no runtime Node server is required.
- Do not add backend or server infrastructure without explicit owner approval.
- Do not use paid APIs.
- Preserve workout history and imported data. Avoid destructive migrations or
  data loss; use deterministic tests for data transformations.
- Keep individual features modular and avoid premature abstractions.
- Prioritize automated tests for deterministic behavior. Human QA should focus
  on usability, visual quality, and whether behavior meets expectations.
- All code changes must remain within the authorized ticket scope. See
  `docs/PRODUCT_BRIEF.md` for future ideas, not implementation authorization.
- Git staging, commits, merges, and pushes belong exclusively to the repository
  owner. Do not perform them or configure remotes.
- Future development uses Studio-managed worktrees after the owner creates the
  baseline commit. Do not create worktrees or development branches in bootstrap.
