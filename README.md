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

Location sharing is opt-in. Response links contain a random 192-bit token and act
as private bearer links. Requests and optional photos are stored under `DATA_DIR`
and automatically expire after seven days. Keep a single application replica
unless the file store is replaced with shared storage or a database.

## License

[MIT](LICENSE)
