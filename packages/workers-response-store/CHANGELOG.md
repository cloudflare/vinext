# @cloudflare/workers-response-store

## 0.1.0-beta.1

### Features

- **Response Store:** read response metadata from R2 (#3339)
- **Response Store:** support for sharded durable objects (#3301)

### Bug Fixes

- **Response Store:** index orphan cleanup lookups (#3303)

### Performance

- **Response Store:** coalesce binding metadata misses (#3304)

### Contributors

- @james-elicx

## 0.1.0-beta.0

### Features

#### Cache

- support self-contained response store (#3246)
- lazily resolve response store tag expirations (#3203)
- add Workers Response Store POC (#3192)

#### Misc

- **Cloudflare:** scaffold Response Store Wrangler config (#3249)

### Bug Fixes

- **Cloudflare:** declare response store durable object export (#3262)

### Performance

- **Cache:** reduce response store Durable Object load (#3213)

### Contributors

- @james-elicx
