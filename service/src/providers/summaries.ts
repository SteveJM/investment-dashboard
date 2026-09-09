/**
 * Pluggable news-summary provider, same pattern as `providers/prices.ts` and
 * `providers/news.ts`: an interface plus swappable implementations, selected
 * via `SUMMARY_PROVIDER`.
 *
 * `GeminiSummaryProvider` is the real implementation - it follows the
 * request scheme from the project's "Summarise News Articles" reference
 * doc: a POST to Gemini's `generateContent` endpoint with a prompt of the
 * shape "Summarize the following scraped web page contents:\n\nArticle
 * 1:\n[text]\n\nArticle 2:\n[text]...". Per that scheme it best-effort
 * *scrapes* each article's URL for real page text rather than only using
 * the short headline/snippet already cached in `news_items` - see
 * `scrapeArticleText` below - falling back to the cached headline+summary
 * when a fetch fails (paywall, JS-rendered page, dead link, timeout - any
 * of which are common and expected for arbitrary news sites, not bugs).
 *
 * `MockSummaryProvider` remains available (`SUMMARY_PROVIDER=mock`) for
 * deterministic offline dev/demo data with no network calls and no API key.
 */

export interface ArticleForSummary {
  headline: string;
  url: string | null;
  source: string | null;
  /** Whatever snippet the news provider already gave us, if any - see `providers/news.ts`. Used as a fallback when scraping the URL fails or there's no URL. */
  summary: string | null;
  publishedAt: string;
}

export interface SummaryProvider {
  summarize(symbol: string, companyName: string, articles: ArticleForSummary[]): Promise<string>;
}

const NO_NEWS_TEMPLATE = (name: string) => `No recent news articles are on file for ${name} yet.`;

export class MockSummaryProvider implements SummaryProvider {
  async summarize(symbol: string, companyName: string, articles: ArticleForSummary[]): Promise<string> {
    const name = companyName || symbol;
    if (articles.length === 0) return NO_NEWS_TEMPLATE(name);
    const headlines = articles.slice(0, 3).map((a) => `"${a.headline}"`).join(', ');
    return (
      `Mock summary for ${name}: based on ${articles.length} recent article(s) including ${headlines}, ` +
      `sentiment appears mixed with no single dominant theme. This is placeholder text - set ` +
      `SUMMARY_PROVIDER=gemini and GEMINI_API_KEY to generate real summaries (see service/README.md).`
    );
  }
}

const SCRAPE_TIMEOUT_MS = 8000;
const MAX_SCRAPED_CHARS = 6000;
const MAX_RESPONSE_BYTES = 2_000_000; // don't read an unbounded response body

// Hosts Yahoo (and some other sites) redirect a *logged-out, cookie-less*
// request to instead of the real article - a GDPR/CCPA consent-notice
// interstitial ("we and our partners use cookies..."). A browser that
// already has a consent cookie set (e.g. because a person clicked through
// it once) sails past this and lands on the real page - which is exactly
// why clicking the same link in the app shows the real article while our
// server-side fetch, with no cookie jar, gets stuck on the notice. Checked
// against the *final* URL (post-redirect, since we `redirect: 'follow'`).
const CONSENT_WALL_HOSTS = ['consent.yahoo.com', 'guce.yahoo.com', 'guce.advertising.com'];

// Backstop for the same problem on a host not in the list above (Yahoo's
// consent domains have changed before, and other publishers run their own
// cookie walls): if the "scraped" text reads like the actual IAB/Yahoo
// consent-notice boilerplate rather than a news article, treat it the same
// as a failed scrape. Deliberately narrow, specific phrasing from that
// boilerplate itself - NOT generic terms like "cookie policy" or "privacy
// policy", which show up in the footer of nearly every news site (including
// real articles) and would make this fire on legitimate content. Still
// requires a short body too, since a real article that happens to quote
// one of these phrases (unlikely, but not impossible) shouldn't be
// discarded just for that.
const CONSENT_TEXT_SIGNALS = [
  'we and our partners',
  'store and/or access information on a device',
  'yahoo family of brands',
  'collectconsent',
];
const CONSENT_TEXT_MAX_CHARS = 1500;

function looksLikeConsentPage(text: string): boolean {
  if (text.length > CONSENT_TEXT_MAX_CHARS) return false;
  const lower = text.toLowerCase();
  return CONSENT_TEXT_SIGNALS.some((phrase) => lower.includes(phrase));
}

