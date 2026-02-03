# Enhanced CLI Initiative

## Overview

The enhanced CLI provides a unified, configurable project initialization experience. Instead of multiple separate templates, there's now one smart template that adapts to your choices.

## New Features

### 1. Unified Template System

**Before:** Separate templates for `starter` and `sveltekit-app`
**After:** One template that configures itself based on your choices

```bash
donkeylabs init my-app
# Interactive prompts for:
# - Database type
# - Frontend (none/SvelteKit)
# - Plugins
# - Demo content
# - Deployment strategy
```

### 2. Database Choices

Choose your database during initialization:

- **SQLite** (default for VPS): File-based, perfect for single-server deployments
- **PostgreSQL**: Production-grade, scalable
- **MySQL**: Compatible with existing infrastructure

### 3. Plugin Selection

Select which plugins to include:

| Plugin | Description | Default |
|--------|-------------|---------|
| `users` | User management | ✅ Yes |
| `auth` | JWT authentication | ✅ Yes |
| `backup` | Litestream backups | ✅ Yes |
| `storage` | File uploads (S3/Local) | ❌ No |
| `email` | Email sending | ❌ No |
| `cron` | Scheduled jobs | ❌ No |
| `audit` | Audit logging | ❌ No |

### 4. Frontend Options

- **None**: API-only server
- **SvelteKit**: Full-stack with adapter (no separate template needed!)

### 5. Deployment Strategies

Choose how to deploy:

- **Docker** (recommended for VPS): Complete containerization with docker-compose
- **Binary**: Compile and run directly
- **PM2**: Node process manager

### 6. Demo Content

Optional demo content including:
- Sample routes
- Example pages (if SvelteKit)
- Test data
- Documentation

## Usage

### Interactive Mode

```bash
donkeylabs init
# Follow the prompts...
```

### Quick Mode

```bash
# With defaults (SQLite, SvelteKit, standard plugins)
donkeylabs init my-app --defaults

# API-only with PostgreSQL
donkeylabs init my-api --database postgres --frontend none
```

### After Creation

```bash
cd my-app
bun install

# Development
bun run dev

# Build for production
bun run build

# Deploy
docker-compose up -d
```

## Configuration

### Database

**SQLite** (default):
```env
DATABASE_URL=./data/app.db
```

**PostgreSQL**:
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/db
```

**MySQL**:
```env
DATABASE_URL=mysql://user:pass@localhost:3306/db
```

### Backup (Litestream for SQLite)

Automatically configured with SQLite:

```env
BACKUP_S3_URL=s3://my-backup-bucket/db
BACKUP_ACCESS_KEY=xxx
BACKUP_SECRET_KEY=xxx
BACKUP_REGION=us-east-1
```

### Storage

Local files:
```env
STORAGE_ADAPTER=local
UPLOAD_DIR=./uploads
```

S3/MinIO:
```env
STORAGE_ADAPTER=s3
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY=xxx
S3_SECRET_KEY=xxx
```

## Project Structure

```
my-app/
├── src/
│   ├── server/
│   │   ├── plugins/          # Selected plugins
│   │   │   ├── users/
│   │   │   ├── auth/
│   │   │   └── backup/
│   │   ├── routes/
│   │   │   └── api.ts        # API routes
│   │   ├── index.ts          # Server entry
│   │   └── db.ts             # Database config
│   └── routes/               # SvelteKit pages (if selected)
├── docker-compose.yml        # If Docker selected
├── Dockerfile
├── .env
├── .env.example
└── README.md
```

## VPS Deployment Guide

Perfect for your VPS setup:

### 1. Create Project

```bash
donkeylabs init my-vps-app
# Choose: SQLite, SvelteKit, [users, auth, backup], Docker
```

### 2. Configure Environment

```bash
cd my-vps-app
# Edit .env with your values
```

### 3. Deploy

```bash
# On your VPS
git clone <your-repo>
cd my-vps-app

docker-compose up -d
```

### 4. Backup (Litestream)

Backups run automatically to S3. To restore:

```bash
docker-compose exec litestream litestream restore -o /data/app.db s3://my-bucket/db
```

### 5. Update

```bash
# Pull updates
git pull

# Rebuild and restart
docker-compose up -d --build
```

## Migration from Old Templates

If you have existing projects from the old templates:

1. They continue to work as-is
2. To upgrade, manually copy the structure
3. Or create new project and migrate code

## Benefits

1. **Less Confusion**: One clear path instead of multiple templates
2. **More Flexibility**: Configure exactly what you need
3. **Best Practices**: Sensible defaults for production
4. **VPS-Ready**: SQLite + Litestream perfect for single-server setups
5. **Extensible**: Easy to add more plugins and options

## Future Enhancements

- [ ] More database options (Redis, MongoDB)
- [ ] More frontend options (React, Vue)
- [ ] More deployment targets (Kubernetes, Fly.io)
- [ ] Plugin templates from registry
- [ ] Configuration presets (e-commerce, blog, SaaS)
