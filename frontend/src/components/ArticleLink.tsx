import { Link } from 'react-router-dom';

/** Small "from: <article>" link used on calendar/watchlist rows so every item traces back to the research that produced it. */
export function ArticleLink({ article }: { article: { slug: string; title: string } | null }) {
  if (!article) return <span className="muted article-link-row">manual entry</span>;
  return (
    <span className="article-link-row muted">
      from{' '}
      <Link to={`/articles/${article.slug}`}>{article.title}</Link>
    </span>
  );
}
