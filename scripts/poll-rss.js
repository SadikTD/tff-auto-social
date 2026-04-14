'use strict';

/**
 * poll-rss.js
 * Runs on a cron every 15 minutes via GitHub Actions.
 * - Fetches the RSS feed for thefrontfeed.com
 * - Detects new articles since the last run
 * - Generates platform-specific captions using Gemini AI (with key rotation)
 * - Adds new articles to data/pending.json
 * - If autoPost is enabled, triggers the post-social workflow immediately
 * - Also handles scheduled posts that are due
 */

const RSSParser = require('rss-parser');
const axios = require('axios');
const { Octokit } = require('@octokit/rest');

// ─── Environment ─────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) {
  console.error('Missing GITHUB_TOKEN or GITHUB_REPOSITORY environment variables.');
  process.exit(1);
}

const [OWNER, REPO] = GITHUB_REPOSITORY.split('/');

const GEMINI_KEYS = [1, 2, 3, 4, 5]
  .map(i => process.env[`GEMINI_KEY_${i}`])
  .filter(Boolean);

// ─── GitHub API helpers ───────────────────────────────────────────────────────
const octokit = new Octokit({ auth: GITHUB_TOKEN });

async function getFile(path) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner: OWNER, repo: REPO, path });
    const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf-8'));
    return { content, sha: data.sha };
  } catch (err) {
    if (err.status === 404) return { content: null, sha: null };
    throw err;
  }
}

async function putFile(path, content, sha, message, retries = 3) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2) + '\n').toString('base64');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const params = { owner: OWNER, repo: REPO, path, message, content: encoded };
      if (sha) params.sha = sha;
      const result = await octokit.rest.repos.createOrUpdateFileContents(params);
      return result.data.content.sha;
    } catch (err) {
      // 409 = conflict (SHA mismatch), re-fetch and retry
      if (err.status === 409 && attempt < retries - 1) {
        console.warn(`Conflict writing ${path}, re-fetching and retrying (attempt ${attempt + 1})...`);
        await new Promise(r => setTimeout(r, 1500));
        const fresh = await getFile(path);
        sha = fresh.sha;
        continue;
      }
      throw err;
    }
  }
}

async function triggerPostWorkflow(articleId) {
  await octokit.rest.actions.createWorkflowDispatch({
    owner: OWNER,
    repo: REPO,
    workflow_id: 'post-social.yml',
    ref: 'main',
    inputs: { article_id: articleId },
  });
  console.log(`  → Triggered post-social.yml for article: ${articleId.slice(0, 60)}...`);
}

