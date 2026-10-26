# Deployment layouts

| Path | Role |
|---|---|
| [`Dockerfile`](Dockerfile) | Production server image and `cloud-home` target (build context = repository root) |
| [`docker-compose.yml`](docker-compose.yml) | TLS tenant stack for GHCR image (CI smoke) |
| [`local/`](local/README.md) | Developer Docker Compose on localhost (`compose.yaml`, engine overlay `Dockerfile`) |
| [`podman/`](podman/README.md) | Podman/WSL self-hosting |
| [`fly/`](fly/fly.toml) | Cloud Pro home machine (uses `cloud-home` image) |

Build the main image from the repository root:

```sh
docker build -f deploy/Dockerfile -t openmausbot .
```
