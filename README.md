# A2Z Food Corner – Billing Counter

Billing, order history, day summary and Bluetooth thermal printing for A2Z Food Corner.

- `server.js` – small Node server (no framework). Stores data in Postgres when `DATABASE_URL` is set, otherwise in `data/db.json`.
- `public/index.html` – the billing app.

## Deploy on Railway

1. Put this folder in a new GitHub repository (GitHub → New repository → "uploading an existing file", drag in everything inside this folder).
2. On railway.com: **New Project → Deploy from GitHub repo** → pick the repo.
3. In the same project: **+ Create → Database → PostgreSQL**.
4. Open the app service → **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (choose it from the reference dropdown)
   - `APP_PIN` = your shop PIN, e.g. `482916`
   - `SESSION_SECRET` = any long random text
5. App service → **Settings → Networking → Generate Domain**. That's your live link.

Check `https://<your-domain>/healthz` shows `"storage":"postgres"`.

Alternative without GitHub: install the Railway CLI, then in this folder run `railway login`, `railway init`, `railway up`, and do steps 3–5 in the dashboard.

## Run on your laptop

```
npm install
APP_PIN=1234 node server.js
```
Open http://localhost:3000

## Printing

Top bar → 🖨 Printer:
- **Bluetooth (direct)** – BLE thermal printers, from Chrome on Android / Windows / Mac. Tap Connect, pick the printer.
- **RawBT (Android)** – for printers that pair only in phone Bluetooth settings. Install "RawBT" from Play Store, pair the printer in it once.
- **Normal print** – USB or installed printers.

Bluetooth from the browser needs HTTPS, which the Railway domain provides. iPhone browsers don't support Web Bluetooth.

## Changing the PIN

Change `APP_PIN` in Railway Variables. Every device will be asked for the new PIN.
