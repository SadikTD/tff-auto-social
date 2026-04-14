'use strict';

/**
 * post-social.js
 * Triggered by post-social.yml (workflow_dispatch) with an ARTICLE_ID.
 * - Reads the article from data/pending.json
 * - Posts to each enabled platform (Twitter, Facebook, Instagram, Threads)
 * - Moves the article from pending.json to posted.json
 * - Records per-platform success/failure
 */

const axios = require('axios');
const crypto = require('crypto');
const OAuth = require('oauth-1.0a');
const { Octokit } = require('@octokit/rest');

// ─── Environment ─────────────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPOSITORY = process.env.GITHUB_REPOSITORY;
const ARTICLE_ID = process.env.ARTICLE_ID;

if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !ARTICLE_ID) {
  console.error('Missing required environment variables: GITHUB_TOKEN, GITHUB_REPOSITORY, ARTICLE_ID');
  process.exit(1);
}

const [OWNER, REPO] = GITHUB_REPOSITORY.split('/');
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ─── GitHub API helpers ───────────────────────────────────────────────────────
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
      if (err.status === 409 && attempt < retries - 1) {
        console.warn(`Conflict on ${path}, re-fetching (attempt ${attempt + 1})...`);
        await new Promise(r => setTimeout(r, 1500));
        const fresh = await getFile(path);
        sha = fresh.sha;
        continue;
      }
      throw err;
    }
  }
}

// ─── Twitter / X ─────────────────────────────────────────────────────────────
const twitterOauth = OAuth({
  consumer: {
    key: process.env.TWITTER_API_KEY || '',
    secret: process.env.TWITTER_API_SECRET || '',
  },
  signature_method: 'HMAC-SHA1',
  hash_function(baseString, key) {
    return crypto.createHmac('sha1', key).update(baseString).digest('base64');
  },
});

async function postToTwitter(caption) {
  if (!process.env.TWITTER_API_KEY || !process.env.TWITTER_API_SECRET ||
      !process.env.TWITTER_ACCESS_TOKEN || !process.env.TWITTER_ACCESS_TOKEN_SECRET) {
    return { success: false, skipped: true, error: 'Twitter credentials not configured' };
  }

  // Truncate to Twitter's 280-char limit if needed
  const text = caption.length > 280 ? caption.slice(0, 277) + '...' : caption;

  const requestData = { url: 'https://api.twitter.com/2/tweets', method: 'POST' };
  const token = {
    key: process.env.TWITTER_ACCESS_TOKEN,
    secret: process.env.TWITTER_ACCESS_TOKEN_SECRET,
  };

  const authHeader = twitterOauth.toHeader(twitterOauth.authorize(requestData, token));
  try {
    const { data } = await axios.post(
      'https://api.twitter.com/2/tweets',
      { text },
      {
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        timeout: 20000,
      }
    );
    return { success: true, postId: data.data?.id, url: `https://x.com/i/web/status/${data.data?.id}` };
  } catch (err) {
    const detail = err.response?.data?.detail || err.response?.data?.title || err.message;
    return { success: false, error: detail };
  }
}

// ─── Facebook ─────────────────────────────────────────────────────────────────
async function postToFacebook(caption, articleUrl) {
  if (!process.env.FACEBOOK_PAGE_ACCESS_TOKEN || !process.env.FACEBOOK_PAGE_ID) {
    return { success: false, skipped: true, error: 'Facebook credentials not configured' };
  }

  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.FACEBOOK_PAGE_ID}/feed`,
      {
        message: caption,
        link: articleUrl,
        access_token: process.env.FACEBOOK_PAGE_ACCESS_TOKEN,
      },
      { timeout: 20000 }
    );
    return { success: true, postId: data.id };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: detail };
  }
}

// ─── Instagram ────────────────────────────────────────────────────────────────
async function postToInstagram(caption, imageUrl) {
  if (!process.env.INSTAGRAM_ACCESS_TOKEN || !process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID) {
    return { success: false, skipped: true, error: 'Instagram credentials not configured' };
  }
  if (!imageUrl) {
    return { success: false, skipped: true, error: 'No image URL available for Instagram post' };
  }

  try {
    // Step 1: Create media container
    const containerRes = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID}/media`,
      {
        image_url: imageUrl,
        caption,
        access_token: process.env.INSTAGRAM_ACCESS_TOKEN,
      },
      { timeout: 30000 }
    );

    const containerId = containerRes.data.id;
    console.log(`  Instagram container created: ${containerId}`);

    // Wait for container to be ready (Instagram requires a small delay)
    await new Promise(r => setTimeout(r, 5000));

    // Step 2: Publish the container
    const publishRes = await axios.post(
      `https://graph.facebook.com/v20.0/${process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID}/media_publish`,
      {
        creation_id: containerId,
        access_token: process.env.INSTAGRAM_ACCESS_TOKEN,
      },
      { timeout: 20000 }
    );

    return { success: true, postId: publishRes.data.id };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: detail };
  }
}

