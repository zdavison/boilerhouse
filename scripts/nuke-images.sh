#!/bin/bash
# Removes all boilerhouse/* images via the boilerhoused daemon API.
# Usage: nuke-images.sh <socket-path> [true|false]
#   socket-path: path to the daemon's Unix socket
#   dry-run:     "true" to only list images (default: "false")

set -euo pipefail

SOCKET="$1"
DRY_RUN="${2:-false}"

# Use bun to talk HTTP over Unix socket (same transport as DaemonBackend)
"${BUN:-bun}" -e "
const http = require('node:http');

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: '$SOCKET', path, method }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const { body: images } = await request('GET', '/images');
  const bhImages = images.filter(img => img.tags.some(t => t.includes('boilerhouse/')));

  if (bhImages.length === 0) {
    console.log('No boilerhouse/ podman images found.');
    return;
  }

  for (const img of bhImages) {
    const tag = img.tags.find(t => t.includes('boilerhouse/'));
    if ('$DRY_RUN' === 'true') {
      console.log('  podman image: ' + tag);
    } else {
      const res = await request('DELETE', '/images/' + encodeURIComponent(tag));
      if (res.status === 200) {
        console.log('Removed image ' + tag);
      } else {
        console.log('Failed to remove ' + tag + ': ' + JSON.stringify(res.body));
      }
    }
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
"
