# Workout Companion

Minimal React + TypeScript + Vite baseline for future Studio development.
The placeholder confirms rendering, styling, and static production bundling.
Product features are deferred; see [the product brief](docs/PRODUCT_BRIEF.md)
and [repository guidance](AGENTS.md).

## Requirements and setup

Use Node.js 22.22.2+, 24.15.0+, or 26+ and pnpm 11.9.0.
The baseline was verified with Node 24.18.0. These versions satisfy the
development and test dependencies; deployed static files do not require Node.
Use pnpm exclusively; dependency versions are recorded in
`package.json` plus `pnpm-lock.yaml`.

TypeScript stays on the latest compatible 6.0 release because the current
`typescript-eslint` peer range excludes TypeScript 7.

```sh
pnpm install --frozen-lockfile
pnpm dev
```

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the local Vite development server |
| `pnpm typecheck` | Check application and configuration TypeScript |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run the Vitest render smoke test once |
| `pnpm build` | Typecheck and generate the static production build |
| `pnpm verify` | Run typechecking, linting, tests, and production build |
| `pnpm preview` | Preview the production build locally |

## Static deployment

Run `pnpm build`, then copy the contents of `dist/` to an Nginx-served directory
or another static host. The build uses relative asset URLs so it can also be
served from a subdirectory. It contains HTML, JavaScript, and CSS and needs no
runtime Node process, backend, environment secrets, or Google authentication.
The development and preview servers are local tooling, not production servers.

## Layout

- `src/`: React entry point, placeholder, styles, and one render test.
- `docs/PRODUCT_BRIEF.md`: future product and interchange-format notes.
- Root configuration: Vite/Vitest, TypeScript, ESLint, and pnpm.
- `dist/` and `node_modules/`: generated and ignored by Git.

The owner reviews, stages, and commits the initial baseline manually. Subsequent
development will use Studio-managed worktrees.
