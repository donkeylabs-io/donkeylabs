# test-app

Built with DonkeyLabs framework

## Features

- **Database**: sqlite
- **Frontend**: SvelteKit
- **Plugins**: users
- **Deployment**: binary

## Getting Started

```bash
# Install dependencies
bun install

# Set up environment
cp .env.example .env
# Edit .env with your values

# Create data directory
mkdir -p data

# Run migrations
bun scripts/migrate.ts

# Start development
bun run dev
```

## Project Structure

```
src/
├── server/
│   ├── plugins/          # Business logic plugins
│   ├── routes/           # API routes
│   ├── index.ts          # Server entry
│   └── db.ts             # Database configuration
├── routes/             # SvelteKit pages
├── app.html
└── app.css
```

## Available Plugins

- **users**: User management

## Deployment

### Binary

```bash
# Build
bun run build

# Run
bun run dist/index.js
```

## Documentation

- [DonkeyLabs Docs](https://donkeylabs.io/docs)
- [API Reference](https://donkeylabs.io/docs/api)

## License

MIT
