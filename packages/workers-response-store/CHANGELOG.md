# @cloudflare/workers-response-store

## 0.1.0-beta.2

### Features

- **Response Store:** expose metadata location hints (#3383)

### Bug Fixes

- **Response Store:** retain unaccepted edge purges (#3366)
- **Response Store:** avoid redundant broad purge (#3360)

### Performance

#### Response Store

- project refresh candidates (#3389)
- index tombstone sequences (#3387)
- index path-prefix selection (#3386)
- bound manual refresh concurrency (#3371)
- scope purge work to snapshot (#3372)
- skip first-write edge purges (#3374)
- bound tombstone cleanup work (#3384)
- index cache tag lookups (#3359)

### Contributors

- @james-elicx

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
