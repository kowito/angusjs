import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { defineApp } from '../core/app.ts'
import { createApp } from '../core/project.ts'
import { f } from '../db/fields.ts'
import { defineModel } from '../db/model.ts'
import { router } from '../routing/router.ts'
import { clientFor, testDatabase, type TestClient, type TestDatabase } from '../testing/index.ts'
import {
  contentTypeFor,
  fileUrl,
  localStorage,
  memoryStorage,
  safeKey,
  setStorage,
  uniqueKey,
  upload,
  UploadError,
  type MemoryStorage,
} from './index.ts'
import { storageRoutes } from './routes.ts'

const Document = defineModel('stDocument', {
  fields: {
    title: f.char({ maxLength: 60 }),
    attachment: f.file({ null: true, uploadTo: 'docs' }),
    cover: f.image({ null: true, maxBytes: 1024 }),
  },
  meta: { tableName: 'st_documents' },
})

const TEMP_ROOT = `${import.meta.dir}/../../.storage-test`

describe('key safety', () => {
  test('strips path traversal rather than trying to detect it', () => {
    // A key cannot express a parent directory at all, which is stronger than
    // rejecting the ones we thought to look for.
    expect(safeKey('../../etc/passwd')).toBe('passwd')
    expect(safeKey('/absolute/path/file.txt')).toBe('file.txt')
    expect(safeKey('..\\..\\windows\\system32')).toBe('system32')
    expect(safeKey('....//evil.sh')).toBe('evil.sh')
  })

  test('replaces characters that would confuse a filesystem or URL', () => {
    expect(safeKey('my file (final).pdf')).toBe('my-file--final-.pdf')
    expect(safeKey('résumé.pdf')).toBe('r-sum-.pdf')
  })

  test('a prefix cannot escape either', () => {
    expect(safeKey('a.txt', '../secrets')).toBe('secrets/a.txt')
    expect(safeKey('a.txt', 'invoices/2026')).toBe('invoices/2026/a.txt')
  })

  test('an empty or dot-only name still yields a key', () => {
    expect(safeKey('...')).toBe('file')
    expect(safeKey('')).toBe('file')
  })

  test('uniqueKey keeps the extension but avoids collisions', () => {
    const first = uniqueKey('photo.jpg', 'avatars')
    const second = uniqueKey('photo.jpg', 'avatars')

    expect(first).toMatch(/^avatars\/photo-[a-f0-9]{8}\.jpg$/)
    expect(first).not.toBe(second)
  })

  test('content types come from the extension', () => {
    expect(contentTypeFor('a/b/c.png')).toBe('image/png')
    expect(contentTypeFor('report.pdf')).toBe('application/pdf')
    expect(contentTypeFor('mystery.xyz')).toBe('application/octet-stream')
  })
})

describe('the memory backend', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = memoryStorage()
    setStorage({ backend: storage })
  })

  test('saves, reads and deletes', async () => {
    const stored = await storage.save('a/b.txt', 'hello')

    expect(stored).toEqual({ key: 'a/b.txt', size: 5, contentType: 'text/plain' })
    expect(await (await storage.read('a/b.txt'))!.text()).toBe('hello')
    expect(await storage.exists('a/b.txt')).toBe(true)

    expect(await storage.delete('a/b.txt')).toBe(true)
    expect(await storage.read('a/b.txt')).toBeNull()
    expect(await storage.delete('a/b.txt')).toBe(false)
  })

  test('refuses to overwrite unless asked', async () => {
    await storage.save('x.txt', 'one')
    expect(storage.save('x.txt', 'two')).rejects.toThrow(/already exists/)

    await storage.save('x.txt', 'two', { overwrite: true })
    expect(await (await storage.read('x.txt'))!.text()).toBe('two')
  })

  test('reading a missing key returns null rather than throwing', async () => {
    expect(await storage.read('nope.txt')).toBeNull()
  })
})

describe('the local backend', () => {
  const storage = localStorage({ root: TEMP_ROOT, baseUrl: 'https://cdn.example.com/files' })

  afterAll(async () => {
    await rm(TEMP_ROOT, { recursive: true, force: true })
  })

  test('writes to disk and reads back', async () => {
    const stored = await storage.save('nested/deep/file.txt', 'on disk', { overwrite: true })
    expect(stored.size).toBe(7)
    expect(await (await storage.read('nested/deep/file.txt'))!.text()).toBe('on disk')
  })

  test('refuses a key that resolves outside the root', async () => {
    // The second line of defence: safeKey is the first, this holds if a key
    // reaches the backend without passing through it.
    expect(storage.save('../escaped.txt', 'nope')).rejects.toThrow(/outside the storage root/)
    expect(storage.read('../../etc/passwd')).rejects.toThrow(/outside the storage root/)
  })

  test('builds a URL from the base', async () => {
    expect(await storage.url('a/b.png')).toBe('https://cdn.example.com/files/a/b.png')
  })

  test('without a baseUrl it says so rather than returning something wrong', async () => {
    const bare = localStorage({ root: TEMP_ROOT })
    expect(bare.url('a.png')).rejects.toThrow(/no baseUrl/)
  })
})

