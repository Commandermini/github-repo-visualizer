// ---------- Config ----------
const API = 'https://api.github.com';
const COLORS = {
  add: '#3FB950',
  del: '#F85149',
  amber: '#D29922',
  violet: '#A371F7',
  blue: '#58A6FF',
  muted: '#7D8590',
  faint: '#4B5563',
  grid: '#1F2733',
  text: '#E6EDF3',
  panel: '#0E131C'
};
const LIGHT_COLORS = {
  add: '#2A7440',
  del: '#B03A36',
  amber: '#8A6410',
  violet: '#6B4DC4',
  blue: '#2A64AD',
  muted: '#465160',
  faint: '#5E6978',
  grid: '#D5DAE2',
  text: '#262D38',
  panel: '#F2F4F7'
};
const DARK_LANG_PALETTE = ['#3FB950', '#58A6FF', '#D29922', '#A371F7', '#F85149', '#39C5CF', '#DB61A2', '#7D8590'];
// Muted counterparts for light mode: same hue order, lower saturation so the donut doesn't glare.
const LIGHT_LANG_PALETTE = ['#3F8F5A', '#4A82C4', '#B8892B', '#8466CC', '#C0524D', '#2F9AA3', '#C2588C', '#7A8493'];
function langPalette() { return currentTheme() === 'light' ? LIGHT_LANG_PALETTE : DARK_LANG_PALETTE; }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — cuts repeat calls against the 60/hr limit
const CACHE_PREFIX = 'rv_cache:';
const RECENT_KEY = 'rv_recent';
const RECENT_MAX = 6;
const THEME_KEY = 'rv_theme';

let commitsChart, languagesChart, sentimentChart;
let currentRepoContext = null; // { fullName, description, topics, readme, url }
let githubToken = null; // in-memory only — never persisted, never sent anywhere but api.github.com
let lastCommits = [], lastLanguages = {}, lastIssues = []; // raw datasets, kept around so charts can be redrawn on theme switch
let primaryCompareData = null;   // the currently loaded repo, packaged for compare mode
let secondaryCompareData = null; // the second repo picked in compare mode
let lastHealthResult = null;     // the most recently computed health score, for the share card

// ---------- Theme ----------
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function activeColors() {
  return currentTheme() === 'light' ? LIGHT_COLORS : COLORS;
}
function reapplyChartsForTheme() {
  if (lastCommits.length) renderCommitsChart(lastCommits);
  if (lastLanguages && Object.keys(lastLanguages).length) renderLanguages(lastLanguages);
  if (lastIssues.length) renderIssues(lastIssues);
}
function applyTheme(theme, persist) {
  if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');

  const label = document.getElementById('theme-toggle-label');
  const icon = document.querySelector('.theme-toggle-icon');
  if (label) label.textContent = theme;
  if (icon) icon.textContent = theme === 'light' ? '◑' : '◐';
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute('content', theme === 'light' ? '#E6E9EE' : '#0B0E14');

  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* ignore */ }
  }
  reapplyChartsForTheme();
}

// ---------- Response cache (localStorage, short TTL) ----------
function cacheGet(key) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return undefined;
    const { value, expires } = JSON.parse(raw);
    if (Date.now() > expires) { localStorage.removeItem(CACHE_PREFIX + key); return undefined; }
    return value;
  } catch (e) { return undefined; }
}
function cacheSet(key, value) {
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ value, expires: Date.now() + CACHE_TTL_MS }));
  } catch (e) { /* storage full or blocked — fine, just skip caching */ }
}

// ---------- Tiny sentiment lexicon (heuristic, not real NLP) ----------
const POSITIVE_WORDS = ['fix', 'fixed', 'improve', 'improved', 'improvement', 'add', 'added', 'feature',
  'support', 'thanks', 'thank', 'great', 'awesome', 'nice', 'good', 'love', 'clean', 'faster', 'optimize',
  'update', 'upgrade', 'docs', 'documentation', 'refactor', 'simplify', 'enhance'];
const NEGATIVE_WORDS = ['bug', 'broken', 'crash', 'crashes', 'fail', 'failing', 'failed', 'error', 'errors',
  'issue', 'problem', 'wrong', 'bad', 'slow', 'regression', 'leak', 'deprecated', 'breaking', 'hang', 'freeze',
  'incorrect', 'missing', 'vulnerable', 'vulnerability', 'security', 'exception'];

function scoreSentiment(text) {
  const words = text.toLowerCase().split(/[^a-z]+/);
  let score = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.includes(w)) score++;
    if (NEGATIVE_WORDS.includes(w)) score--;
  }
  if (score > 0) return 'positive';
  if (score < 0) return 'negative';
  return 'neutral';
}

// ---------- Helpers ----------
function parseRepoInput(raw) {
  let v = raw.trim();
  v = v.replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '').replace(/\/$/, '');
  const parts = v.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

function updateRateStatus(headers) {
  const el = document.getElementById('rate-status');
  if (!el || !headers) return;
  const remaining = headers.get('x-ratelimit-remaining');
  const limit = headers.get('x-ratelimit-limit');
  if (remaining === null || limit === null) return;
  el.textContent = `${remaining}/${limit} GitHub API requests left this hour${githubToken ? ' (authenticated)' : ''}`;
  el.className = 'rate-status' + (githubToken ? ' token-active' : '');
}

