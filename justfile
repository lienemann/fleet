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
