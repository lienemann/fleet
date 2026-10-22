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
