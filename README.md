# Demo management API

An Express 5 API for managing an explicit registry of demo applications. Initial apps are `astro` (`astro_calc`) and `change` (`change-calculator`). This project is an ingress point for management requests; Cloudflare continues routing calculator website traffic directly to each app.

## Routes

All routes except `GET /livez` require `Authorization: Bearer <token>`.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/livez` | API process liveness, no dependency checks |
| GET | `/health` | HTTP health of all registered apps; 503 if any fail |
| GET | `/v1/apps` | List registered apps |
| GET | `/v1/apps/:id/status` | Container state, restart policy and networks |
| GET | `/v1/apps/:id/health` | App HTTP check; inspect `healthy` in response |
| GET | `/v1/apps/:id/logs?tail=100` | Last 1–500 log lines, response capped at 2 MiB |
| POST | `/v1/apps/:id/start` | Start existing container |
| POST | `/v1/apps/:id/stop` | Stop existing container with 10-second grace |
| POST | `/v1/apps/:id/restart` | Explicitly restart existing container |

Examples of `:id` are `astro` and `change`. Responses are JSON with a request ID. Management operations are serialized per app and authenticated traffic has a shared budget of 120 requests per minute. There are no background recovery tasks or automatic retries. Restart policies are never changed. Health checks accept HTTP 2xx/3xx without following redirects; these checks establish HTTP availability, not correctness of calculator results.

## Test

Install Node 22 or later, then run `npm ci` followed by `npm test`. Tests use real local HTTP requests with simulated Docker and health backends; they do not touch your containers.

## Run on the VM with Docker Compose

Docker Compose must be installed; it was unavailable on this VM during an earlier inspection. Check `docker compose version` first. No deployment has been performed by this project.

From this project directory on the VM:

```bash
mkdir -p secrets
openssl rand -hex 32 > secrets/api_token
chmod 600 secrets/api_token
export DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
# Make the mounted token readable by container UID 1000 without making it public.
# Check `id -u` first. If it is not 1000, use a file ACL:
# sudo setfacl -m u:1000:r secrets/api_token
docker compose up -d --build
```

The existing `demo-network` must already exist. Compose attaches only `demo-api`; it does not recreate the calculators or Cloudflare connector. No host port is published. Restart policy is `no`. Do not run a broad prune or remove unrelated containers.

If Compose is unavailable, build and run directly:

```bash
docker build -t demo-management-api:1 .
docker run -d --name demo-api --network demo-network --restart=no \
  --user 1000:1000 --group-add "$DOCKER_GID" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true --init \
  --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock,readonly \
  --mount type=bind,src="$(pwd)/secrets/api_token",dst=/run/secrets/api_token,readonly \
  -e API_TOKEN_FILE=/run/secrets/api_token \
  --log-opt max-size=10m --log-opt max-file=3 \
  demo-management-api:1
```

Do not run both deployment options. An existing `demo-api` name causes `docker run` to fail instead of creating duplicates. An intentional update requires replacing that specific API container or running Compose again.

## Cloudflare

On the demo tunnel, add a published application route for a hostname you own, for example `api.halpdemo.app`, with service **HTTP** and URL **demo-api:9000**. The connector must share `demo-network`. It receives dashboard routing updates automatically. The old host webhook remains separate and unchanged on port 9000; the new API uses port 9000 inside its own network namespace, so there is no port conflict.

Call it from a terminal using a token loaded without printing it:

```bash
export API_URL=https://api.halpdemo.app
read -rs API_TOKEN
# Paste the token, then press Enter.
curl -H "Authorization: Bearer $API_TOKEN" "$API_URL/v1/apps/astro/status"
curl -H "Authorization: Bearer $API_TOKEN" "$API_URL/health"
# This deliberately starts the registered Astro container:
curl -X POST -H "Authorization: Bearer $API_TOKEN" "$API_URL/v1/apps/astro/start"
unset API_TOKEN
```

Use server-side callers for management. Never embed this token in public frontend JavaScript. Browser origins are denied by default; set `CORS_ORIGINS` to a comma-separated list of exact trusted origins only if required. CORS does not replace authentication. A Cloudflare Access policy can provide an additional identity boundary; service callers then also need the applicable Access credentials.

## Extend

Add an app ID, exact container name and internal HTTP health URL to `apps.json`, then rebuild/recreate only the API. Each target app must join `demo-network`. Registry data is trusted administrator configuration, not request input. There is no endpoint to register arbitrary containers or run shell commands.

Future features can include image deployments, signed CI webhooks, job history and per-project permissions. Image deployment is intentionally not implemented yet: it needs reviewed per-app image, mounts, ports, network and rollback definitions. The old `/webhook`, `/breakcontainer`, and `/breakenvironment` endpoints are not carried over. This API never stops the Docker daemon or VM services.

## Security and operational boundaries

Docker socket access gives this process host-level Docker control even when the socket mount is marked read-only; that flag does not make Docker API calls read-only. The registry constrains this application's requests but cannot contain a compromised process. For stronger isolation, put a separately enforced Docker authorization gateway between this API and Docker or run demos on a dedicated VM. The project uses a non-root user and removes Linux capabilities, but these do not eliminate socket authority.

The API does not return Docker environments or full container inspection output. Logs can still contain application secrets, so logs require authentication. Audit output contains request IDs, methods, paths and response codes, never bearer headers or bodies. Rotate the token by updating its secret file and recreating the API. Keep `secrets/` and `.env` out of Git. The API Docker image uses a mutable Node 22 Alpine tag; pin an approved digest for reproducible releases.

## Source layout

- `server.js`: loads configuration, starts listening and handles shutdown only.
- `src/app.js`: validates configuration and assembles Express middleware and routers.
- `src/routes/health.js`: public liveness and authenticated aggregate health routes.
- `src/routes/apps.js`: app listing, status, logs, health and lifecycle routes.
- `src/middleware/common.js`: request context, CORS, bearer authentication, rate limits and centralized errors.
- `src/services/docker.js`: Unix socket transport and Docker log decoding.
- `src/services/apps.js`: container inspection and HTTP availability probes.
- `test/api.test.js`: HTTP integration tests against injected backend clients.

Add new route groups under `src/routes/` and mount them in `src/app.js` after authentication unless deliberately public. Express 5 passes rejected async handler promises to the final error middleware: https://expressjs.com/en/5x/guide/error-handling/ .
