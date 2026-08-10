import admin from '../../admin.ts'
import { Author, Comment, Post } from './models.ts'

admin.register(Author, {
  group: 'People',
  listDisplay: ['id', 'name', 'email', 'joinedAt'],
  searchFields: ['name', 'email'],
  ordering: ['name'],
  readonlyFields: ['joinedAt'],
})

admin.register(Post, {
  group: 'Content',
  listDisplay: ['title', 'status', 'author', 'views', 'createdAt'],
  listFilter: ['status', 'author'],
  searchFields: ['title', 'body'],
  ordering: ['-createdAt'],
  readonlyFields: ['views'],
  listPerPage: 25,
})

admin.register(Comment, {
  group: 'Content',
  listDisplay: ['displayName', 'post', 'approved', 'createdAt'],
  listFilter: ['approved', 'post'],
  searchFields: ['body', 'displayName'],
})
