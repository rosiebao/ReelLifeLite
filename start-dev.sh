#!/bin/bash

# ReelLife Development Mode Startup Script
# Uses src/.env for AWS credentials

# Work from the repo root so src/.env, node_modules and the frontend paths
# below resolve the same way no matter where this script is invoked from.
INVOKED_FROM="$(pwd)"
cd "$(dirname "$0")" || exit 1
REPO_ROOT="$(pwd)"

echo "🔧 Starting ReelLife API in DEVELOPMENT mode..."
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed!"
    echo ""
    echo "Please install Node.js (v18 or higher):"
    echo ""
    echo "📦 Installation options:"
    echo ""
    echo "  Option 1: Using Homebrew (recommended for Mac)"
    echo "    brew install node"
    echo ""
    echo "  Option 2: Using official installer"
    echo "    Visit: https://nodejs.org/"
    echo "    Download and install the LTS version"
    echo ""
    echo "  Option 3: Using nvm (Node Version Manager)"
    echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash"
    echo "    nvm install --lts"
    echo ""
    echo "After installation, run this script again: ./start-dev.sh"
    exit 1
fi

# Check if npm is available
if ! command -v npm &> /dev/null; then
    echo "❌ Error: npm is not available!"
    echo "npm should be installed with Node.js"
    echo "Please reinstall Node.js: https://nodejs.org/"
    exit 1
fi

# Display Node.js version
NODE_VERSION=$(node --version)
echo "✅ Node.js version: $NODE_VERSION"

# Check if src/.env exists (optional: without it the AI interviewer falls
# back to canned questions)
if [ ! -f "$REPO_ROOT/src/.env" ]; then
    echo "Note: src/.env not found - the AI interviewer will use canned questions."
fi

# Check if node_modules exists (dependencies are declared in src/package.json,
# which src/app.js resolves through src)
if [ ! -d "$REPO_ROOT/src/node_modules" ]; then
    echo "📦 Installing dependencies..."
    if ! (cd "$REPO_ROOT/src" && npm install); then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
fi

# Where the SQLite database lives. DATABASE_PATH is optional: unset means the
# default, src/app.db. A relative path is taken relative to the
# directory this script was run from, before the cd below changes it.
#   DATABASE_PATH=/var/lib/reellife/app.db ./start-dev.sh
#   DATABASE_PATH=data/app.db ./start-dev.sh
if [ -n "$DATABASE_PATH" ] && [ "$DATABASE_PATH" != ":memory:" ]; then
    case "$DATABASE_PATH" in
        /*) ;;
        *) DATABASE_PATH="$INVOKED_FROM/$DATABASE_PATH" ;;
    esac
    export DATABASE_PATH
fi

# Navigate to server directory
cd "$REPO_ROOT/src"

# Set development environment
export NODE_ENV=development

# The page app.js serves: express.static serves src/public at "/", so the
# starting page is src/public/index.html.
PORT="${PORT:-$(grep -E '^[[:space:]]*PORT=' "$REPO_ROOT/src/.env" 2>/dev/null | tail -1 | cut -d '=' -f2 | tr -d '[:space:]')}"
PORT=${PORT:-6767}
START_URL="http://localhost:${PORT}/"

if [ ! -f "$REPO_ROOT/src/public/index.html" ]; then
    echo "❌ Error: starting page not found: src/public/index.html"
    echo "The server would redirect '/' to a page that isn't there."
    exit 1
fi

# Open the starting page once the server is actually answering. Runs in the
# background so node stays in the foreground; skipped when NO_OPEN is set.
if [ -z "$NO_OPEN" ] && command -v curl &> /dev/null; then
    if command -v open &> /dev/null || command -v xdg-open &> /dev/null; then
        (
            for _ in $(seq 1 40); do
                if curl -sf -o /dev/null "$START_URL"; then
                    if command -v open &> /dev/null; then
                        open "$START_URL"
                    else
                        xdg-open "$START_URL"
                    fi
                    exit 0
                fi
                sleep 0.25
            done
        ) &
    fi
fi

# Start server
echo ""
echo "🚀 Starting server..."
echo "📍 URL: $START_URL"
echo "🗄️  Database: ${DATABASE_PATH:-$REPO_ROOT/src/app.db (default)}"
echo "📍 Press Ctrl+C to stop"
echo ""
node app.js