async function ghFetch(path, acceptHeader) {
  const cacheKey = `${path}::${acceptHeader || 'json'}::${githubToken ? 'auth' : 'anon'}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) return cached;

  const headers = { Accept: acceptHeader || 'application/vnd.github+json' };
  if (githubToken) headers.Authorization = `Bearer ${githubToken}`;

  const res = await fetch(`${API}${path}`, { headers });
  updateRateStatus(res.headers);

  if (!res.ok) {
    if (res.status === 401 && githubToken) {
      githubToken = null;
      updateTokenUI();
      throw new Error('That GitHub token was rejected (expired or invalid) — cleared it. Try again, or add a fresh one.');
    }
    if (res.status === 403 || res.status === 429) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        const reset = res.headers.get('x-ratelimit-reset');
        const resetDate = reset ? new Date(parseInt(reset, 10) * 1000) : null;
        const hint = githubToken ? '' : ' Add a GitHub token above to raise the limit to 5,000/hr.';
        throw new Error(`GitHub API rate limit hit. Resets at ${resetDate ? resetDate.toLocaleTimeString() : 'the top of the hour'}.${hint}`);
      }
    }
    if (res.status === 404) throw new Error('Repo not found. Check the owner/repo spelling and that it is public.');
    throw new Error(`GitHub API returned ${res.status} for ${path}`);
  }
  const data = (acceptHeader && acceptHeader.includes('raw')) ? await res.text() : await res.json();
  cacheSet(cacheKey, data);
  return data;
}

async function fetchReadme(owner, repo) {
  try {
    const text = await ghFetch(`/repos/${owner}/${repo}/readme`, 'application/vnd.github.raw');
    return text.slice(0, 6000); // keep the prompt small and cheap
  } catch (e) {
    return null;
  }
}

function setStatus(msg, state) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status' + (state ? ` ${state}` : '');
}

function showError(msg) {
  const panel = document.getElementById('error-panel');
  panel.innerHTML = `<div class="error-box">${escapeHTML(msg)}</div>`;
  panel.classList.remove('hidden');
}

function clearError() {
  const panel = document.getElementById('error-panel');
  panel.classList.add('hidden');
  panel.innerHTML = '';
}

function escapeHTML(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function hideResultSections() {
  ['repo-meta', 'health', 'commits', 'contributors', 'languages', 'issues', 'ai-summary'].forEach(id => {
    document.getElementById(id).classList.add('hidden');
  });
}

function resetAiSummarySection() {
  const output = document.getElementById('ai-output');
  aiTypeToken++; // cancel any in-flight typing animation from a previous repo
  output.className = 'ai-output';
  output.textContent = '';
  document.getElementById('ai-summary').classList.remove('hidden');
}

// ---------- Recent searches ----------
function getRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch (e) { return []; }
}
function addToRecent(fullName) {
  let list = getRecent().filter(r => r.toLowerCase() !== fullName.toLowerCase());
  list.unshift(fullName);
  list = list.slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
  renderRecentChips();
}
function renderRecentChips() {
  const list = getRecent();
  const wrap = document.getElementById('recent-hint');
  if (!list.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
  wrap.innerHTML = 'recent: ' + list.map(name =>
    `<button type="button" class="chip" data-repo="${escapeHTML(name)}">${escapeHTML(name)}</button>`
  ).join('');
  wrap.classList.remove('hidden');
  wrap.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.getElementById('repo-input').value = chip.dataset.repo;
      document.getElementById('repo-form').dispatchEvent(new Event('submit', { cancelable: true }));
    });
  });
}

// ---------- Shareable URL ----------
function updateUrlForRepo(owner, repo) {
  const url = new URL(window.location.href);
  url.searchParams.set('repo', `${owner}/${repo}`);
  window.history.replaceState(null, '', url.toString());
}
function getRepoFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('repo');
}
async function copyShareLink() {
  const btn = document.getElementById('share-btn');
  try {
    await navigator.clipboard.writeText(window.location.href);
    const original = btn.textContent;
    btn.textContent = 'copied!';
    setTimeout(() => { btn.textContent = original; }, 1500);
  } catch (e) {
    showError('Could not copy the link — copy it from the address bar instead.');
  }
}

// ---------- Renderers ----------
function renderRepoMeta(data) {
  const el = document.getElementById('repo-meta');
  const created = new Date(data.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  el.innerHTML = `
    <div class="repo-meta-inner">
      <div class="repo-meta-top">
        <h2 class="repo-meta-name"><a href="${data.html_url}" target="_blank" rel="noopener">${escapeHTML(data.full_name)}</a></h2>
        <button type="button" id="share-btn" class="share-btn">copy link</button>
      </div>
      <p class="repo-meta-desc">${data.description ? escapeHTML(data.description) : 'No description provided.'}</p>
      <div class="repo-stats">
        <span class="repo-stat"><b>${data.stargazers_count.toLocaleString()}</b> stars</span>
        <span class="repo-stat"><b>${data.forks_count.toLocaleString()}</b> forks</span>
        <span class="repo-stat"><b>${data.open_issues_count.toLocaleString()}</b> open issues</span>
        <span class="repo-stat"><b>${data.default_branch}</b> default branch</span>
        <span class="repo-stat">created <b>${created}</b></span>
        <span class="repo-stat">license <b>${data.license ? escapeHTML(data.license.spdx_id) : 'none'}</b></span>
      </div>
    </div>`;
  el.classList.remove('hidden');
  document.getElementById('share-btn').addEventListener('click', copyShareLink);
}

function bucketCommitsByWeek(commits) {
  const buckets = new Map();
  for (const c of commits) {
    const dateStr = c.commit && c.commit.author ? c.commit.author.date : null;
    if (!dateStr) continue;
    const d = new Date(dateStr);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  const sortedKeys = Array.from(buckets.keys()).sort();
  return { labels: sortedKeys, values: sortedKeys.map(k => buckets.get(k)) };
}

function bucketCommitsByDay(commits) {
  const counts = new Map();
  for (const c of commits) {
    const dateStr = c.commit && c.commit.author ? c.commit.author.date : null;
    if (!dateStr) continue;
    const key = dateStr.slice(0, 10); // YYYY-MM-DD
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function renderCommitHeatmap(commits) {
  const container = document.getElementById('commit-heatmap');
  const counts = bucketCommitsByDay(commits);
  if (!counts.size) { container.innerHTML = ''; return; }

  const dates = Array.from(counts.keys()).sort();
  const latest = new Date(dates[dates.length - 1] + 'T00:00:00Z');
  const earliestAvailable = new Date(dates[0] + 'T00:00:00Z');
  // Show at most the last 91 days so the grid stays readable even for very active repos
  const spanDays = Math.min(91, Math.round((latest - earliestAvailable) / 86400000) + 1);
  const gridStart = new Date(latest);
  gridStart.setUTCDate(gridStart.getUTCDate() - spanDays + 1);
  gridStart.setUTCDate(gridStart.getUTCDate() - gridStart.getUTCDay()); // back up to a Sunday

  const max = Math.max(...counts.values(), 1);
  const cells = [];
  const cursor = new Date(gridStart);
  while (cursor <= latest) {
    const key = cursor.toISOString().slice(0, 10);
    const count = counts.get(key) || 0;
    const level = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
    cells.push({ key, count, level });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  container.innerHTML = cells.map(c =>
    `<span class="heatmap-cell" data-level="${c.level}" title="${c.key}: ${c.count} commit${c.count === 1 ? '' : 's'}"></span>`
  ).join('');
  container.style.gridTemplateColumns = `repeat(${Math.ceil(cells.length / 7)}, 1fr)`;
}

function renderCommitsChart(commits) {
  const c = activeColors();
  const { labels, values } = bucketCommitsByWeek(commits);
  const ctx = document.getElementById('commits-chart').getContext('2d');
  if (commitsChart) commitsChart.destroy();
  commitsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map(l => new Date(l).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
      datasets: [{
        label: 'Commits',
        data: values,
        backgroundColor: c.add,
        borderRadius: 3,
        maxBarThickness: 18
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: c.muted, maxRotation: 0, autoSkip: true, font: { family: 'JetBrains Mono', size: 10 } } },
        y: { grid: { color: c.grid }, ticks: { color: c.muted, precision: 0, font: { family: 'JetBrains Mono', size: 10 } } }
      }
    }
  });
  document.getElementById('commits').classList.remove('hidden');
  renderCommitHeatmap(commits);
}

function renderContributors(list) {
  const container = document.getElementById('contributors-list');
  if (!list.length) {
    container.innerHTML = '<p style="color:var(--text-muted)">No contributor data available for this repo.</p>';
  } else {
    const max = list[0].contributions || 1;
    container.innerHTML = list.map(c => `
      <div class="contributor-row">
        <img src="${c.avatar_url}&s=68" alt="" loading="lazy">
        <span class="contributor-name"><a href="${c.html_url}" target="_blank" rel="noopener">${escapeHTML(c.login)}</a></span>
        <span class="contributor-bar-track"><span class="contributor-bar-fill" style="width:${(c.contributions / max) * 100}%"></span></span>
        <span class="contributor-count">${c.contributions.toLocaleString()}</span>
      </div>
    `).join('');
  }
  document.getElementById('contributors').classList.remove('hidden');
}

function renderLanguages(langBytes) {
  const c = activeColors();
  const entries = Object.entries(langBytes).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, v]) => sum + v, 0) || 1;
  const ctx = document.getElementById('languages-chart').getContext('2d');
  if (languagesChart) languagesChart.destroy();

  if (!entries.length) {
    document.getElementById('languages-list').innerHTML = '<li>No language data reported.</li>';
    document.getElementById('languages').classList.remove('hidden');
    return;
  }

  languagesChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: entries.map(([name]) => name),
      datasets: [{ data: entries.map(([, v]) => v), backgroundColor: langPalette(), borderColor: c.panel, borderWidth: 2 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '62%',
      plugins: { legend: { display: false } }
    }
  });

  const list = document.getElementById('languages-list');
  list.innerHTML = entries.map(([name, bytes], i) => `
    <li>
      <span class="lang-swatch" style="background:${langPalette()[i % langPalette().length]}"></span>
      <span class="lang-name">${escapeHTML(name)}</span>
      <span class="lang-pct">${((bytes / total) * 100).toFixed(1)}%</span>
    </li>
  `).join('');
  document.getElementById('languages').classList.remove('hidden');
}

function renderIssues(issues) {
  const c = activeColors();
  const realIssues = issues.filter(i => !i.pull_request);
  const open = realIssues.filter(i => i.state === 'open').length;
  const closed = realIssues.filter(i => i.state === 'closed').length;

  document.getElementById('diff-counts').innerHTML = `
    <div class="diff-count open">${open}<span class="diff-count-label">open</span></div>
    <div class="diff-count closed">${closed}<span class="diff-count-label">closed (in this sample)</span></div>
  `;

  const counts = { positive: 0, neutral: 0, negative: 0 };
  for (const issue of realIssues) {
    counts[scoreSentiment(issue.title || '')]++;
  }

  const ctx = document.getElementById('sentiment-chart').getContext('2d');
  if (sentimentChart) sentimentChart.destroy();
  sentimentChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: ['positive', 'neutral', 'negative'],
      datasets: [{
        data: [counts.positive, counts.neutral, counts.negative],
        backgroundColor: [c.add, c.faint, c.del],
        borderRadius: 4,
        maxBarThickness: 40
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: c.grid }, ticks: { color: c.muted, precision: 0, font: { family: 'JetBrains Mono', size: 10 } } },
        y: { grid: { display: false }, ticks: { color: c.muted, font: { family: 'JetBrains Mono', size: 11 } } }
      }
    }
  });
  document.getElementById('issues').classList.remove('hidden');
}

// ---------- Health score ----------
// A transparent, heuristic 0-100 score built entirely from data already on screen.
// Not a real quality metric — just a quick, honest way to read four signals at once.
function computeHealthScore({ commits, contributors, issues, repoData, readme }) {
  const breakdown = [];

  // 1. Activity — how recently was the last commit on the default branch?
  let activityScore = 8;
  let activityNote = 'No commit history available.';
  if (commits.length) {
    const latestDateStr = commits[0].commit && commits[0].commit.author ? commits[0].commit.author.date : null;
    if (latestDateStr) {
      const days = Math.floor((Date.now() - new Date(latestDateStr).getTime()) / 86400000);
      if (days <= 7) { activityScore = 25; activityNote = `Last commit ${days === 0 ? 'today' : days + 'd ago'}.`; }
      else if (days <= 30) { activityScore = 20; activityNote = `Last commit ${days}d ago.`; }
      else if (days <= 90) { activityScore = 14; activityNote = `Last commit ${days}d ago.`; }
      else if (days <= 365) { activityScore = 8; activityNote = `Last commit ~${Math.round(days / 30)} months ago.`; }
      else { activityScore = 3; activityNote = `Last commit over a year ago.`; }
    }
  }
  breakdown.push({ label: 'activity', score: activityScore, max: 25, note: activityNote });

  // 2. Bus factor — how concentrated is the work among the top (sampled) contributors?
  let busScore = 12;
  let busNote = 'No contributor data available.';
  if (contributors.length) {
    const total = contributors.reduce((s, c) => s + (c.contributions || 0), 0) || 1;
    const topShare = (contributors[0].contributions || 0) / total;
    const pct = Math.round(topShare * 100);
    if (topShare < 0.3) { busScore = 25; busNote = `Top contributor holds ${pct}% of sampled commits — well distributed.`; }
    else if (topShare < 0.5) { busScore = 18; busNote = `Top contributor holds ${pct}% of sampled commits.`; }
    else if (topShare < 0.75) { busScore = 10; busNote = `Top contributor holds ${pct}% of sampled commits — fairly concentrated.`; }
    else { busScore = 4; busNote = `Top contributor holds ${pct}% of sampled commits — single-maintainer risk.`; }
  }
  breakdown.push({ label: 'bus factor', score: busScore, max: 25, note: busNote });

  // 3. Issue resolution — of the sampled issues, how many actually get closed?
  let issueScore = 15;
  let issueNote = 'No sampled issues to judge from.';
  const realIssues = issues.filter(i => !i.pull_request);
  if (realIssues.length) {
    const closed = realIssues.filter(i => i.state === 'closed').length;
    const ratio = closed / realIssues.length;
    const pct = Math.round(ratio * 100);
    if (ratio > 0.8) { issueScore = 25; issueNote = `${pct}% of sampled issues closed.`; }
    else if (ratio > 0.6) { issueScore = 19; issueNote = `${pct}% of sampled issues closed.`; }
    else if (ratio > 0.4) { issueScore = 12; issueNote = `${pct}% of sampled issues closed.`; }
    else { issueScore = 6; issueNote = `${pct}% of sampled issues closed — backlog is piling up.`; }
  }
  breakdown.push({ label: 'issue resolution', score: issueScore, max: 25, note: issueNote });

  // 4. Documentation — README, description, topics
  let docScore = 0;
  const docParts = [];
  if (readme) { docScore += 15; docParts.push('a README'); }
  if (repoData.description) { docScore += 5; docParts.push('a description'); }
  if (repoData.topics && repoData.topics.length) { docScore += 5; docParts.push('topics'); }
  const docNote = docParts.length ? `Has ${docParts.join(', ')}.` : 'No README, description, or topics found.';
  breakdown.push({ label: 'documentation', score: docScore, max: 25, note: docNote });

  const total = breakdown.reduce((s, b) => s + b.score, 0);
  return { total, breakdown };
}

// Pulls the same derived facts (languages, activity, license, issue counts...)
// out of raw API data — used for the AI briefing, the health score context, and
// compare mode, so all three stay consistent instead of drifting apart.
function deriveRepoFacts(repoData, commits, contributors, languages, issues) {
  const languageEntries = Object.entries(languages).sort((a, b) => b[1] - a[1]);
  const languageTotal = languageEntries.reduce((s, [, v]) => s + v, 0) || 1;
  const languageBreakdown = languageEntries.slice(0, 3)
    .map(([name, bytes]) => `${name} ${Math.round((bytes / languageTotal) * 100)}%`)
    .join(', ');
  const topLanguage = languageEntries.length ? languageEntries[0][0] : null;

  let lastCommitAgo = null;
  if (commits.length) {
    const d = commits[0].commit && commits[0].commit.author ? commits[0].commit.author.date : null;
    if (d) {
      const days = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
      lastCommitAgo = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
    }
  }

  const realIssues = issues.filter(i => !i.pull_request);
  const openIssueCount = realIssues.filter(i => i.state === 'open').length;
  const closedIssueCount = realIssues.filter(i => i.state === 'closed').length;

  return {
    languageBreakdown,
    topLanguage,
    stars: repoData.stargazers_count,
    forks: repoData.forks_count,
    watchers: repoData.subscribers_count,
    contributorCount: contributors.length,
    lastCommitAgo,
    license: repoData.license ? (repoData.license.spdx_id || repoData.license.name) : null,
    isFork: !!repoData.fork,
    parentFullName: repoData.parent ? repoData.parent.full_name : null,
    createdYear: repoData.created_at ? new Date(repoData.created_at).getFullYear() : null,
    archived: !!repoData.archived,
    openIssueCount,
    closedIssueCount
  };
}

// A heuristic percentile framing — NOT measured against a live sample of
// GitHub repos, just an illustrative read of where a score sits on the same
// 0-100 scale the breakdown above uses. Always disclosed as an estimate.
function estimateHealthPercentile(total) {
  if (total >= 90) return 95;
  if (total >= 80) return 85;
  if (total >= 70) return 72;
  if (total >= 60) return 58;
  if (total >= 50) return 45;
  if (total >= 40) return 30;
  if (total >= 30) return 18;
  return 8;
}

function healthGradeInfo(total) {
  if (total >= 85) return { grade: 'excellent', color: 'var(--add)' };
  if (total >= 65) return { grade: 'good', color: 'var(--blue)' };
  if (total >= 45) return { grade: 'fair', color: 'var(--amber)' };
  return { grade: 'weak', color: 'var(--del)' };
}

function renderHealthScore(result) {
  const { total, breakdown } = result;
  const { grade, color } = healthGradeInfo(total);

  const valueEl = document.getElementById('health-score-value');
  valueEl.textContent = total;
  valueEl.style.color = color;
  const gradeEl = document.getElementById('health-grade');
  gradeEl.textContent = grade;
  gradeEl.style.color = color;

  const percentileEl = document.getElementById('health-percentile');
  if (percentileEl) {
    const pct = estimateHealthPercentile(total);
    percentileEl.innerHTML = `Estimated to outperform roughly <b>${pct}%</b> of repos on this scoring scale <span class="health-percentile-note">(a heuristic estimate based on the bands above, not measured against a live GitHub sample)</span>`;
  }

  document.getElementById('health-breakdown').innerHTML = breakdown.map(b => `
    <div class="health-row">
      <div class="health-row-top">
        <span class="health-label">${escapeHTML(b.label)}</span>
        <span class="health-points">${b.score}/${b.max}</span>
      </div>
      <div class="health-bar-track"><div class="health-bar-fill" style="width:${(b.score / b.max) * 100}%"></div></div>
      <p class="health-note">${escapeHTML(b.note)}</p>
    </div>
  `).join('');

  document.getElementById('health').classList.remove('hidden');
}

// ---------- Orchestration ----------
async function loadRepo(owner, repo) {
  clearError();
  hideResultSections();
  resetCompareSection();
  const runBtn = document.getElementById('run-btn');
  runBtn.disabled = true;

  try {
    setStatus(`fetching ${owner}/${repo}...`, 'loading');
    const repoData = await ghFetch(`/repos/${owner}/${repo}`);
    renderRepoMeta(repoData);

    const readme = await fetchReadme(owner, repo);
    currentRepoContext = {
      fullName: repoData.full_name,
      description: repoData.description,
      topics: repoData.topics || [],
      homepage: repoData.homepage,
      readme,
      url: repoData.html_url,
      avatarUrl: repoData.owner ? repoData.owner.avatar_url : null,
      ownerLogin: repoData.owner ? repoData.owner.login : null
    };
    resetAiSummarySection();

    setStatus('reading commit history...', 'loading');
    let commits = [];
    try {
      const page1 = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=100&page=1`);
      commits = commits.concat(page1);
      if (page1.length === 100) {
        const page2 = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=100&page=2`);
        commits = commits.concat(page2);
      }
    } catch (e) {
      console.warn('Commit history unavailable:', e.message);
    }
    if (commits.length) renderCommitsChart(commits);

    setStatus('ranking contributors...', 'loading');
    let contributors = [];
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/contributors?per_page=10`);
      contributors = Array.isArray(fetched) ? fetched : [];
      renderContributors(contributors);
    } catch (e) {
      console.warn('Contributors unavailable:', e.message);
      renderContributors([]);
    }

    setStatus('measuring languages...', 'loading');
    let languages = {};
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/languages`);
      languages = fetched && typeof fetched === 'object' ? fetched : {};
      renderLanguages(languages);
    } catch (e) {
      console.warn('Languages unavailable:', e.message);
      renderLanguages({});
    }

    setStatus('scanning issue titles...', 'loading');
    let issues = [];
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/issues?state=all&per_page=100`);
      issues = Array.isArray(fetched) ? fetched : [];
      renderIssues(issues);
    } catch (e) {
      console.warn('Issues unavailable:', e.message);
      renderIssues([]);
    }

    setStatus('mapping the file tree...', 'loading');
    let topDirs = [];
    try {
      const contents = await ghFetch(`/repos/${owner}/${repo}/contents`);
      if (Array.isArray(contents)) {
        topDirs = contents.filter(item => item.type === 'dir').map(item => item.name).slice(0, 12);
      }
    } catch (e) {
      console.warn('Repo contents unavailable:', e.message);
    }

    // Fold everything we now know into the AI's briefing, not just the README.
    const facts = deriveRepoFacts(repoData, commits, contributors, languages, issues);
    currentRepoContext = { ...currentRepoContext, ...facts, topDirs };

    const health = computeHealthScore({ commits, contributors, issues, repoData, readme });
    renderHealthScore(health);
    lastHealthResult = health;

    // Keep raw data + a compare-ready bundle around for theme redraws and compare mode.
    lastCommits = commits;
    lastLanguages = languages;
    lastIssues = issues;
    primaryCompareData = { owner, repo, fullName: repoData.full_name, avatarUrl: repoData.owner ? repoData.owner.avatar_url : null, health, ...facts };
    document.getElementById('compare-toggle').classList.remove('hidden');

    setStatus(`done — ${owner}/${repo}`, 'done');
    addToRecent(repoData.full_name);
    updateUrlForRepo(owner, repo);
  } catch (err) {
    setStatus('', '');
    showError(err.message || 'Something went wrong talking to the GitHub API.');
  } finally {
    runBtn.disabled = false;
  }
}

