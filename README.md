# A2Z Food Corner – Billing Counter

Billing, order history, day summary and Bluetooth thermal printing for A2Z Food Corner.

- `public/index.html` – the billing app
- `api/index.js` – Vercel serverless function (all `/api/*` routes)
- `lib/app.js` – API logic + storage (Postgres, or a local JSON file when no database is set)
- `server.js` – run everything on your own computer

## Deploy on Vercel (free)

1. vercel.com → **Add New… → Project** → import the `A2Z_cafe` GitHub repo.
   Framework preset: **Other**. Leave build settings empty. **Deploy**.
2. Project → **Storage** tab → **Create Database** → **Neon** (Serverless Postgres, free plan) → connect it to this project.
   This adds `DATABASE_URL` automatically.
3. Project → **Settings → Environment Variables**, add:
   - `APP_PIN` – your shop PIN, e.g. `482916`
   - `SESSION_SECRET` – any long random text
4. **Deployments** → latest → **⋯ → Redeploy** (so the new variables are used).
5. Open `https://<project>.vercel.app/healthz` – it should show `"storage":"postgres"`.

## Run on your laptop

```
npm install
set APP_PIN=1234      (PowerShell: $env:APP_PIN="1234")
node server.js
```
Open http://localhost:3000. Without a database URL it saves to `data/db.json`.

## Printing

Top bar → 🖨 Printer:
- **Bluetooth (direct)** – BLE thermal printers, Chrome on Android / Windows / Mac. Tap Connect, pick the printer.
- **RawBT (Android)** – printers that pair only in phone Bluetooth settings. Install "RawBT" from Play Store and pair the printer in it once.
- **Normal print** – USB or installed printers.

iPhone browsers don't support Web Bluetooth.

## Changing the PIN

Change `APP_PIN` in Vercel → Settings → Environment Variables, then redeploy.
