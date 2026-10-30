#!/bin/sh
# Run the localhost browser on macOS or Linux and open it in the default browser.
#   ./scripts/localhost.sh [port]
exec node "$(dirname "$0")/localhost-server.js" "${1:-4180}" --open
