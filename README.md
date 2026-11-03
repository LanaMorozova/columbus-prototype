# Columbus (HACG) prototype - password protected

Deploys to the existing Cloudflare Worker **`columbus`** (set in `wrangler.jsonc`).

Every request goes through `src/worker.js` first (`run_worker_first`). Without a valid
session the Worker returns only the password screen (`src/login.html`, bundled into the
Worker). `public/index.html` is never served without a session.

- `public/index.html` - the prototype
- `src/login.html` - the password screen
- `src/worker.js` - login, signed 24-hour session cookie, rate limiting, asset protection
- `scripts/deploy.sh` - first deployment: asks for the password, generates the session
  secret, uploads both as encrypted secrets with the new version, deletes the temp file

Commands (run inside this folder):
- `npm install` - once
- `npm run check` - build check, uploads nothing
- `npx wrangler login` - once, opens the browser
- `npm run deploy:secure` - first deployment with both secrets
- `npm run deploy` - later code/content updates (secrets are kept)
- `npx wrangler rollback` - go back to the previous version if needed

Local testing: copy `.dev.vars.example` to `.dev.vars`, then `npm run dev`.
