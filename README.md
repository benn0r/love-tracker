# Love Tracker

A tiny romantic web app where someone asks how much they are loved. The app sends
a private Pushover link; the recipient answers with a number from 0–1000%, and the
original screen reveals it with an animated counter and progress bar.

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

## Coolify deployment

1. Create a new **Application** from this Git repository.
2. Choose **Dockerfile** as the build pack. The app listens on port `3000`.
3. Add a persistent storage mount with destination `/data`.
4. Set these environment variables:
   - `PUBLIC_URL`: the final public URL, such as `https://love.example.com`
   - `PUSHOVER_APP_TOKEN`: token from your Pushover application
   - `PUSHOVER_USER_KEY`: your Pushover user or group key
5. Add the domain in Coolify and deploy.

The health check endpoint is `GET /health`.

## Privacy and lifecycle

Response links contain a random 192-bit token and are effectively private bearer
links. Requests are stored in `/data/requests.json` and automatically expire after
seven days. Keep a single replica unless you replace the file store with a shared
database.
