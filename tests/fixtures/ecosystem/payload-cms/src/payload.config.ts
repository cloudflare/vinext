import path from 'path'
import { sqliteD1Adapter } from '@payloadcms/db-d1-sqlite'
import { lexicalEditor } from '@payloadcms/richtext-lexical'
import { buildConfig } from 'payload'
import { fileURLToPath } from 'url'
import { r2Storage } from '@payloadcms/storage-r2'

import { Users } from './collections/Users'
import { Media } from './collections/Media'
import { migrations } from './migrations'

const filename = fileURLToPath(import.meta.url)
const dirname = path.dirname(filename)

const isProduction = process.env.NODE_ENV === 'production'
let platformProxy:
  | {
      env: Cloudflare.Env
      dispose?: () => Promise<void>
    }
  | undefined

const createLog =
  (level: string, fn: typeof console.log) => (objOrMsg: object | string, msg?: string) => {
    if (typeof objOrMsg === 'string') {
      fn(JSON.stringify({ level, msg: objOrMsg }))
    } else {
      fn(JSON.stringify({ level, ...objOrMsg, msg: msg ?? (objOrMsg as { msg?: string }).msg }))
    }
  }

const cloudflareLogger = {
  level: process.env.PAYLOAD_LOG_LEVEL || 'info',
  trace: createLog('trace', console.debug),
  debug: createLog('debug', console.debug),
  info: createLog('info', console.log),
  warn: createLog('warn', console.warn),
  error: createLog('error', console.error),
  fatal: createLog('fatal', console.error),
  silent: () => {},
} as any // Use PayloadLogger type when it's exported

const cloudflare = await getCloudflareContext()

export default buildConfig({
  admin: {
    user: Users.slug,
    importMap: {
      baseDir: path.resolve(dirname),
    },
  },
  collections: [Users, Media],
  editor: lexicalEditor(),
  secret: process.env.PAYLOAD_SECRET || '',
  typescript: {
    outputFile: path.resolve(dirname, 'payload-types.ts'),
  },
  db: sqliteD1Adapter({
    binding: cloudflare.env.D1,
  }),
  logger: isProduction ? cloudflareLogger : undefined,
  plugins: isProduction && Boolean(cloudflare.env.R2)
    ? [
        r2Storage({
          bucket: cloudflare.env.R2,
          collections: { media: true },
        }),
      ]
    : [],
})

type CloudflareContext = { env: Cloudflare.Env }

async function getCloudflareContext(): Promise<CloudflareContext> {
  try {
    return await import(/* @vite-ignore */ 'cloudflare:workers')
  } catch (error) {
    if (isProduction || process.env.CI) {
      throw error
    }
  }

  if (!platformProxy) {
    const { getPlatformProxy } = await import(/* @vite-ignore */ 'wrangler')
    platformProxy = await getPlatformProxy({
      configPath: path.resolve(dirname, '../wrangler.jsonc'),
    })
  }

  if (!platformProxy.env.D1) {
    throw new Error('Missing D1 binding. Add a D1 database with binding "D1" to wrangler.jsonc.')
  }

  return { env: platformProxy.env }
}
