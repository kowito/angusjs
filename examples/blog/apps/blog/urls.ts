import { NotFound, t, view } from 'angusjs'
import { modelViewSet, router } from 'angusjs/routing'
import { Author, Comment, Post } from './models.ts'
import { AuthorSerializer, CommentSerializer, PostSerializer } from './serializers.ts'

/**
 * A hand-written view, for the endpoints a view set doesn't cover. It carries
 * its own schema, so it is validated and documented like everything else.
 */
const postBySlug = view({
  params: t.Object({ slug: t.String() }),
  response: PostSerializer.read,
  summary: 'Retrieve a post by its slug',
  name: 'post-by-slug',
  tags: ['posts'],
  async handler({ params }) {
    const existing = await Post.objects.getOrNull({ slug: params.slug })
    if (!existing) throw new NotFound(`No post with slug "${params.slug}".`)

    // Count the read, then re-read with the author joined — PostSerializer
    // embeds it, and `update()` returns bare rows.
    await Post.objects.filter({ id: existing.id }).update({ views: existing.views + 1 })
    const post = await Post.objects.selectRelated('author').get({ id: existing.id })

    return PostSerializer.toRepresentation(post)
  },
})

const stats = view({
  response: t.Object({
    authors: t.Integer(),
    posts: t.Integer(),
    published: t.Integer(),
    totalViews: t.Union([t.Number(), t.Null()]),
  }),
  summary: 'Blog-wide counters',
  name: 'blog-stats',
  tags: ['meta'],
  async handler() {
    const [authors, posts, published, views] = await Promise.all([
      Author.objects.count(),
      Post.objects.count(),
      Post.objects.filter({ status: 'published' }).count(),
      Post.objects.all().aggregate({ total: 'sum:views' }),
    ])
    return { authors, posts, published, totalViews: views.total }
  },
})

export default router()
  .get('/stats', stats)
  .get('/posts/by-slug/:slug', postBySlug)
  .include(
    '/authors',
    modelViewSet({
      model: Author,
      serializer: AuthorSerializer,
      searchFields: ['name', 'email'],
      orderingFields: ['name', 'joinedAt'],
      tags: ['authors'],
    }),
  )
  .include(
    '/posts',
    modelViewSet({
      model: Post,
      serializer: PostSerializer,
      filterFields: ['status', 'author', 'views'],
      searchFields: ['title', 'body'],
      orderingFields: ['createdAt', 'views', 'title'],
      selectRelated: ['author'],
      tags: ['posts'],
    }),
  )
  .include(
    '/comments',
    modelViewSet({
      model: Comment,
      serializer: CommentSerializer,
      filterFields: ['post', 'approved'],
      orderingFields: ['createdAt'],
      // Readers only ever see approved comments, whatever they ask for.
      queryset: () => Comment.objects.filter({ approved: true }),
      actions: ['list', 'retrieve', 'create'],
      tags: ['comments'],
    }),
  )
