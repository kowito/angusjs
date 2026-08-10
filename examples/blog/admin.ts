import { adminSite } from 'angusjs/admin'

/**
 * The project's admin site. Each app registers its own models into it from
 * `apps/<name>/admin.ts`, which that app's `app.ts` imports for its side effect
 * — the same shape as Django's `admin.py`.
 *
 * With no `permissions` configured the admin serves in development and refuses
 * in production. A real deployment passes its own staff check:
 *
 *   adminSite({ permissions: [isStaff] })
 */
export default adminSite({ title: 'Blog admin' })