// ---------- AI summary (runs fully in-browser via transformers.js, no key, no server) ----------
// Inference happens in a Web Worker so the page never freezes, and the model is
// an instruction-following one (not a pure text-compressor) so it's briefed on
// languages, activity, structure, and stars — not just handed the README to paraphrase.
const SUMMARY_MODEL = 'Xenova/LaMini-Flan-T5-248M';

function stripMarkdown(md) {
  return md
    .replace(/```[\s\S]*?```/g, ' ')          // code blocks
    .replace(/<!--[\s\S]*?-->/g, ' ')          // html comments
    .replace(/<[^>]+>/g, ' ')                  // raw html tags (picture/source/img/div/br, etc.)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')     // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // links -> text
    .replace(/^#{1,6}\s*/gm, '')               // headers
    .replace(/[*_>`~]/g, ' ')                  // emphasis/quote chars
    .replace(/&\w+;/g, ' ')                    // html entities (&nbsp; etc.)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// A shared list of plain-English facts pulled from everything loadRepo gathered —
// used both by the AI prompt and by the extractive fallback, so neither one is
// stuck with just "description + README opening" when a repo has neither.
function buildFactList(ctx) {
  const facts = [];
  if (ctx.languageBreakdown) facts.push(`written primarily in ${ctx.languageBreakdown}`);
  if (typeof ctx.stars === 'number') facts.push(`${ctx.stars.toLocaleString()} stars${ctx.forks ? ` and ${ctx.forks.toLocaleString()} forks` : ''}`);
  if (ctx.contributorCount) facts.push(`${ctx.contributorCount}+ visible contributors`);
  if (ctx.lastCommitAgo) facts.push(`last commit ${ctx.lastCommitAgo}`);
  if (ctx.topics && ctx.topics.length) facts.push(`tagged with ${ctx.topics.slice(0, 5).join(', ')}`);
  if (ctx.topDirs && ctx.topDirs.length) facts.push(`top-level folders include ${ctx.topDirs.slice(0, 6).join(', ')}`);
  if (ctx.isFork && ctx.parentFullName) facts.push(`a fork of ${ctx.parentFullName}`);
  if (ctx.license) facts.push(`${ctx.license}-licensed`);
  if (ctx.archived) facts.push('archived (read-only)');
  if (ctx.createdYear) facts.push(`created in ${ctx.createdYear}`);
  if ((ctx.openIssueCount || 0) + (ctx.closedIssueCount || 0) > 0) {
    facts.push(`${ctx.openIssueCount} open / ${ctx.closedIssueCount} closed issues sampled`);
  }
  return facts;
}

// Builds a short "briefing" out of everything loadRepo gathered, plus a trimmed
// README excerpt, and turns it into an instruction the model has to actually
// reason over — not just compress. When the README/description are thin or
// missing, it explicitly tells the model to lean on the structured facts instead.
function buildSummaryPrompt(ctx) {
  const facts = buildFactList(ctx);
  const cleanedReadme = ctx.readme ? stripMarkdown(ctx.readme).slice(0, 2200) : '';
  if (!facts.length && !ctx.description && !cleanedReadme) return '';

  const readmeIsThin = cleanedReadme.length < 80;
  const guidance = readmeIsThin
    ? 'There is little or no README/description here, so lean primarily on the facts below to describe what kind of project this looks like — its scale, language, age, and activity — rather than inventing details that aren\'t there.'
    : 'Use the facts and README below as context.';

  return [
    `Write a summary of the GitHub repository "${ctx.fullName || 'this repo'}" for someone who has never seen it. Explain what it does (or what kind of project it appears to be, if the description is missing), who it might be for, and one thing that stands out. ${guidance} Do not just list the facts back — synthesize them into a real summary in your own words.`,
    'Formatting: if there are several distinct standout facts and little narrative to work with, write 3-5 short bullet points, one per line, each starting with "-". If there is a real description or README to draw on, write 3-4 sentences of flowing prose instead. Pick whichever fits better — do not do both.',
    '',
    `Description: ${ctx.description || '(none provided)'}`,
    '',
    'Facts:',
    facts.length ? facts.map(f => `- ${f}`).join('\n') : '- (no additional metadata available)',
    '',
    'README excerpt:',
    cleanedReadme || '(no README available)'
  ].join('\n');
}

function renderFallbackSummary(ctx, reason) {
  const output = document.getElementById('ai-output');
  const cleaned = ctx.readme ? stripMarkdown(ctx.readme) : '';
  const firstParagraph = cleaned.split('\n').map(l => l.trim()).find(l => l.length > 40) || '';
  const facts = buildFactList(ctx);

  const introSentences = [];
  if (ctx.description) introSentences.push(ctx.description.trim());
  if (firstParagraph && firstParagraph !== ctx.description) introSentences.push(firstParagraph);

  // If description + README gave us barely anything, present the facts as a
  // scannable list instead of forcing them into an empty-feeling paragraph.
  const hasSubstance = introSentences.join(' ').length > 60;
  const blocks = [];
  if (hasSubstance) {
    blocks.push({ type: 'p', text: introSentences.join(' ') });
    if (facts.length) blocks.push({ type: 'ul', items: capitalizeFacts(facts) });
  } else if (facts.length) {
    blocks.push({ type: 'p', text: `${ctx.fullName || 'This repo'}, at a glance:` });
    blocks.push({ type: 'ul', items: capitalizeFacts(facts) });
  } else {
    blocks.push({ type: 'p', text: 'No description, README, or repo metadata was available to summarize.' });
  }

  output.className = 'ai-output';
  output.innerHTML = '';
  const reasonText = reason ? ` (${reason})` : '';
  typeBlocks(output, blocks, () => {
    const note = document.createElement('p');
    note.className = 'ai-fallback-note';
    output.appendChild(note);
  });
}

function capitalizeFacts(facts) {
  return facts.map(f => f.charAt(0).toUpperCase() + f.slice(1));
}

// Turns the model's raw text into typed blocks — a bullet list if most lines
// look like bullets/numbered items, otherwise one or more prose paragraphs.
function formatAiText(raw) {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const bulletLines = lines.filter(l => /^[-*•]\s+/.test(l) || /^\d+[.)]\s+/.test(l));
  if (lines.length > 1 && bulletLines.length >= Math.max(2, Math.ceil(lines.length * 0.6))) {
    const items = lines.map(l => l.replace(/^[-*•]\s+/, '').replace(/^\d+[.)]\s+/, '').trim()).filter(Boolean);
    return [{ type: 'ul', items }];
  }
  const paragraphs = raw.split(/\n{2,}/).map(p => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragraphs.length > 1) return paragraphs.map(p => ({ type: 'p', text: p }));
  return [{ type: 'p', text: raw.replace(/\s+/g, ' ').trim() }];
}

function renderAiOutput(text) {
  const output = document.getElementById('ai-output');
  output.className = 'ai-output';
  output.innerHTML = '';
  typeBlocks(output, formatAiText(text));
}

// ---------- Typewriter renderer ----------
// Types text into paragraphs/list items one character-batch at a time. Uses
// textContent throughout, so it's XSS-safe without any manual escaping.
// A monotonically increasing token cancels any in-flight animation when a new
// one starts (new repo loaded, or "generate" clicked again), and clicking the
// output area fast-forwards the current animation to completion.
let aiTypeToken = 0;
let aiSkipHandler = null;
const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function typeBlocks(container, blocks, onComplete) {
  const token = ++aiTypeToken;
  let skip = prefersReducedMotion;

  if (aiSkipHandler) container.removeEventListener('click', aiSkipHandler);
  aiSkipHandler = () => { skip = true; };
  container.addEventListener('click', aiSkipHandler);

  const isStale = () => token !== aiTypeToken;

  function typeText(el, text, cb) {
    let i = 0;
    (function tick() {
      if (isStale()) return;
      if (skip) { el.textContent = text; cb(); return; }
      i = Math.min(text.length, i + 2);
      el.textContent = text.slice(0, i);
      if (i < text.length) {
        const cursor = document.createElement('span');
        cursor.className = 'ai-cursor';
        el.appendChild(cursor);
        setTimeout(tick, 12);
      } else {
        cb();
      }
    })();
  }

  function typeListItems(ul, items, idx, cb) {
    if (isStale()) return;
    if (idx >= items.length) { cb(); return; }
    const li = document.createElement('li');
    ul.appendChild(li);
    typeText(li, items[idx], () => typeListItems(ul, items, idx + 1, cb));
  }

  function nextBlock(idx) {
    if (isStale()) return;
    if (idx >= blocks.length) {
      container.removeEventListener('click', aiSkipHandler);
      aiSkipHandler = null;
      if (onComplete) onComplete();
      return;
    }
    const block = blocks[idx];
    if (block.type === 'ul') {
      const ul = document.createElement('ul');
      ul.className = 'ai-output-list';
      container.appendChild(ul);
      typeListItems(ul, block.items, 0, () => nextBlock(idx + 1));
    } else {
      const p = document.createElement('p');
      container.appendChild(p);
      typeText(p, block.text, () => nextBlock(idx + 1));
    }
  }

  nextBlock(0);
}

// The worker owns transformers.js entirely — model download AND inference run
// off the main thread, so the tab stays scrollable/clickable the whole time.
const AI_WORKER_SOURCE = `
let pipe = null;
self.onmessage = async (e) => {
  if (e.data.type !== 'summarize') return;
  try {
    if (!pipe) {
      const { pipeline, env } = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3');
      env.allowLocalModels = false;
      pipe = await pipeline('text2text-generation', '${SUMMARY_MODEL}', {
        dtype: 'q8',
        progress_callback: (p) => self.postMessage({ type: 'progress', payload: p })
      });
    }
    const result = await pipe(e.data.prompt, { max_new_tokens: 200, temperature: 0.3 });
    self.postMessage({ type: 'result', payload: result[0].generated_text });
  } catch (err) {
    self.postMessage({ type: 'error', payload: (err && err.message) ? err.message : String(err) });
  }
};
`;

let aiWorker = null;
function getAiWorker() {
  if (aiWorker) return aiWorker;
  const blob = new Blob([AI_WORKER_SOURCE], { type: 'text/javascript' });
  aiWorker = new Worker(URL.createObjectURL(blob), { type: 'module' });
  return aiWorker;
}

async function generateAiSummary() {
  const btn = document.getElementById('ai-generate-btn');
  const output = document.getElementById('ai-output');

  if (!currentRepoContext) {
    output.className = 'ai-output ai-error';
    output.textContent = 'Load a repo above first.';
    return;
  }

  const prompt = buildSummaryPrompt(currentRepoContext);
  if (!prompt) {
    renderFallbackSummary(currentRepoContext);
    return;
  }

  btn.disabled = true;
  output.className = 'ai-output ai-loading';
  output.textContent = 'Loading the model in the background (first run only)...';

  let worker;
  try {
    worker = getAiWorker();
  } catch (err) {
    console.error('Web Workers unavailable, falling back to extractive summary:', err);
    renderFallbackSummary(currentRepoContext, 'Web Workers unsupported in this browser');
    btn.disabled = false;
    return;
  }

  const safetyTimer = setTimeout(() => {
    cleanup();
    console.error('In-browser summarization timed out, falling back to extractive summary.');
    renderFallbackSummary(currentRepoContext, 'timed out after 2 minutes');
    // A hung worker isn't reusable — drop it so the next click starts fresh.
    worker.terminate();
    aiWorker = null;
  }, 120000);

  function cleanup() {
    clearTimeout(safetyTimer);
    worker.removeEventListener('message', handleMessage);
    worker.removeEventListener('error', handleError);
    btn.disabled = false;
  }

  function handleMessage(e) {
    const { type, payload } = e.data;
    if (type === 'progress') {
      if (payload.status === 'progress' && typeof payload.progress === 'number') {
        output.textContent = `Downloading model files... ${Math.round(payload.progress)}% (page stays usable — feel free to keep scrolling)`;
      } else if (payload.status === 'ready') {
        output.textContent = 'Model ready. Reading the whole repo...';
      }
    } else if (type === 'result') {
      renderAiOutput(payload);
      cleanup();
    } else if (type === 'error') {
      console.error('In-browser summarization failed, falling back to extractive summary:', payload);
      renderFallbackSummary(currentRepoContext, String(payload).slice(0, 120));
      cleanup();
    }
  }

  function handleError(err) {
    console.error('AI worker crashed, falling back to extractive summary:', err);
    renderFallbackSummary(currentRepoContext, 'worker crashed');
    cleanup();
    aiWorker = null;
  }

  worker.addEventListener('message', handleMessage);
  worker.addEventListener('error', handleError);
  worker.postMessage({ type: 'summarize', prompt });
}

// ---------- Scrollspy for the gutter ----------
function initScrollspy() {
  const dots = document.querySelectorAll('.gutter-dot');
  const sections = Array.from(dots).map(dot => document.getElementById(dot.dataset.target)).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const dot = document.querySelector(`.gutter-dot[data-target="${entry.target.id}"]`);
      if (!dot) return;
      if (entry.isIntersecting) dot.classList.add('active');
      else dot.classList.remove('active');
    });
  }, { rootMargin: '-40% 0px -40% 0px' });
  sections.forEach(s => observer.observe(s));
}

// ---------- GitHub token panel ----------
function updateTokenUI() {
  const toggle = document.getElementById('token-toggle');
  const input = document.getElementById('token-input');
  const clearBtn = document.getElementById('token-clear-btn');
  if (githubToken) {
    toggle.textContent = '✓ GitHub token active — limit raised to 5,000/hr';
    input.value = '';
    input.placeholder = 'token saved for this tab';
    clearBtn.classList.remove('hidden');
  } else {
    toggle.textContent = '+ add a GitHub token (raises the limit to 5,000/hr)';
    input.placeholder = 'ghp_...';
    clearBtn.classList.add('hidden');
  }
}

document.getElementById('token-toggle').addEventListener('click', () => {
  document.getElementById('token-panel').classList.toggle('hidden');
});
document.getElementById('token-save-btn').addEventListener('click', () => {
  const input = document.getElementById('token-input');
  const val = input.value.trim();
  if (!val) return;
  githubToken = val;
  updateTokenUI();
  document.getElementById('token-panel').classList.add('hidden');
});
document.getElementById('token-clear-btn').addEventListener('click', () => {
  githubToken = null;
  updateTokenUI();
});
document.getElementById('token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('token-save-btn').click();
});

// ---------- Compare mode ----------
let compareOpen = false;

function setCompareOpen(open) {
  compareOpen = open;
  const collapse = document.getElementById('compare-collapse');
  const toggle = document.getElementById('compare-toggle');
  toggle.textContent = open ? '− hide compare' : '+ compare with another repo';

  if (open) {
    collapse.style.height = collapse.scrollHeight + 'px';
    const onEnd = (e) => {
      if (e.propertyName !== 'height') return;
      if (compareOpen) collapse.style.height = 'auto'; // let it grow later once results are added
      collapse.removeEventListener('transitionend', onEnd);
    };
    collapse.addEventListener('transitionend', onEnd);
  } else {
    // If height is currently 'auto', pin it to a pixel value first so the
    // browser has something concrete to animate from — you can't transition
    // to/from 'auto' directly.
    collapse.style.height = collapse.scrollHeight + 'px';
    void collapse.offsetHeight; // force reflow so the browser registers that starting height
    requestAnimationFrame(() => { collapse.style.height = '0px'; });
  }
}

function resetCompareSection() {
  secondaryCompareData = null;
  compareOpen = false;
  const collapse = document.getElementById('compare-collapse');
  collapse.style.transition = 'none';
  collapse.style.height = '0px';
  requestAnimationFrame(() => { collapse.style.transition = ''; });
  document.getElementById('compare-toggle').classList.add('hidden');
  document.getElementById('compare-toggle').textContent = '+ compare with another repo';
  document.getElementById('compare-results').classList.add('hidden');
  document.getElementById('compare-results').innerHTML = '';
  document.getElementById('compare-input').value = '';
  showCompareStatus('', '');
}

function showCompareStatus(msg, state) {
  const el = document.getElementById('compare-status');
  el.textContent = msg;
  el.className = 'compare-status' + (state ? ` ${state}` : '');
}

async function loadCompareRepo(owner, repo) {
  if (!primaryCompareData) {
    showCompareStatus('Load a repo above first.', 'error');
    return;
  }
  if (`${owner}/${repo}`.toLowerCase() === primaryCompareData.fullName.toLowerCase()) {
    showCompareStatus("That's the repo already loaded above — try a different one.", 'error');
    return;
  }

  const btn = document.getElementById('compare-run-btn');
  btn.disabled = true;
  showCompareStatus(`fetching ${owner}/${repo}...`, 'loading');

  try {
    const repoData = await ghFetch(`/repos/${owner}/${repo}`);
    const readme = await fetchReadme(owner, repo);

    let commits = [];
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/commits?per_page=100&page=1`);
      commits = Array.isArray(fetched) ? fetched : [];
    } catch (e) { /* health score handles empty commit data gracefully */ }

    let contributors = [];
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/contributors?per_page=10`);
      contributors = Array.isArray(fetched) ? fetched : [];
    } catch (e) { /* fine */ }

    let languages = {};
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/languages`);
      languages = fetched && typeof fetched === 'object' ? fetched : {};
    } catch (e) { /* fine */ }

    let issues = [];
    try {
      const fetched = await ghFetch(`/repos/${owner}/${repo}/issues?state=all&per_page=100`);
      issues = Array.isArray(fetched) ? fetched : [];
    } catch (e) { /* fine */ }

    const facts = deriveRepoFacts(repoData, commits, contributors, languages, issues);
    const health = computeHealthScore({ commits, contributors, issues, repoData, readme });
    secondaryCompareData = { owner, repo, fullName: repoData.full_name, avatarUrl: repoData.owner ? repoData.owner.avatar_url : null, health, ...facts };

    renderCompareSection(primaryCompareData, secondaryCompareData);
    showCompareStatus('', '');
  } catch (err) {
    showCompareStatus(err.message || 'Something went wrong fetching that repo.', 'error');
  } finally {
    btn.disabled = false;
  }
}

