import { defineModel, f } from 'angusjs/db'

export const Author = defineModel('author', {
  fields: {
    name: f.char({ maxLength: 100 }),
    email: f.email({ unique: true }),
    bio: f.text({ blank: true, default: '' }),
    joinedAt: f.datetime({ autoNowAdd: true }),
  },
  meta: {
    ordering: ['name'],
    verboseNamePlural: 'authors',
  },
})

export const Post = defineModel('post', {
  fields: {
    title: f.char({ maxLength: 200 }),
    slug: f.slug({ unique: true, maxLength: 200 }),
    body: f.text({ blank: true, default: '' }),
    status: f.char({ choices: ['draft', 'published', 'archived'], default: 'draft' }),
    views: f.integer({ default: 0, min: 0 }),
    author: f.foreignKey(() => Author, { relatedName: 'posts' }),
    createdAt: f.datetime({ autoNowAdd: true }),
    updatedAt: f.datetime({ autoNow: true }),
  },
  meta: {
    ordering: ['-createdAt'],
    indexes: [{ fields: ['status', 'createdAt'] }],
  },
})

export const Comment = defineModel('comment', {
  fields: {
    post: f.foreignKey(() => Post),
    // Anonymous comments are allowed, so the relation is nullable.
    author: f.foreignKey(() => Author, { null: true, onDelete: 'set null' }),
    displayName: f.char({ maxLength: 80, default: 'Anonymous' }),
    body: f.text(),
    approved: f.boolean({ default: false }),
    createdAt: f.datetime({ autoNowAdd: true }),
  },
  meta: {
    ordering: ['createdAt'],
  },
})
