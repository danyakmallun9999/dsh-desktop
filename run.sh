#!/usr/bin/env bash
set -e

# Load NVM and Node environment if available
export NVM_DIR="$HOME/Dev/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  \. "$NVM_DIR/nvm.sh"
fi

# Ensure common Node / global binary paths are present
export PATH="$HOME/Dev/.nvm/versions/node/v24.2.0/bin:$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/bin:$PATH"

# Go to app directory and run electron
cd "/home/ipvdan/Dev/dsh-desktop"
npm start