function metricRowHTML(label, aVal, bVal, win) {
  return `
    <div class="compare-metric-row">
      <div class="compare-metric-value${win === 'a' ? ' win' : ''}">${escapeHTML(String(aVal))}</div>
      <div class="compare-metric-label">${escapeHTML(label)}</div>
      <div class="compare-metric-value${win === 'b' ? ' win' : ''}">${escapeHTML(String(bVal))}</div>
    </div>
  `;
}

function renderCompareSection(a, b) {
  const rows = [
    { label: 'stars', a: (a.stars || 0).toLocaleString(), b: (b.stars || 0).toLocaleString(), win: (a.stars || 0) !== (b.stars || 0) ? ((a.stars || 0) > (b.stars || 0) ? 'a' : 'b') : null },
    { label: 'forks', a: (a.forks || 0).toLocaleString(), b: (b.forks || 0).toLocaleString(), win: (a.forks || 0) !== (b.forks || 0) ? ((a.forks || 0) > (b.forks || 0) ? 'a' : 'b') : null },
    { label: 'contributors (sampled)', a: a.contributorCount, b: b.contributorCount, win: a.contributorCount !== b.contributorCount ? (a.contributorCount > b.contributorCount ? 'a' : 'b') : null },
    { label: 'last commit', a: a.lastCommitAgo || 'unknown', b: b.lastCommitAgo || 'unknown', win: null },
    { label: 'open issues (sampled)', a: a.openIssueCount, b: b.openIssueCount, win: a.openIssueCount !== b.openIssueCount ? (a.openIssueCount < b.openIssueCount ? 'a' : 'b') : null },
    { label: 'license', a: a.license || 'none', b: b.license || 'none', win: null }
  ];

  const aGrade = healthGradeInfo(a.health.total);
  const bGrade = healthGradeInfo(b.health.total);
  const healthTotal = (a.health.total + b.health.total) || 1;
  const aWidth = Math.min(85, Math.max(15, Math.round((a.health.total / healthTotal) * 100)));
  const bWidth = 100 - aWidth;

  const section = document.getElementById('compare-results');
  section.innerHTML = `
    <div class="compare-card" id="compare-card">
      <div class="compare-card-titlebar">
        <span class="share-card-dot red"></span><span class="share-card-dot amber"></span><span class="share-card-dot green"></span>
        <span class="share-card-titlebar-label">repo-visualizer · compare</span>
      </div>
      <div class="compare-card-body">
        <div class="compare-card-header">
          <div class="compare-card-side">
            ${a.avatarUrl ? `<img class="compare-card-avatar" src="${a.avatarUrl}" alt="">` : ''}
            <div class="compare-card-identity">
              <a class="compare-card-name" href="https://github.com/${a.fullName}" target="_blank" rel="noopener">${escapeHTML(a.fullName)}</a>
              <span class="compare-card-lang">${escapeHTML(a.topLanguage || 'unknown language')}</span>
            </div>
          </div>
          <div class="compare-card-vs">VS</div>
          <div class="compare-card-side compare-card-side-right">
            <div class="compare-card-identity compare-card-identity-right">
              <a class="compare-card-name" href="https://github.com/${b.fullName}" target="_blank" rel="noopener">${escapeHTML(b.fullName)}</a>
              <span class="compare-card-lang">${escapeHTML(b.topLanguage || 'unknown language')}</span>
            </div>
            ${b.avatarUrl ? `<img class="compare-card-avatar" src="${b.avatarUrl}" alt="">` : ''}
          </div>
        </div>

        <div class="compare-health">
          <div class="compare-health-label">health score</div>
          <div class="compare-health-bar">
            <div class="compare-health-bar-a" style="width:${aWidth}%; background:${aGrade.color}">${a.health.total}</div>
            <div class="compare-health-bar-mid"></div>
            <div class="compare-health-bar-b" style="width:${bWidth}%; background:${bGrade.color}">${b.health.total}</div>
          </div>
        </div>

        <div class="compare-metrics">
          ${rows.map(r => metricRowHTML(r.label, r.a, r.b, r.win)).join('')}
        </div>
      </div>
    </div>
    <div class="compare-share-row">
      <button type="button" id="compare-share-btn" class="share-image-btn">download as image</button>
    </div>
  `;
  section.classList.remove('hidden');
  document.getElementById('compare-share-btn').addEventListener('click', (e) => {
    const slug = `${a.fullName.replace('/', '-')}-vs-${b.fullName.replace('/', '-')}`;
    exportElementAsImage('compare-card', `${slug}.png`, e.currentTarget);
  });
  // Make sure the results aren't clipped even if they arrived mid-transition.
  if (compareOpen) document.getElementById('compare-collapse').style.height = 'auto';
  section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('compare-toggle').addEventListener('click', () => {
  setCompareOpen(!compareOpen);
});
document.getElementById('compare-run-btn').addEventListener('click', () => {
  const input = document.getElementById('compare-input');
  const parsed = parseRepoInput(input.value);
  if (!parsed) {
    showCompareStatus('Enter a repo as owner/repo or a full GitHub URL.', 'error');
    return;
  }
  loadCompareRepo(parsed.owner, parsed.repo);
});
document.getElementById('compare-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('compare-run-btn').click();
});

