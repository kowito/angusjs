/**
 * File storage.
 *
 * A stored file is a **string column holding a key**, not a blob and not a
 * separate table. The database records where the bytes are; the backend holds
 * them. That keeps rows small, makes a CDN possible, and means moving from
 * local disk to S3 changes configuration rather than schema.
 *
 * ```ts
 * avatar: f.image({ maxBytes: 2 * 1024 * 1024 })
 * ```
 *
 * The field is an IR kind, so validation, the admin widget and the OpenAPI
 * schema all follow from the one declaration — the same property every other
 * field type has.
 */

import { mkdir, rm, stat } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'

export interface StoredFile {
  /** Backend-relative key, which is what the column stores. */
  key: string
  size: number
  contentType: string
}

export interface SaveOptions {
  contentType?: string
  /** Overwrite an existing key instead of picking a new one. */
  overwrite?: boolean
}

export interface SignedUrlOptions {
  expiresInSeconds?: number
  /** Forces a download with this filename. */
  download?: string
}

export interface StorageBackend {
  readonly name: string
  save(key: string, data: Blob | ArrayBuffer | Uint8Array | string, options?: SaveOptions): Promise<StoredFile>
  read(key: string): Promise<Blob | null>
  delete(key: string): Promise<boolean>
  exists(key: string): Promise<boolean>
  /** A URL a browser can fetch. Signed and time-limited where the backend supports it. */
  url(key: string, options?: SignedUrlOptions): Promise<string>
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/**
 * Sanitises a filename into a storage key.
 *
 * Path traversal is the attack here: a user-supplied `../../etc/passwd` must
 * not escape the storage root. Rather than trying to detect traversal, every
 * separator and dot-segment is stripped, so a key cannot express a parent
 * directory at all.
 */
export function safeKey(filename: string, prefix = ''): string {
  const base = filename
    .replace(/\\/g, '/')
    .split('/')
    .pop()!
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 120)

  const cleaned = base === '' ? 'file' : base
  const folder = prefix
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^A-Za-z0-9._-]/g, '-'))
    .join('/')

  return folder ? `${folder}/${cleaned}` : cleaned
}

/** Adds randomness so two uploads of `photo.jpg` don't collide. */
export function uniqueKey(filename: string, prefix = ''): string {
  const key = safeKey(filename, prefix)
  const extension = extname(key)
  const stem = key.slice(0, key.length - extension.length)
  return `${stem}-${crypto.randomUUID().slice(0, 8)}${extension}`
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
}

export function contentTypeFor(key: string): string {
  return CONTENT_TYPES[extname(key).toLowerCase()] ?? 'application/octet-stream'
}

async function toBlob(data: Blob | ArrayBuffer | Uint8Array | string, contentType: string): Promise<Blob> {
  if (data instanceof Blob) return data
  return new Blob([data as unknown as ArrayBuffer], { type: contentType })
}

// ---------------------------------------------------------------------------
// Local disk
// ---------------------------------------------------------------------------

export interface LocalStorageOptions {
  /** Directory files are written under. */
  root: string
  /** URL prefix the root is served from, if it is served at all. */
  baseUrl?: string
}

/**
 * Writes to the filesystem. The default, because it needs no account and no
 * network — and because a project that starts on S3 usually can't run its own
 * tests.
 *
 * Every path is re-checked against the root after resolution, so a key that
 * somehow escaped `safeKey` still cannot write outside it.
 */
export function localStorage(options: LocalStorageOptions): StorageBackend {
  const root = resolve(options.root)

  const pathFor = (key: string): string => {
    const target = resolve(join(root, normalize(key)))
    // Belt and braces: sanitising the key is the first defence, this is the
    // one that holds if the first is ever bypassed.
    if (target !== root && !target.startsWith(root + sep)) {
      throw new Error(`Refusing to access "${key}": it resolves outside the storage root.`)
    }
    return target
  }

  return {
    name: 'local',

    async save(key, data, saveOptions = {}) {
      const contentType = saveOptions.contentType ?? contentTypeFor(key)
      const target = pathFor(key)

      if (!saveOptions.overwrite && (await Bun.file(target).exists())) {
        throw new Error(`"${key}" already exists. Pass { overwrite: true } to replace it.`)
      }

      await mkdir(dirname(target), { recursive: true })
      const blob = await toBlob(data, contentType)
      await Bun.write(target, blob)

      return { key, size: blob.size, contentType }
    },

    async read(key) {
      const file = Bun.file(pathFor(key))
      return (await file.exists()) ? file : null
    },

    async delete(key) {
      const target = pathFor(key)
      if (!(await Bun.file(target).exists())) return false
      await rm(target)
      return true
    },

    async exists(key) {
      return Bun.file(pathFor(key)).exists()
    },

    async url(key) {
      if (!options.baseUrl) {
        throw new Error(
          'localStorage has no baseUrl, so it cannot produce a URL. ' +
            'Set `baseUrl` and serve the root, or use `serveStorage()`.',
        )
      }
      return `${options.baseUrl.replace(/\/$/, '')}/${key}`
    },
  }
}

// ---------------------------------------------------------------------------
// In memory
// ---------------------------------------------------------------------------

export interface MemoryStorage extends StorageBackend {
  readonly files: Map<string, Blob>
  clear(): void
}

/** Keeps everything in a Map. For tests, which should not touch the disk. */
export function memoryStorage(): MemoryStorage {
  const files = new Map<string, Blob>()

  return {
    name: 'memory',
    files,
    clear: () => files.clear(),

    async save(key, data, options = {}) {
      const contentType = options.contentType ?? contentTypeFor(key)
      if (!options.overwrite && files.has(key)) {
        throw new Error(`"${key}" already exists. Pass { overwrite: true } to replace it.`)
      }
      const blob = await toBlob(data, contentType)
      files.set(key, blob)
      return { key, size: blob.size, contentType }
    },

    async read(key) {
      return files.get(key) ?? null
    },
    async delete(key) {
      return files.delete(key)
    },
    async exists(key) {
      return files.has(key)
    },
    async url(key) {
      return `memory://${key}`
    },
  }
}