// ─── Threads ──────────────────────────────────────────────────────────────────
async function postToThreads(caption) {
  if (!process.env.THREADS_ACCESS_TOKEN || !process.env.THREADS_USER_ID) {
    return { success: false, skipped: true, error: 'Threads credentials not configured' };
  }

  // Truncate to Threads' 500-char limit if needed
  const text = caption.length > 500 ? caption.slice(0, 497) + '...' : caption;

  try {
    // Step 1: Create container
    const containerRes = await axios.post(
      `https://graph.threads.net/v1.0/${process.env.THREADS_USER_ID}/threads`,
      null,
      {
        params: {
          media_type: 'TEXT',
          text,
          access_token: process.env.THREADS_ACCESS_TOKEN,
        },
        timeout: 20000,
      }
    );

    const containerId = containerRes.data.id;

    // Brief wait before publishing
    await new Promise(r => setTimeout(r, 2000));

    // Step 2: Publish
    const publishRes = await axios.post(
      `https://graph.threads.net/v1.0/${process.env.THREADS_USER_ID}/threads_publish`,
      null,
      {
        params: {
          creation_id: containerId,
          access_token: process.env.THREADS_ACCESS_TOKEN,
        },
        timeout: 20000,
      }
    );

    return { success: true, postId: publishRes.data.id };
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    return { success: false, error: detail };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n=== TFF Auto Social — Post to Social Media ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Repo: ${OWNER}/${REPO}`);
  console.log(`Article ID: ${ARTICLE_ID}`);

  // ── Load pending.json ─────────────────────────────────────────────────────
  const pendingRes = await getFile('data/pending.json');
  const pending = pendingRes.content || [];

  const articleIndex = pending.findIndex(a => a.id === ARTICLE_ID);
  if (articleIndex === -1) {
    console.error(`\nERROR: Article "${ARTICLE_ID}" not found in pending.json`);
    console.error('It may have already been posted or discarded.');
    process.exit(1);
  }

  const article = pending[articleIndex];
  const { title, url, imageUrl, captions, platforms } = article;

  console.log(`\nArticle: "${title}"`);
  console.log(`URL: ${url}`);
  console.log(`Platforms enabled:`, platforms);

  // ── Mark as 'posting' ─────────────────────────────────────────────────────
  pending[articleIndex].status = 'posting';
  await putFile(
    'data/pending.json',
    pending,
    pendingRes.sha,
    `feat: start posting "${title}"`
  );

  // ── Post to each platform ─────────────────────────────────────────────────
  const results = {};

  if (platforms.twitter) {
    console.log('\n[Twitter] Posting...');
    results.twitter = await postToTwitter(captions.twitter || '');
    console.log(`[Twitter] ${results.twitter.success ? '✓ Posted' : `✗ ${results.twitter.error}`}`);
  }

  if (platforms.facebook) {
    console.log('\n[Facebook] Posting...');
    results.facebook = await postToFacebook(captions.facebook || '', url);
    console.log(`[Facebook] ${results.facebook.success ? '✓ Posted' : `✗ ${results.facebook.error}`}`);
  }

  if (platforms.instagram) {
    console.log('\n[Instagram] Posting...');
    results.instagram = await postToInstagram(captions.instagram || '', imageUrl);
    console.log(`[Instagram] ${results.instagram.success ? '✓ Posted' : `✗ ${results.instagram.error}`}`);
  }

  if (platforms.threads) {
    console.log('\n[Threads] Posting...');
    results.threads = await postToThreads(captions.threads || '');
    console.log(`[Threads] ${results.threads.success ? '✓ Posted' : `✗ ${results.threads.error}`}`);
  }

  // ── Determine overall status ──────────────────────────────────────────────
  const resultValues = Object.values(results);
  const anySuccess = resultValues.some(r => r.success);
  const allFailed = resultValues.length > 0 && resultValues.every(r => !r.success);

  const postedEntry = {
    ...article,
    status: allFailed ? 'failed' : 'posted',
    postedAt: new Date().toISOString(),
    postResults: results,
  };

  // ── Update pending.json (remove article) and posted.json (add article) ────
  const updatedPending = pending.filter(a => a.id !== ARTICLE_ID);

  const [freshPending, postedRes] = await Promise.all([
    getFile('data/pending.json'),
    getFile('data/posted.json'),
  ]);

  const posted = postedRes.content || [];
  const updatedPosted = [postedEntry, ...posted];

  await Promise.all([
    putFile(
      'data/pending.json',
      updatedPending,
      freshPending.sha,
      `feat: remove "${title}" from pending`
    ),
    putFile(
      'data/posted.json',
      updatedPosted,
      postedRes.sha,
      `feat: add "${title}" to post history`
    ),
  ]);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n─── Results Summary ───');
  for (const [platform, result] of Object.entries(results)) {
    if (result.skipped) {
      console.log(`  ${platform}: ⚠ Skipped — ${result.error}`);
    } else if (result.success) {
      console.log(`  ${platform}: ✓ Posted${result.postId ? ` (ID: ${result.postId})` : ''}`);
    } else {
      console.log(`  ${platform}: ✗ Failed — ${result.error}`);
    }
  }

  if (allFailed && resultValues.length > 0) {
    console.error('\nAll platforms failed. Exiting with error.');
    process.exit(1);
  }

  if (anySuccess) {
    console.log('\n✓ Successfully posted to at least one platform.');
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