// ─── OG tag fetcher ───────────────────────────────────────────────────────────
async function getOgTags(url) {
  try {
    const { data: html } = await axios.get(url, {
      timeout: 12000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TFFAutoSocial/1.0)' },
    });

    function extract(prop) {
      const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"'<>]+)["']`, 'i');
      const re2 = new RegExp(`<meta[^>]+content=["']([^"'<>]+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
      const m = html.match(re1) || html.match(re2);
      return m ? m[1].trim() : '';
    }

    return {
      description: extract('og:description') || extract('description'),
      image: extract('og:image'),
    };
  } catch (err) {
    console.warn(`  Could not fetch OG tags for ${url}: ${err.message}`);
    return { description: '', image: '' };
  }
}

// ─── Gemini caption generator ─────────────────────────────────────────────────
async function generateCaptions(article, keyIndex = 0) {
  if (keyIndex >= GEMINI_KEYS.length) {
    console.warn('  All Gemini API keys exhausted — using fallback captions.');
    return buildFallbackCaptions(article);
  }

  const key = GEMINI_KEYS[keyIndex];
  const prompt = buildGeminiPrompt(article);

  try {
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${key}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.7 },
      },
      { timeout: 30000 }
    );

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Empty Gemini response');

    const parsed = JSON.parse(text);
    // Validate all four platforms are present
    if (!parsed.twitter || !parsed.facebook || !parsed.instagram || !parsed.threads) {
      throw new Error('Incomplete Gemini response — missing platform captions');
    }
    return parsed;

  } catch (err) {
    if (err.response?.status === 429 || err.response?.status === 503) {
      console.warn(`  Gemini key ${keyIndex + 1} rate-limited (${err.response.status}), trying next key...`);
      await new Promise(r => setTimeout(r, 2000));
      return generateCaptions(article, keyIndex + 1);
    }
    if (err instanceof SyntaxError) {
      console.warn(`  Gemini returned invalid JSON, using fallback.`);
      return buildFallbackCaptions(article);
    }
    console.error(`  Gemini error: ${err.message}`);
    return buildFallbackCaptions(article);
  }
}

function buildGeminiPrompt(article) {
  return `You are a social media manager for "The Front Feed" (thefrontfeed.com), a news website covering politics, world news, celebrities, and viral culture.

Generate engaging, platform-optimised social media captions for this article:
Title: ${article.title}
URL: ${article.url}
Description: ${article.description || '(none provided)'}

Return ONLY a valid JSON object with exactly these four keys. No markdown fences, no explanation — raw JSON only:
{
  "twitter": "Tweet under 260 chars. Must include the article URL. Use 2-4 punchy hashtags. Conversational and urgent.",
  "facebook": "2-3 sentence engaging post. Do NOT include the URL (Facebook auto-previews it). End with 2-3 hashtags.",
  "instagram": "Engaging caption 1-3 sentences followed by two newlines then 20-25 relevant hashtags each prefixed with #. Do NOT include the URL.",
  "threads": "Conversational post under 490 chars. Must include the article URL. Use 2-3 hashtags."
}

Tone: professional but engaging, news-focused, suitable for a general news audience.`;
}

function buildFallbackCaptions(article) {
  const shortTitle = article.title.length > 200 ? article.title.slice(0, 197) + '...' : article.title;
  return {
    twitter: `${shortTitle} ${article.url} #news #breakingnews`,
    facebook: `${shortTitle}\n\nRead the full story at The Front Feed. #news #currentevents`,
    instagram: `${shortTitle}\n\n#news #breakingnews #currentevents #worldnews #headlines #politics #viral #trending #newsstory #mediawatch`,
    threads: `${shortTitle} ${article.url} #news #breakingnews`,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== TFF Auto Social — RSS Poll ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Repo: ${OWNER}/${REPO}`);
  console.log(`Gemini keys configured: ${GEMINI_KEYS.length}`);

  if (GEMINI_KEYS.length === 0) {
    console.error('\nERROR: No Gemini API keys found. Add GEMINI_KEY_1 to GitHub Secrets.');
    process.exit(1);
  }

  // ── Load data files ──────────────────────────────────────────────────────
  console.log('\nLoading data files...');
  const [configRes, pendingRes] = await Promise.all([
    getFile('data/config.json'),
    getFile('data/pending.json'),
  ]);

  const config = configRes.content || {
    autoPost: false,
    platforms: { twitter: true, facebook: true, instagram: true, threads: true },
    rssUrl: 'https://thefrontfeed.com/feed',
    lastSeenArticleGuid: '',
    lastChecked: '',
  };

  const pending = pendingRes.content || [];
  const existingGuids = new Set(pending.map(p => p.id));

  // ── Handle scheduled posts that are due ──────────────────────────────────
  const now = Date.now();
  const duePosts = pending.filter(
    p => p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt).getTime() <= now
  );

  if (duePosts.length > 0) {
    console.log(`\nFound ${duePosts.length} scheduled post(s) due for publishing.`);
    for (const post of duePosts) {
      console.log(`  Triggering scheduled post: "${post.title}"`);
      await triggerPostWorkflow(post.id);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  // ── Fetch RSS feed ───────────────────────────────────────────────────────
  console.log(`\nFetching RSS: ${config.rssUrl}`);
  const parser = new RSSParser();
  const feed = await parser.parseURL(config.rssUrl);
  console.log(`  Feed title: ${feed.title}`);
  console.log(`  Items in feed: ${feed.items.length}`);

  // ── Find new articles ────────────────────────────────────────────────────
  const lastSeenGuid = config.lastSeenArticleGuid;
  const newArticles = [];

  for (const item of feed.items) {
    const guid = item.guid || item.link;
    if (guid === lastSeenGuid) break; // Stop at last-seen article
    if (!existingGuids.has(guid)) {
      newArticles.push(item);
    }
  }

  // Process oldest-first (feed is newest-first), cap at 5 to be safe
  const toProcess = newArticles.reverse().slice(-5);
  console.log(`  New articles to process: ${toProcess.length}`);

  if (toProcess.length === 0 && duePosts.length === 0) {
    // Update lastChecked only
    config.lastChecked = new Date().toISOString();
    await putFile('data/config.json', config, configRes.sha, 'chore: update lastChecked');
    console.log('\nNo new articles. Done.');
    return;
  }

  // ── Process each new article ─────────────────────────────────────────────
  const newEntries = [];

  for (const item of toProcess) {
    const guid = item.guid || item.link;
    const url = item.link;
    const title = (item.title || '').trim();
    const publishedAt = item.pubDate
      ? new Date(item.pubDate).toISOString()
      : new Date().toISOString();

    console.log(`\nProcessing: "${title}"`);

    // Get OG tags from article page
    const { description, image } = await getOgTags(url);

    // Find image from RSS enclosure or media tags as fallback
    const rssImage = item.enclosure?.url
      || item['media:content']?.$.url
      || item['media:thumbnail']?.$.url
      || '';

    const imageUrl = image || rssImage;
    console.log(`  Image: ${imageUrl ? 'found' : 'not found'}`);

    // Generate captions via Gemini
    console.log(`  Generating captions with Gemini...`);
    const captions = await generateCaptions({ title, url, description });

    const entry = {
      id: guid,
      title,
      url,
      imageUrl,
      publishedAt,
      detectedAt: new Date().toISOString(),
      status: 'pending',
      captions,
      platforms: { ...config.platforms },
      scheduledAt: null,
      postedAt: null,
      postResults: {},
    };

    newEntries.push(entry);
    console.log(`  ✓ Added to pending queue`);
  }

  // ── Save updated pending.json ─────────────────────────────────────────────
  if (newEntries.length > 0) {
    // Prepend new entries (newest first in the queue)
    const updatedPending = [...newEntries.reverse(), ...pending];
    await putFile(
      'data/pending.json',
      updatedPending,
      pendingRes.sha,
      `feat: add ${newEntries.length} article(s) to pending queue`
    );
    console.log(`\nSaved ${newEntries.length} new article(s) to pending.json`);
  }

  // ── Update config ─────────────────────────────────────────────────────────
  if (feed.items.length > 0) {
    config.lastSeenArticleGuid = feed.items[0].guid || feed.items[0].link;
  }
  config.lastChecked = new Date().toISOString();

  const freshConfig = await getFile('data/config.json');
  await putFile('data/config.json', config, freshConfig.sha, 'chore: update RSS poll state');

  // ── Auto-post if enabled ──────────────────────────────────────────────────
  if (config.autoPost && newEntries.length > 0) {
    console.log(`\nAuto-post is ON — triggering workflows for ${newEntries.length} article(s)...`);
    for (const entry of newEntries) {
      await triggerPostWorkflow(entry.id);
      await new Promise(r => setTimeout(r, 3000)); // Small delay between triggers
    }
  } else if (!config.autoPost && newEntries.length > 0) {
    console.log(`\nAuto-post is OFF — articles are waiting in the dashboard for approval.`);
  }

  console.log('\n=== Done ===\n');
}

main().catch(err => {
  console.error('\nFATAL ERROR:', err.message || err);
  if (err.response) {
    console.error('Response status:', err.response.status);
    console.error('Response data:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
