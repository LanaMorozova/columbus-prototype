#!/usr/bin/env bash
# Deploys the password-protected prototype to the existing "columbus" Worker,
# together with its two secrets. The secrets are typed (password) or generated
# (session secret) at deploy time, written to a private temporary file that is
# deleted when the script ends, and never saved in the project or printed.
#
# Compatible with the default macOS Bash 3.2 (no arrays, safe with `set -u`).
set -euo pipefail
cd "$(dirname "$0")/.."

WORKER_NAME="columbus"
grep -q "\"name\": \"$WORKER_NAME\"" wrangler.jsonc || { echo "wrangler.jsonc is not set to the \"$WORKER_NAME\" Worker. Stopping."; exit 1; }

echo "Deploying to the existing Cloudflare Worker: $WORKER_NAME"
echo
PW=""
PW2=""
read -r -s -p "Prototype password (hidden): " PW; echo
read -r -s -p "Repeat the password (hidden): " PW2; echo
if [ "$PW" != "$PW2" ]; then echo "The passwords do not match. Nothing was deployed."; exit 1; fi
if [ "${#PW}" -lt 12 ]; then echo "Use at least 12 characters. Nothing was deployed."; exit 1; fi
PW2=""

# Random 48-byte session signing key. Nobody needs to know it.
SESSION=$(openssl rand -base64 48 | tr -d '\n')

TMP=$(mktemp "${TMPDIR:-/tmp}/columbus-secrets.XXXXXX")
chmod 600 "$TMP"
trap 'rm -f "$TMP"; PW=""; SESSION=""' EXIT
PW="$PW" SESSION="$SESSION" node -e 'process.stdout.write(JSON.stringify({PROTOTYPE_PASSWORD:process.env.PW,SESSION_SECRET:process.env.SESSION}))' > "$TMP"

# --strict stops the upload if the Worker was changed in the dashboard in a way this config would overwrite.
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "(dry run: nothing will be uploaded)"
  npx wrangler deploy --secrets-file "$TMP" --strict --dry-run
  echo
  echo "Dry run finished. Nothing was uploaded, and the temporary file has been deleted."
else
  npx wrangler deploy --secrets-file "$TMP" --strict
  echo
  echo "Done. The secrets were uploaded with this version and the temporary file has been deleted."
fi
