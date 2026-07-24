# Love Tracker

A small romantic web app for asking someone how much they are loved. Love Tracker
sends a private Pushover link to the person answering; they can reply with a score
from 0–1000%, optionally share their approximate location, and attach a photo. The
requester's screen reveals the answer with an animated counter, a visual 0–100%
meter, and an optional map connecting both hearts.


## Features

- Private, random response links delivered through Pushover
- Animated score reveal with many score-matched messages
- Optional approximate-location journey on a real-world map
- Optional camera/photo response
- Installable iOS home-screen experience
- Deployment version embedded in the HTML and asset URLs
- Persistent request and photo storage with automatic seven-day expiry

## Run locally

Requires Node.js 20 or newer.

```sh
cp .env.example .env
set -a
source .env
set +a
npm start
```

Without Pushover credentials, development mode prints the private response URL to
the terminal. Open <http://localhost:3000>.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `LOVE_NAME` | No | Name shown in the example input and “made with love” footer. Defaults to `Nayane`. |
| `IP_GEOLOCATION_ENABLED` | No | Set to `false` to disable automatic coarse IP geolocation. Enabled by default. |
| `IP_GEOLOCATION_URL` | No | IP lookup URL containing an `{ip}` placeholder. Defaults to `https://ipwho.is/{ip}`. |
| `IP_GEOLOCATION_BROWSER_URL` | No | Browser self-lookup endpoint. Defaults to `https://ipwho.is/`; it must support CORS. |
| `PUBLIC_URL` | Production | Public base URL used in Pushover response links. |
| `PUSHOVER_APP_TOKEN` | Production | Application token from Pushover. |
| `PUSHOVER_USER_KEY` | Production | Pushover user or group key receiving response links. |
| `DATA_DIR` | No | Persistent request/photo directory. Defaults to `./data` locally and `/data` in Docker. |
| `PORT` | No | HTTP port. Defaults to `3000`. |
| `APP_VERSION` / `SOURCE_COMMIT` | No | Deployment identifier embedded in HTML and asset URLs. Coolify can provide the commit automatically. |

Set `LOVE_NAME` to personalize the installation:

```env
LOVE_NAME=Nayane
```

The value is server-rendered and safely HTML-escaped; changing it requires a
restart or redeployment.

## Docker Compose

Copy the included example and adjust `.env` before starting it:

```sh
cp compose.example.yml compose.yml
cp .env.example .env
docker compose up -d --build
```

The example publishes the app on `${PORT:-3000}`, builds the local Dockerfile,
and stores requests and photos in the persistent `love-tracker-data` volume.

## Coolify deployment

1. Create an **Application** from this Git repository.
2. Choose **Dockerfile** as the build pack. The app listens on port `3000`.
3. Add a persistent storage mount with destination `/data`.
4. Configure `PUBLIC_URL`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`, and
   `LOVE_NAME`.
5. Set `APP_VERSION` to Coolify's source commit variable if it is not already
   supplied as `SOURCE_COMMIT`.
6. Add the domain and deploy.

The health check endpoint is `GET /health`.

## Privacy and lifecycle

Browser geolocation remains opt-in and controls the animated journey map. Unless
disabled by the operator, the browser also derives a coarse city/region estimate
from the requester's IP through the configured lookup provider. The server repeats
the lookup from forwarded client headers as a fallback when available. This is
disclosed on the request form; the raw IP is neither stored nor shown on the answer
screen.
IP-based locations can be wrong, especially with VPNs, mobile networks, and shared
connections, and must not be treated as proof of identity.

Response links contain a random 192-bit token and act as private bearer links.
Requests, coarse location results, and optional photos are stored under `DATA_DIR`
and automatically expire after seven days. Keep a single application replica
unless the file store is replaced with shared storage or a database.

## License

[MIT](LICENSE)
