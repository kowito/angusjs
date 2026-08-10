import { t } from 'angusjs'
import { serializer } from 'angusjs/serializers'
import { Author, Comment, Post } from './models.ts'

export const AuthorSerializer = serializer(Author, {
  readOnly: ['id', 'joinedAt'],
  computed: {
    postCount: {
      schema: t.Integer(),
      get: (author) => Post.objects.filter({ author: author.id }).count(),
    },
  },
})

/** A trimmed author, embedded in post responses. */
const AuthorSummarySerializer = serializer(Author, { name: 'AuthorSummary', fields: ['id', 'name'] })

export const PostSerializer = serializer(Post, {
  readOnly: ['id', 'views', 'createdAt', 'updatedAt'],
  // Responses embed the author; requests still take `author: <id>`.
  nested: { author: AuthorSummarySerializer },
  computed: {
    excerpt: {
      schema: t.String(),
      get: (post) => (post.body.length > 140 ? `${post.body.slice(0, 140)}…` : post.body),
    },
  },
})

export const CommentSerializer = serializer(Comment, {
  // `approved` is moderated server-side, never set by the commenter.
  readOnly: ['id', 'approved', 'createdAt'],
})
