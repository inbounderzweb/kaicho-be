# Kaicho Backend

Express + TypeScript API for Kaicho.

## Structure

```
kaicho-be/
├── src/
│   ├── app.ts              # Express app setup
│   ├── server.ts           # Entry point
│   ├── config/env.ts       # Environment config
│   ├── common/
│   │   ├── errors/         # AppError
│   │   ├── middleware/     # notFound, errorHandler
│   │   ├── utils/          # asyncHandler, appInfo
│   │   └── types/          # Shared types
│   ├── modules/
│   │   ├── health/         # GET /api/health
│   │   └── version/        # GET /api/version
│   ├── database/
│   │   ├── connection.ts
│   │   └── models/
│   └── routes/index.ts     # Route aggregator
├── public/index.html       # Status dashboard UI
├── .env / .env.example
├── tsconfig.json
└── package.json
```

## Getting started

```bash
npm install
cp .env.example .env
npm run dev
```

The server starts on `http://localhost:4000` by default.

- `/` — status dashboard (health, version, uptime)
- `GET /api/health` — health check JSON
- `GET /api/version` — app name, version, environment JSON

## Scripts

- `npm run dev` — start with hot reload
- `npm run build` — compile TypeScript to `dist/`
- `npm start` — run compiled build
