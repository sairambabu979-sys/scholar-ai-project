# Stack and Pinned Versions

Selected 2026-11-04 from the npm registry. All versions are pinned exactly (`.npmrc`
`save-exact=true`) and locked in `package-lock.json`.

| Component                        | Version                             | Notes                                                                                                                                 |
| -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js                          | 22 LTS (`>=22.12`; 24 also allowed) | `.nvmrc` = 22                                                                                                                         |
| PostgreSQL                       | 16                                  | `infra/compose.yml` uses `postgres:16-alpine`                                                                                         |
| Next.js                          | 16.4.5                              | App Router, Turbopack. `agentRules: false` stops it writing `AGENTS.md`                                                               |
| React / React DOM                | 19.3.1                              |                                                                                                                                       |
| TypeScript                       | 6.0.3                               | Not 7.x: typescript-eslint 8.72 supports `<6.1` only                                                                                  |
| Prisma ORM / client / adapter-pg | 7.10.1                              | `prisma` `latest` tag pointed at an 8.0 RC, so the stable 7.10.1 is pinned. Prisma 7 requires `prisma.config.ts` and a driver adapter |
| Better Auth                      | 1.7.17                              | Maintained session/auth library (Prisma adapter, Google provider, CSRF/origin checks, rate limits)                                    |
| Zod                              | 4.6.7                               |                                                                                                                                       |
| Vitest                           | 5.1.0                               | Projects: `unit`, `integration`                                                                                                       |
| Playwright                       | 1.63.0                              | Matches the browsers preinstalled in the build container; CI installs its own                                                         |
| ESLint                           | 9.39.5 (maintenance line)           | 10.x not yet supported by all Next lint plugins                                                                                       |

## Known advisories

`npm audit` reports 8 **moderate** findings, all from `minimatch` inside
`@typescript-eslint/*` (lint tooling only, never shipped to the runtime). `npm audit fix
--force` would downgrade typescript-eslint, so they are accepted for now and must be rechecked
before Phase 7.

## Architecture notes

- Workspace packages are consumed as TypeScript source (no build step); Next.js transpiles them
  via `transpilePackages`, the worker runs under `tsx`.
- The Prisma client is generated into `packages/db/src/generated` (git-ignored) by
  `npm run db:generate`, which also runs on `postinstall`.
- One env file at the repository root (`.env.local`) is loaded by the web app
  (`next.config.ts`), the worker, Prisma, and the seed. Real process environment always wins.
