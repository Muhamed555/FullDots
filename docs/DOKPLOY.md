# Deploying on Dokploy

[Dokploy](https://dokploy.com) runs FullDots on your own VPS from this repository, with HTTPS from its built-in Traefik. FullDots uses [`compose.dokploy.yml`](../compose.dokploy.yml): the same services as `compose.yml`, without a host port, attached to `dokploy-network` and with a health check.

FullDots is built for one owner. Anyone who has the owner token can use every Dot, connector and key, so keep the token private.

## What you need

- A VPS with Dokploy installed, and at least 2 GB of RAM for the image build.
- A domain or subdomain, such as `dots.example.com`, with a DNS `A` record pointing at the VPS.
- A model key, or plan to add one later in **Settings → Models**.

## 1. Create the service

1. In Dokploy, open a project and choose **Create Service → Compose**.
2. Under **General**, set the provider to **GitHub** (or **Git** with this repository's URL), the branch to `main`, and **Compose Path** to `./compose.dokploy.yml`.
3. Keep the compose type **Docker Compose**.

## 2. Set the environment

Open the **Environment** tab and add these values. Make each secret with `openssl rand -hex 32`, and use different values for each one.

```dotenv
# Required
OWNER_TOKEN=<random, 24+ characters>
APP_ORIGIN=https://dots.example.com

# Recommended: keeps saved model keys and connector sign-ins readable
# if the volume is restored elsewhere. 64 hex characters.
CONNECTOR_SECRET_KEY=<openssl rand -hex 32>

# Built-in default model (optional; more providers in Settings → Models)
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=
```

`APP_ORIGIN` must be the exact address you open in the browser, with `https://` and no trailing slash. The API refuses requests from any other origin, and connector sign-in redirects to it.

The other settings in [`.env.example`](../.env.example) work too: limits, approvals, `BACKGROUND_CONCURRENCY`, `DOT_DAILY_TOKEN_WARN`, `TEAM_MAX_DEPTH` and so on. To give a connector its own secret (for example `GITHUB_TOKEN`), add the variable here and a matching line under `environment:` in `compose.dokploy.yml`.

### Optional: the page reader

To let Dots read search results in full, also set:

```dotenv
BROWSER_SECRET=<another random, 24+ characters>
COMPOSE_PROFILES=browser
```

This builds and starts the isolated `browser` service. It has no public port, and only the app can reach it.

## 3. Add the domain

Open the **Domains** tab and add a domain:

| Field          | Value                           |
| -------------- | ------------------------------- |
| Service Name   | `app`                           |
| Host           | `dots.example.com`              |
| Path           | `/`                             |
| Container Port | `4310`                          |
| HTTPS          | On, certificate `Let's Encrypt` |

## 4. Deploy

Click **Deploy**. The first build takes a few minutes. When the `app` container is healthy, open `https://dots.example.com`, enter the owner token, and add a model in **Settings → Models** if you did not set one in the environment.

The live computer view uses a WebSocket on the same address. Traefik passes it through without extra settings.

## Data and backups

Everything lives in the `fulldots-data` volume, mounted at `/data`: the SQLite database and, unless `CONNECTOR_SECRET_KEY` is set, the `connector.key` that encrypts saved keys. Redeploys keep the volume.

To take a consistent backup while FullDots runs, open the `app` container's terminal in Dokploy (or use `docker exec` on the VPS) and run:

```sh
node scripts/backup.mjs /data/backups
```

This writes `fulldots-<time>.sqlite` and a copy of the connector key to `/data/backups`. Copy them off the server, or back up the volume with Dokploy's **Volume Backups**. See [Backup and restore](SETUP.md#backup-and-restore) for how to restore.

## Updating

Push to `main` and click **Deploy** again, or turn on **Autodeploy** in Dokploy so each push redeploys. The database is migrated on start.

## Troubleshooting

| Symptom                                                                | Fix                                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Deploy fails with `Set a 24+ character OWNER_TOKEN`                    | Add `OWNER_TOKEN` (and `APP_ORIGIN`) in the Environment tab.                                         |
| `network dokploy-network declared as external, but could not be found` | The file is meant for a Dokploy server. Use `compose.yml` elsewhere.                                 |
| `Cross-origin requests are not allowed.`                               | `APP_ORIGIN` does not match the address in the browser. Fix the scheme, host or port, then redeploy. |
| 404 or "Bad Gateway" from Traefik                                      | Check that the domain's service is `app` and its port is `4310`, and that the container is healthy.  |
| Saved model keys stop working after a restore                          | Restore the matching `connector.key` into `/data`, or set the same `CONNECTOR_SECRET_KEY`.           |
| Ollama on the VPS is not reachable                                     | Use `http://host.docker.internal:11434/v1` as the base URL and set `MODEL_PROVIDERS_ALLOW_LAN=true`. |

Per-Dot computers ([Computers](COMPUTERS.md)) need access to the Docker engine and are not part of this setup.