// ---------- Share as image ----------
// html2canvas is loaded lazily from a CDN on first use, not up front — most
// visitors will never click this, so there's no reason to pay for it by default.
let html2canvasPromise = null;
function loadHtml2Canvas() {
  if (window.html2canvas) return Promise.resolve(window.html2canvas);
  if (!html2canvasPromise) {
    html2canvasPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js';
      script.onload = () => resolve(window.html2canvas);
      script.onerror = () => reject(new Error('Could not load the image export library — check your connection.'));
      document.head.appendChild(script);
    });
  }
  return html2canvasPromise;
}

async function exportElementAsImage(elementId, filename, btn) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const originalLabel = btn ? btn.textContent : null;
  if (btn) { btn.disabled = true; btn.textContent = 'rendering...'; }
  try {
    const html2canvas = await loadHtml2Canvas();
    const bg = getComputedStyle(document.body).getPropertyValue('--bg-panel').trim() || '#0E131C';
    const canvas = await html2canvas(el, {
      backgroundColor: bg,
      scale: Math.min(2, window.devicePixelRatio || 1),
      useCORS: true
    });
    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  } catch (err) {
    console.error('Image export failed:', err);
    showError('Could not generate the image — try again, or take a screenshot instead.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// Builds the off-screen "share card" from everything currently loaded — name,
// avatar, description, health score, top stats, and language mix — so the
// exported image is a real summary, not just a screenshot of a UI panel.
function renderShareCard(ctx, health, languages) {
  const card = document.getElementById('share-card');

  const avatar = document.getElementById('share-card-avatar');
  avatar.src = ctx.avatarUrl || '';
  avatar.style.display = ctx.avatarUrl ? '' : 'none';

  document.getElementById('share-card-name').textContent = ctx.fullName || 'unknown/repo';

  const metaParts = [];
  if (ctx.topLanguage) metaParts.push(ctx.topLanguage);
  if (ctx.license) metaParts.push(ctx.license);
  if (ctx.createdYear) metaParts.push(`since ${ctx.createdYear}`);
  document.getElementById('share-card-meta').textContent = metaParts.join(' · ') || ctx.fullName;

  const { grade, color: gradeColor } = healthGradeInfo(health.total);
  const scoreEl = document.getElementById('share-card-score');
  scoreEl.textContent = health.total;
  scoreEl.style.color = gradeColor;
  const gradeEl = document.getElementById('share-card-grade');
  gradeEl.textContent = grade;
  gradeEl.style.color = gradeColor;

  document.getElementById('share-card-desc').textContent =
    ctx.description || 'No description provided for this repository.';

  const stats = [
    { value: (ctx.stars || 0).toLocaleString(), label: 'stars' },
    { value: (ctx.forks || 0).toLocaleString(), label: 'forks' },
    { value: ctx.contributorCount || 0, label: 'contributors' },
    { value: ctx.lastCommitAgo || 'unknown', label: 'last commit' }
  ];
  document.getElementById('share-card-stats').innerHTML = stats.map(s => `
    <div class="share-card-stat">
      <span class="share-card-stat-value">${escapeHTML(String(s.value))}</span>
      <span class="share-card-stat-label">${escapeHTML(s.label)}</span>
    </div>
  `).join('');

  const langEntries = Object.entries(languages || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const langTotal = langEntries.reduce((sum, [, v]) => sum + v, 0) || 1;
  document.getElementById('share-card-langs').innerHTML = langEntries.map(([name, bytes], i) => `
    <span class="share-card-lang">
      <span class="share-card-lang-swatch" style="background:${langPalette()[i % langPalette().length]}"></span>
      ${escapeHTML(name)} ${Math.round((bytes / langTotal) * 100)}%
    </span>
  `).join('');

  document.getElementById('share-card-url').textContent = (ctx.fullName ? `github.com/${ctx.fullName}` : '');

  return card;
}

document.getElementById('health-share-btn').addEventListener('click', (e) => {
  if (!currentRepoContext || !lastHealthResult) return;
  renderShareCard(currentRepoContext, lastHealthResult, lastLanguages);
  const slug = currentRepoContext.fullName ? currentRepoContext.fullName.replace('/', '-') : 'repo';
  exportElementAsImage('share-card', `${slug}-summary-card.png`, e.currentTarget);
});

// ---------- Theme toggle ----------
document.getElementById('theme-toggle').addEventListener('click', () => {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
});

// ---------- Offline support ----------
function updateOfflineBanner() {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  banner.classList.toggle('hidden', navigator.onLine);
}
window.addEventListener('online', updateOfflineBanner);
window.addEventListener('offline', updateOfflineBanner);

// ---------- Wire up UI ----------
document.getElementById('repo-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('repo-input');
  const parsed = parseRepoInput(input.value);
  if (!parsed) {
    showError('Enter a repo as owner/repo (e.g. facebook/react) or a full GitHub URL.');
    return;
  }
  loadRepo(parsed.owner, parsed.repo);
});

document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('repo-input').value = chip.dataset.repo;
    document.getElementById('repo-form').dispatchEvent(new Event('submit', { cancelable: true }));
  });
});

document.getElementById('ai-generate-btn').addEventListener('click', generateAiSummary);

// Sync the toggle's label/icon with whatever the inline head script already
// applied to <html data-theme> before first paint — no visible flash, no
// re-render, just bringing the button's text in line with reality.
applyTheme(currentTheme(), false);
updateOfflineBanner();

renderRecentChips();
initScrollspy();

const urlRepo = getRepoFromUrl();
if (urlRepo) {
  const parsed = parseRepoInput(urlRepo);
  if (parsed) {
    document.getElementById('repo-input').value = urlRepo;
    loadRepo(parsed.owner, parsed.repo);
  }
}