# Deploying to Cloudflare Workers

The web app is deployed as a **Cloudflare Worker with Static Assets** (not Pages). Static assets serve the Vite build from `apps/web/dist`, with SPA fallback for client-side routes. The Worker script (`worker/index.ts`) only runs for `/mcp/*` and `/bridge/*`: the remote **Claude connector** (see [MCP.md](MCP.md)), backed by one SQLite Durable Object class (`BridgeRoom`), which the Workers Free plan supports. Projects live in each user's browser; the local MCP server and the Godot companion run on the user's PC.

## Configuration

The first deploy after adding the connector creates the `BridgeRoom` Durable Object (migration `v1` in `wrangler.jsonc`); nothing to do by hand.


`wrangler.jsonc`:

```jsonc
{
  "name": "coding-studio",
  "compatibility_date": "2025-10-01",
  "assets": {
    "directory": "./apps/web/dist",
    "not_found_handling": "single-page-application",
    "html_handling": "auto-trailing-slash"
  }
}
```

Security headers come from `apps/web/public/_headers` (copied into the build): a strict CSP (`script-src 'self'`; `connect-src` limited to self and `ws://127.0.0.1:*` / `ws://localhost:*` for the MCP bridge), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (allows the local-network permission for the bridge) and immutable caching for hashed assets.

## Local test of the production build

```bash
npm run cf:dev                       # build + wrangler dev on http://localhost:8787
node scripts/dev/csp-check.mjs       # optional: verifies the app works under the production CSP
```

## Deploy

```bash
npx wrangler login                   # once, opens the browser
npm run cf:deploy                    # build + wrangler deploy
```

Wrangler prints the URL (e.g. `https://coding-studio.<account>.workers.dev`). In CI, set `CLOUDFLARE_API_TOKEN` (Workers edit permission) and `CLOUDFLARE_ACCOUNT_ID` instead of logging in. Custom domains: add `"routes"` to `wrangler.jsonc` or attach the domain in the dashboard.

## Using MCP with the deployed site

Add the deployed origin when registering the MCP server: `-e CODING_STUDIO_ORIGINS=https://coding-studio.<account>.workers.dev`. Browser restrictions for hosted pages connecting to localhost are described in [MCP.md](MCP.md#hosted-editor-and-browser-restrictions).