describe('uploads', () => {
  let storage: MemoryStorage

  beforeEach(() => {
    storage = memoryStorage()
    setStorage({ backend: storage, maxBytes: 100 })
  })

  const fileOf = (name: string, bytes: number, type = 'image/png') =>
    new File([new Uint8Array(bytes)], name, { type })

  test('stores the file and returns a key', async () => {
    const stored = await upload(fileOf('photo.png', 10), { prefix: 'avatars' })

    expect(stored.key).toMatch(/^avatars\/photo-[a-f0-9]{8}\.png$/)
    expect(stored.contentType).toBe('image/png')
    expect(await storage.exists(stored.key)).toBe(true)
  })

  test('rejects a file over the limit before writing anything', async () => {
    // Checked before the backend sees it: a backend that already accepted 4GB
    // has done the expensive part.
    expect(upload(fileOf('big.png', 500))).rejects.toThrow(UploadError)
    expect(storage.files.size).toBe(0)
  })

  test('rejects an empty file', async () => {
    expect(upload(fileOf('empty.png', 0))).rejects.toThrow(/empty/)
  })

  test('enforces accepted types, with a wildcard', async () => {
    expect(upload(fileOf('doc.pdf', 10, 'application/pdf'), { accept: ['image/*'] })).rejects.toThrow(/not accepted/)
    await upload(fileOf('ok.png', 10, 'image/png'), { accept: ['image/*'] })
    await upload(fileOf('ok.pdf', 10, 'application/pdf'), { accept: ['application/pdf'] })
  })

  test('keepName preserves the filename', async () => {
    const stored = await upload(fileOf('exact.png', 10), { keepName: true })
    expect(stored.key).toBe('exact.png')
  })

  test('a malicious filename cannot escape the prefix', async () => {
    const stored = await upload(fileOf('../../../evil.png', 10), { prefix: 'avatars' })
    expect(stored.key.startsWith('avatars/')).toBe(true)
    expect(stored.key).not.toContain('..')
  })

  test('fileUrl returns null for an empty column', async () => {
    expect(await fileUrl(null)).toBeNull()
    expect(await fileUrl('')).toBeNull()
  })
})

describe('field kinds', () => {
  test('a file column stores the key, not the bytes', () => {
    expect(Document.fields.attachment!.spec.kind).toBe('file')
    expect(Document.fields.attachment!.spec.uploadTo).toBe('docs')
    expect(Document.columns.attachment).toBe('attachment')
  })

  test('an image field restricts to image types by default', () => {
    expect(Document.fields.cover!.spec.kind).toBe('image')
    expect(Document.fields.cover!.spec.accept).toEqual(['image/*'])
    expect(Document.fields.cover!.spec.maxBytes).toBe(1024)
  })
})

describe('endpoints', () => {
  let db: TestDatabase
  let client: TestClient
  let storage: MemoryStorage

  beforeAll(async () => {
    db = await testDatabase({ models: [Document] })
    storage = memoryStorage()

    const app = await createApp(
      {
        apps: [defineApp({ name: 'files', prefix: '/', urls: storageRoutes({ prefix: 'uploads' }) })],
        prefix: '/api',
        openapi: false,
        storage: { backend: storage, maxBytes: 1000 },
      },
      { connectDatabase: false },
    )
    client = clientFor(app, { basePath: '/api' })
  })

  afterAll(async () => {
    await db.close()
  })

  beforeEach(() => {
    storage.clear()
  })

  const formWith = (file: File) => {
    const body = new FormData()
    body.set('file', file)
    return body
  }

  test('uploading returns a key the client sends back in a normal JSON body', async () => {
    const response = await client.request('POST', '/upload', {
      body: formWith(new File([new Uint8Array(20)], 'photo.png', { type: 'image/png' })),
    })

    expect(response.status).toBe(201)
    expect(response.body.key).toMatch(/^uploads\/photo-/)
    expect(response.body.size).toBe(20)
    expect(await storage.exists(response.body.key)).toBe(true)
  })

  test('an oversized upload is a 400, not a 500', async () => {
    const response = await client.request('POST', '/upload', {
      body: formWith(new File([new Uint8Array(5000)], 'big.png', { type: 'image/png' })),
    })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('bad_request')
  })

  test('the served file comes back with its content type and an immutable cache', async () => {
    const uploaded = await client.request('POST', '/upload', {
      body: formWith(new File(['hello'], 'note.txt', { type: 'text/plain' })),
    })

    const served = await client.get(`/files/${uploaded.body.key}`)
    expect(served.status).toBe(200)
    expect(served.text).toBe('hello')
    expect(served.headers.get('cache-control')).toContain('immutable')
  })

  test('a missing file is a 404', async () => {
    expect((await client.get('/files/nope.txt')).status).toBe(404)
  })
})
