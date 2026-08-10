/**
 * Upload and download endpoints.
 *
 * Uploads are their own endpoint rather than multipart on every write, so JSON
 * endpoints stay JSON: a client uploads, gets a key back, and sends the key in
 * the ordinary body. That keeps the OpenAPI document and the generated client
 * free of multipart, and means a large file never blocks a small write.
 */

import { t } from 'elysia'
import { BadRequest, NotFound } from '../http/errors.ts'
import { router, type Permission, type Router } from '../routing/router.ts'
import { view } from '../routing/view.ts'
import { fileUrl, getStorage, upload, UploadError, type UploadOptions } from './index.ts'

export interface StorageRoutesOptions {
  /** Who may upload. Uploads are almost never anonymous. */
  permissions?: Permission[]
  /** Folder uploads land in. */
  prefix?: string
  accept?: readonly string[]
  maxBytes?: number
  /** Serves the bytes back, for backends with no public URL. Defaults to true. */
  serve?: boolean
}

export function storageRoutes(options: StorageRoutesOptions = {}): Router {
  const routes = router()

  routes.post(
    '/upload',
    view({
      body: t.Object({ file: t.File() }),
      response: {
        201: t.Object({ key: t.String(), size: t.Integer(), contentType: t.String(), url: t.Union([t.String(), t.Null()]) }),
      },
      summary: 'Upload a file',
      description: 'Returns a storage key to send in the body of a later write.',
      name: 'file-upload',
      tags: ['files'],
      permissions: options.permissions,
      async handler({ body, set }) {
        const uploadOptions: UploadOptions = {
          prefix: options.prefix,
          accept: options.accept,
          maxBytes: options.maxBytes,
        }

        try {
          const stored = await upload(body.file as File, uploadOptions)
          set.status = 201
          return { ...stored, url: await fileUrl(stored.key).catch(() => null) }
        } catch (error) {
          // A rejected upload is the caller's mistake, not a server fault.
          if (error instanceof UploadError) throw new BadRequest(error.message)
          throw error
        }
      },
    }),
  )

  if (options.serve !== false) {
    routes.get(
      '/files/*',
      async (context) => {
        const path = new URL((context.request as Request).url).pathname
        const key = decodeURIComponent(path.slice(path.indexOf('/files/') + '/files/'.length))
        if (!key) throw new NotFound('No file key given.')

        const blob = await getStorage().read(key)
        if (!blob) throw new NotFound('No such file.')

        return new Response(blob, {
          headers: {
            'content-type': blob.type || 'application/octet-stream',
            // Immutable because keys carry a random suffix: the bytes behind a
            // key never change, so a long cache is safe.
            'cache-control': 'public, max-age=31536000, immutable',
          },
        })
      },
      { name: 'file-serve', hidden: true },
    )
  }

  return routes
}
