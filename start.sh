#!/bin/sh
# Start a local web server and open the Collaboration Board hub in your browser.
# Usage: ./start.sh   (Ctrl+C to stop)
cd "$(dirname "$0")" || exit 1
PORT=8000
URL="http://localhost:$PORT/index.html"

echo "Collaboration Board → $URL"
echo "(Ctrl+C to stop the server)"

# Open the browser shortly after the server starts.
( sleep 1
  case "$(uname)" in
    Darwin) open "$URL" ;;
    Linux)  xdg-open "$URL" >/dev/null 2>&1 || echo "Open $URL in your browser" ;;
    *)      echo "Open $URL in your browser" ;;
  esac ) &

exec python3 -m http.server "$PORT"
