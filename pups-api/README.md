# Plush Pups API

Standalone backend for the Plush Pups live chat. The frontend is hosted on Netlify;
this service serves only the JSON API and the Socket.IO connection.

Single file: `server.js`. `db.js` and `ai-engine.js` from the original project are
inlined, and all HTML/static serving has been removed.

## Deploy to Render

1. Push this directory to its own GitHub repo.
2. Render Dashboard -> **New -> Web Service** -> connect the repo.
3. Settings:

   | Field | Value |
   |---|---|
   | Root Directory | *(leave empty)* |
   | Build Command | `npm install --omit=dev` |
   | Publish Directory | **leave empty** |
   | Start Command | `npm start` |
   | Health Check Path | `/api/health` |

   The Publish Directory field must be blank. A Node web service has no build
   output; leaving a value like `build` there fails the deploy with
   "Publish directory build does not exist!".

   Alternatively, let Render read `render.yaml` as a Blueprint and skip step 2-3.

4. Set the environment variables in Render (Dashboard -> Environment):

   | Variable | Required | Notes |
   |---|---|---|
   | `JWT_SECRET` | yes | Admin token signing key. Blueprint generates one. |
   | `ADMIN_CODE` | yes | Admin panel login code. |
   | `GEMINI_API_KEY` | no | Enables AI replies. Without it, rule-based replies are used. |
   | `ALLOWED_ORIGINS` | recommended | Your Netlify URL, e.g. `https://yoursite.netlify.app`. Defaults to `*`. |
   | `DATA_DIR` | free plan only | `/var/data` requires a paid disk. Without it, data resets on every deploy. |

`server.js` never reads secrets from `db.json`, so nothing sensitive is committed.

## Point the Netlify frontend at this API

In the frontend repo, edit `site-config.js`:

```js
window.PUPS_API_BASE = 'https://plush-pups-api.onrender.com';
```

`chat-widget.js` reads that value for both `fetch` calls and the Socket.IO
connection, so no other frontend change is needed.

Two things the frontend must already do, since they were same-origin before:

- The admin login cookie is now set `SameSite=None; Secure`, so the admin panel
  must be served over HTTPS (Netlify is).
- Requests from the Netlify origin need to be allowed — set `ALLOWED_ORIGINS`.

## Data

`db.json` in this repo is a **seed**: business info, chat settings, FAQs, and the
puppy inventory. Runtime data (chats, messages, orders, customers) is written back
to the same file at `DATA_DIR`, or to `db.json` next to `server.js` when `DATA_DIR`
is unset.

The free Render plan has an ephemeral filesystem, so chats are lost on each deploy.
Use a paid instance with a disk mounted at `/var/data`, or an external database.

## Migrating existing data

The original `pups/db.json` held live chats, messages, orders and customers. To carry
them over, copy those arrays into this repo's `db.json` before the first deploy —
but note that customer names, emails and message contents will then be public in
git history. If that matters, migrate directly on the server instead:

```bash
# on the Render shell, or locally against a running instance
curl -H "Authorization: Bearer $TOKEN" https://<host>/api/admin/chats > chats.json
```

## Endpoints

Public:
- `GET /api/health`
- `GET /api/public/config`
- `GET /api/public/puppies`
- `POST /api/public/chat/init`
- `POST /api/public/chat/send` (requires `x-session-token` + `x-conversation-id`)
- `GET /api/public/chat/messages` (same)

Admin (requires `Authorization: Bearer <token>` or the `admin_token` cookie):
- `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `/api/admin/chats`, `/api/admin/customers`, `/api/admin/puppies`,
  `/api/admin/orders`, `/api/admin/payments`, `/api/admin/knowledge`,
  `/api/admin/business`, `/api/admin/whatsapp`, `/api/admin/chat-settings`,
  `/api/admin/notifications`, `/api/admin/settings`

Socket.IO events: `join:customer_conversation`, `join:admin`, `chat:message`,
`chat:session_updated`, `chat:session_deleted`, `chat:takeover_requested`,
`chat:config_updated`, `joined:success`, `joined:admin_success`, `chat:error`.
