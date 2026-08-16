#!/bin/bash

# ReelLife Development Mode Startup Script
# Uses config.json for AWS credentials

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

# Check if config.json exists
if [ ! -f "config.json" ]; then
    echo "❌ Error: config.json not found!"
    echo ""
    echo "Please create config.json with your AWS credentials."
    echo "You can copy from the example:"
    echo ""
    echo "  1. Copy the template:"
    echo "     cp .env.example config.json.template"
    echo ""
    echo "  2. Edit config.json and add your credentials"
    echo ""
    echo "See API_SETUP.md for detailed instructions."
    exit 1
fi

# Navigate to server directory
cd src/server

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
fi

# Set development environment
export NODE_ENV=development

# Start server
echo ""
echo "🚀 Starting server..."
echo "📍 URL: http://localhost:3000"
echo "📍 Press Ctrl+C to stop"
echo ""
node server.js