// ---------------------------------------------------------------------------
// S3
// ---------------------------------------------------------------------------

export interface S3StorageOptions {
  bucket: string
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  /** For R2, MinIO, or any S3-compatible service. */
  endpoint?: string
  /** Public base URL — a CDN in front of the bucket, typically. */
  publicUrl?: string
  /** Lifetime of a signed URL when none is given. Defaults to 1 hour. */
  defaultExpirySeconds?: number
}

/**
 * S3 and anything speaking its API, through Bun's built-in client — so no AWS
 * SDK, and presigning is a library call rather than a hand-rolled signature.
 */
export function s3Storage(options: S3StorageOptions): StorageBackend {
  // Constructed lazily: importing this module should not require credentials.
  let client: any

  const bucket = async () => {
    if (!client) {
      const { S3Client } = await import('bun')
      client = new S3Client({
        bucket: options.bucket,
        region: options.region,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        endpoint: options.endpoint,
      })
    }
    return client
  }

  return {
    name: 's3',

    async save(key, data, saveOptions = {}) {
      const contentType = saveOptions.contentType ?? contentTypeFor(key)

      if (!saveOptions.overwrite && (await (await bucket()).file(key).exists())) {
        throw new Error(`"${key}" already exists. Pass { overwrite: true } to replace it.`)
      }

      const blob = await toBlob(data, contentType)
      await (await bucket()).write(key, blob, { type: contentType })

      return { key, size: blob.size, contentType }
    },

    async read(key) {
      const file = (await bucket()).file(key)
      return (await file.exists()) ? new Blob([await file.arrayBuffer()], { type: contentTypeFor(key) }) : null
    },

    async delete(key) {
      if (!(await (await bucket()).file(key).exists())) return false
      await (await bucket()).delete(key)
      return true
    },

    async exists(key) {
      return (await bucket()).file(key).exists()
    },

    async url(key, urlOptions = {}) {
      // A public bucket behind a CDN needs no signature, and signing every URL
      // would defeat caching.
      if (options.publicUrl) return `${options.publicUrl.replace(/\/$/, '')}/${key}`

      return (await bucket()).presign(key, {
        expiresIn: urlOptions.expiresInSeconds ?? options.defaultExpirySeconds ?? 3600,
        ...(urlOptions.download ? { responseContentDisposition: `attachment; filename="${urlOptions.download}"` } : {}),
      })
    },
  }
}

// ---------------------------------------------------------------------------
// The configured backend
// ---------------------------------------------------------------------------

export interface StorageSettings {
  backend?: StorageBackend
  /** Rejects an upload larger than this. Defaults to 10 MB. */
  maxBytes?: number
}

let active: StorageBackend | undefined
let limit = 10 * 1024 * 1024

export function getStorage(): StorageBackend {
  if (!active) {
    throw new Error(
      'No storage backend. Set `storage: { backend: localStorage({ root: "uploads" }) }` in your settings.',
    )
  }
  return active
}

export function hasStorage(): boolean {
  return active !== undefined
}

export function setStorage(settings: StorageSettings | undefined): void {
  active = settings?.backend
  if (settings?.maxBytes) limit = settings.maxBytes
}

export function maxUploadBytes(): number {
  return limit
}

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

export interface UploadOptions extends SaveOptions {
  /** Folder within the backend — `avatars`, `invoices/2026`. */
  prefix?: string
  /** Overrides the global limit for this upload. */
  maxBytes?: number
  /** Restricts content types. `image/*` is allowed as a wildcard. */
  accept?: readonly string[]
  /** Keeps the original filename instead of adding a random suffix. */
  keepName?: boolean
}

export class UploadError extends Error {
  constructor(message: string, readonly code: 'too-large' | 'wrong-type' | 'empty') {
    super(message)
    this.name = 'UploadError'
  }
}

function typeAllowed(contentType: string, accept: readonly string[]): boolean {
  return accept.some((pattern) =>
    pattern.endsWith('/*') ? contentType.startsWith(pattern.slice(0, -1)) : pattern === contentType,
  )
}

/**
 * Validates and stores an uploaded file, returning the key for the column.
 *
 * Size and type are checked *before* writing: a backend that has already
 * accepted 4GB has done the expensive part.
 */
export async function upload(file: File, options: UploadOptions = {}): Promise<StoredFile> {
  const ceiling = options.maxBytes ?? limit

  if (file.size === 0) throw new UploadError('The uploaded file is empty.', 'empty')
  if (file.size > ceiling) {
    throw new UploadError(
      `The file is ${Math.round(file.size / 1024)}KB; the limit is ${Math.round(ceiling / 1024)}KB.`,
      'too-large',
    )
  }

  const contentType = options.contentType ?? file.type ?? contentTypeFor(file.name)
  if (options.accept && !typeAllowed(contentType, options.accept)) {
    throw new UploadError(`Files of type "${contentType}" are not accepted here.`, 'wrong-type')
  }

  const key = options.keepName ? safeKey(file.name, options.prefix) : uniqueKey(file.name, options.prefix)
  return getStorage().save(key, file, { contentType, overwrite: options.overwrite })
}

/** The URL for a stored key, or null when the column is empty. */
export async function fileUrl(key: string | null | undefined, options?: SignedUrlOptions): Promise<string | null> {
  if (!key) return null
  return getStorage().url(key, options)
}

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'] as const