/**
 * Best-effort fetch of an article URL's visible text - strips `<script>`/
 * `<style>` blocks and all remaining tags, collapses whitespace, and caps
 * the result so one long article can't blow out the prompt. Returns `null`
 * (never throws, and is treated by the caller exactly like "couldn't
 * scrape this one" - see `GeminiSummaryProvider.summarize`'s fallback to
 * the cached headline+snippet) on any failure: a timeout, a non-HTML
 * response, a 403 from a paywall/bot-check, a network error, or landing on
 * a cookie-consent interstitial instead of the real page (see
 * `CONSENT_WALL_HOSTS`/`looksLikeConsentPage` above).
 */
async function scrapeArticleText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // A plain server-side fetch with no UA gets blocked by some sites
        // more aggressively than a browser-like one would.
        'User-Agent': 'Mozilla/5.0 (compatible; InvestmentDashboardBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('html')) return null;

    try {
      const finalHost = new URL(res.url).hostname;
      if (CONSENT_WALL_HOSTS.includes(finalHost)) {
        console.warn(`[summaries] ${url} redirected to a consent page (${finalHost}) - skipping, will fall back to the cached headline/snippet`);
        return null;
      }
    } catch {
      // res.url failed to parse - fall through and let the content-based check below catch it instead.
    }

    // Read with a byte cap rather than res.text() unbounded - a body over
    // the cap is truncated, not rejected, since we only need the opening
    // portion of an article anyway.
    const reader = res.body?.getReader();
    if (!reader) return null;
    let received = 0;
    const chunks: Uint8Array[] = [];
    while (received < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
      }
    }
    await reader.cancel().catch(() => {});
    const html = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');

    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#?\w+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) return null;
    if (looksLikeConsentPage(text)) {
      console.warn(`[summaries] ${url} looked like a cookie-consent page rather than an article - skipping, will fall back to the cached headline/snippet`);
      return null;
    }
    return text.slice(0, MAX_SCRAPED_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(symbol: string, companyName: string, articles: Array<{ headline: string; text: string }>): string {
  const name = companyName || symbol;
  const body = articles
    .map((a, i) => `Article ${i + 1} (${a.headline}):\n${a.text}`)
    .join('\n\n');
  return (
    `Summarize the following scraped web page contents about ${name} (${symbol}) for an investor. ` +
    `Focus on what's materially relevant to the company's outlook - key developments, numbers, and ` +
    `any risks or catalysts mentioned. Write 3-5 concise sentences of plain prose, no headings or bullet points.\n\n${body}`
  );
}

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
}

/**
 * Real summaries via Google's Gemini `generateContent` endpoint - see the
 * class doc comment above and service/README.md's "News summary" section
 * for the full request/response shape and how article text is gathered.
 *
 * NOT independently network-verified from within this sandbox (its egress
 * policy blocks arbitrary internet hosts, including generativelanguage.
 * googleapis.com and the news sites being scraped) - same disclosed
 * limitation as `YahooFinancePriceProvider`/`YahooFinanceNewsProvider`. The
 * request shape matches the project's reference doc and Gemini's published
 * API exactly; worth a first real run to confirm before relying on it.
 */
export class GeminiSummaryProvider implements SummaryProvider {
  constructor(
    private apiKey: string,
    private model: string
  ) {}

  async summarize(symbol: string, companyName: string, articles: ArticleForSummary[]): Promise<string> {
    const name = companyName || symbol;
    if (articles.length === 0) return NO_NEWS_TEMPLATE(name);
    if (!this.apiKey) {
      throw new Error(
        'GEMINI_API_KEY is not configured - set it in the service environment, or set SUMMARY_PROVIDER=mock for offline use (see service/README.md)'
      );
    }

    const withText = await Promise.all(
      articles.map(async (a) => {
        const scraped = a.url ? await scrapeArticleText(a.url) : null;
        const fallback = a.summary ? `${a.headline}. ${a.summary}` : a.headline;
        return { headline: a.headline, text: scraped ?? fallback };
      })
    );

    const prompt = buildPrompt(symbol, name, withText);
    const res = await fetch(`${GEMINI_ENDPOINT}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`Gemini API returned ${res.status}${errBody ? `: ${errBody.slice(0, 300)}` : ''}`);
    }

    const json = (await res.json()) as GeminiResponse;
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    if (!text.trim()) {
      throw new Error('Gemini returned an empty response');
    }
    return text.trim();
  }
}

export function getSummaryProvider(name: string, apiKey: string, model: string): SummaryProvider {
  switch (name) {
    case 'mock':
      return new MockSummaryProvider();
    case 'gemini':
    default:
      return new GeminiSummaryProvider(apiKey, model);
  }
}
