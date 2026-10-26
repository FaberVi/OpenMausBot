# Build and tooling configuration

| File | Used by |
|---|---|
| `tsconfig.server.json` | `pnpm typecheck` (server, companion, enterprise) |
| `tsconfig.server.build.json` | `pnpm build:server` → `dist-server/` |
| `tsconfig.companion.build.json` | `pnpm build:companion` → `dist-companion/` |
| `electron-builder.yml` | `pnpm package:*` (`electron-builder --config config/electron-builder.yml`) |

The app and Vite config stay in the repository root `tsconfig.json` (IDE and `tsc -b`).
