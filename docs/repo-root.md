# Repository root layout

The root stays relatively flat: Node, Vite, Docker, and GitHub expect certain entrypoints here. Shared tooling configs live under `config/`; self-hosting under `deploy/`.

## Root entrypoints (do not move)

| Item | Why |
|---|---|
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Package manager and workspace |
| `index.html`, `vite.config.ts`, `tsconfig.json` | Vite app shell and IDE typecheck (`tsc -b`) |
| `compose.yaml` | Thin `include` of `deploy/local/compose.yaml` for `docker compose` without `-f` |
| `deploy/Dockerfile`, `.dockerignore` | Server/cloud-home image (`docker build -f deploy/Dockerfile .`) |
| `maus.ps1` | Windows shortcut → `deploy/local/docker-compose.ps1` |
| `README.md`, `LICENSE`, `NOTICE`, `SECURITY.md`, `CLA.md`, `LICENSING.md` | GitHub, releases, CLA workflow |
| `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `AGENTS.md` | Community and agent docs |
| `.env.example` | Documented copy target for local Docker |

## Grouped by folder

| Path | Contents |
|---|---|
| [`config/`](../config/README.md) | Server/companion TypeScript projects, `electron-builder.yml` |
| [`preview/`](../preview/README.md) | Dev-only Vite HTML galleries |
| [`deploy/local/`](../deploy/local/README.md) | Local Docker Compose, Caddyfile, `docker-compose.ps1` |
| [`deploy/docker-compose.yml`](../deploy/docker-compose.yml) | TLS tenant compose (CI smoke) |
| [`deploy/podman/`](../deploy/podman/README.md) | Podman/WSL self-hosting |
| [`docs/`](../docs/) | Product and operator documentation |
| [`scripts/`](../scripts/) | Build, test, release automation |
| `server/`, `src/`, `electron/`, `shared/` | Application code |
| `skills/` | Bundled agent skills (desktop extraResources, Docker `COPY`, server `loadBundledSkills`) |
| `evals/` | Offline eval harness (`pnpm eval`, CI `tsc -p evals/tsconfig.json`) |

`skills/` and `evals/` stay at the repository root on purpose: moving them would break packaging paths, `process.cwd()` lookups, and dozens of tests without a coordinated runtime indirection layer.

## Build artifacts (gitignored)

`dist*`, `release/`, `node_modules/`, `*.tsbuildinfo`, `.venv/`, `.tmpexp/` — regenerate or delete locally; see [`.gitignore`](../.gitignore).

## Common commands

```sh
pnpm dev
pnpm dev:server
docker compose up -d --build                    # uses root compose.yaml shim
docker compose -f deploy/local/compose.yaml up  # explicit path
./maus.ps1 ps                                   # Windows Docker helper
```
