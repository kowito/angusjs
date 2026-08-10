import { defineApp } from 'angusjs'
import { Author, Comment, Post } from './models.ts'
import urls from './urls.ts'
// Imported for its side effect: registers this app's models with the admin.
import './admin.ts'

export default defineApp({
  name: 'blog',
  prefix: '/',
  models: { Author, Post, Comment },
  urls,
})
