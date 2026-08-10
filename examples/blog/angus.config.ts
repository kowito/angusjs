import { defineSettings } from 'angusjs'
import admin from './admin.ts'
import blog from './apps/blog/app.ts'

export default defineSettings({
  // The admin mounts at its own path, outside the `/api` prefix below.
  apps: [blog, admin.app()],

  database: {
    dialect: 'sqlite',
    url: 'db.sqlite',
  },

  prefix: '/api',

  server: {
    port: 8000,
  },

  openapi: {
    title: 'angusjs blog example',
    version: '0.1.0',
    description: 'Three models, one view set each, plus a couple of hand-written views.',
  },
})
