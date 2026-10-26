# Sync dependencies
develop:
    npm install

# Format the code
format:
    npm run format

# Run static code analysis
lint:
    npm run lint
    npm run typecheck

# Run unit tests
test: develop
    npm run test

# Build the web UI and start the daemon
run: develop
    npm run build:web
    npm start

# Build the web UI and start the daemon with scripted agents
demo: develop
    npm run build:web
    FLEET_DEMO=1 npm start

# End-to-end tests in Chromium, Firefox and WebKit
e2e: develop
    npx playwright install chromium firefox webkit
    npm run test:e2e

# Build the web UI and put the `fleet` command into ~/.local/bin
install: develop
    npm run build:web
    mkdir -p ~/.local/bin
    ln -sf "{{justfile_directory()}}/src/cli.ts" ~/.local/bin/fleet

# Take the screenshots for the README and the homepage again from a demo daemon
screenshots: develop
    npm run build:web
    node scripts/screenshots.ts

# Put the homepage together in dist/site and serve it on http://127.0.0.1:7850
site: develop
    node scripts/site.ts
    python3 -m http.server -d dist/site 7850 --bind 127.0.0.1
