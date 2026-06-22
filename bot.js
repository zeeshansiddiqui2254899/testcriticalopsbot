/* eslint-disable */
'use strict';

const { SocketModeClient } = require('@slack/socket-mode');
const { WebClient } = require('@slack/web-api');
const axios = require('axios');

// ---- Config ----
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_APP_TOKEN = process.env.SLACK_APP_TOKEN;
const ABACUSAI_API_KEY = process.env.ABACUSAI_API_KEY;
const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_EMAIL = process.env.JIRA_EMAIL;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;
const JIRA_PROJECT_KEY = process.env.JIRA_PROJECT_KEY || 'CO';
const JIRA_ISSUE_TYPE = process.env.JIRA_ISSUE_TYPE || 'Task';
const SLACK_ALLOWED_CHANNEL_IDS = (process.env.SLACK_ALLOWED_CHANNEL_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const INCIDENT_MIN_LENGTH = parseInt(process.env.INCIDENT_MIN_LENGTH || '100', 10);
const MAX_RUN_MS = parseInt(process.env.MAX_RUN_MS || String(5.5 * 60 * 60 * 1000), 10);
const CATCHUP_LOOKBACK_HOURS = parseFloat(process.env.CATCHUP_LOOKBACK_HOURS || '168'); // 7 days

if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN || !ABACUSAI_API_KEY ||
    !JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
  console.error('Missing required env vars.');
  process.exit(1);
}

const slack = new WebClient(SLACK_BOT_TOKEN);
const socket = new SocketModeClient({ appToken: SLACK_APP_TOKEN });
const jira = axios.create({
  baseURL: `https://${JIRA_HOST}/rest/api/3`,
  auth: { username: JIRA_EMAIL, password: JIRA_API_TOKEN },
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  timeout: 20000,
});

// ---- In-memory dedupe (per-run) ----
const processed = new Set();
const processedQueue = [];
function markProcessed(id) {
  if (!id) return true;
  if (processed.has(id)) return false;
  processed.add(id);
  processedQueue.push(id);
  if (processedQueue.length > 1000) {
    const old = processedQueue.shift();
    processed.delete(old);
  }
  return true;
}

// ---- Marker we embed in Jira descriptions so we can find them later ----
// Format: [slack-msg-id:CHANNEL/TS]
function slackMarker(channel, ts) {
  return `[slack-msg-id:${channel}/${ts}]`;
}
function commentMarker(replyTs) {
  return `[slack-reply-id:${replyTs}]`;
}

// ---- Helpers ----
function adfFromText(text) {
  const paragraphs = text.split(/\n\n+/).map(para => ({
    type: 'paragraph',
    content: para.split('\n').flatMap((line, i, arr) => {
      const nodes = [{ type: 'text', text: line }];
      if (i < arr.length - 1) nodes.push({ type: 'hardBreak' });
      return nodes;
    }),
  }));
  return { type: 'doc', version: 1, content: paragraphs.length ? paragraphs : [{ type: 'paragraph', content: [{ type: 'text', text: ' ' }] }] };
}

async function generateIncidentContent(rawMessage) {
  const prompt = `You are an incident management assistant for an engineering operations team. An account manager just posted a rough incident report in Slack. Your job is to turn it into a clean Jira ticket.

Return ONLY valid JSON (no markdown, no code fences) with this exact shape:
{
  "summary": "<one-line title, max 100 chars, focus on WHAT broke and WHERE; no quotes, no trailing period>",
  "description": "<polished multi-paragraph description in plain text>"
}

Rules for "description":
- Rewrite the rough notes into a clear, professional incident description.
- Use these sections (only include sections that apply, in this order):
    Issue:
    Impact:
    Steps to Reproduce:
    Expected Behavior:
    Actual Behavior:
    Affected Customers / Accounts:
    Links / Evidence:
- Preserve ALL specific details: URLs, customer/account names, numeric values, screenshots, video links.
- Do NOT invent facts. Omit sections that don't apply.
- Plain text only, simple "- " bullets. No markdown.

Rough incident notes from Slack:
"""
${rawMessage}
"""`;
  const resp = await fetch('https://subcontractorhub.abacus.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ABACUSAI_API_KEY}` },
    body: JSON.stringify({ model: 'route-llm', messages: [{ role: 'user', content: prompt }], stream: false }),
  });
  if (!resp.ok) throw new Error(`LLM API ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch { const m = cleaned.match(/\{[\s\S]*\}/); if (!m) throw new Error('LLM did not return JSON'); parsed = JSON.parse(m[0]); }
  let summary = (parsed.summary || '').trim().split('\n')[0].trim();
  summary = summary.replace(/^["'`]+|["'`]+$/g, '').replace(/\.+$/, '');
  if (summary.length > 140) summary = summary.slice(0, 137) + '...';
  const description = (parsed.description || '').trim();
  if (!summary || !description) throw new Error('Empty LLM result');
  return { summary, description };
}

// SAFEGUARD #1: search Jira for an existing ticket created from this slack message
async function findExistingTicketForMessage(channel, ts) {
  const marker = slackMarker(channel, ts);
  const jql = `project = ${JIRA_PROJECT_KEY} AND description ~ "${marker.replace(/"/g, '\\"')}"`;
  try {
    const resp = await jira.get('/search', { params: { jql, fields: 'summary', maxResults: 1 } });
    const issues = resp.data?.issues || [];
    if (issues.length > 0) {
      return { key: issues[0].key, url: `https://${JIRA_HOST}/browse/${issues[0].key}` };
    }
  } catch (e) {
    console.error('[dedupe] Jira search failed:', e.response?.data || e.message);
  }
  return null;
}

async function createJiraIncident({ summary, description, rawMessage, slackPermalink, slackUser, channel, ts }) {
  const parts = [];
  if (slackUser) parts.push(`Reported by Slack user: ${slackUser}`);
  if (slackPermalink) parts.push(`Slack thread: ${slackPermalink}`);
  if (parts.length) parts.push('');
  parts.push(description);
  // embed dedupe marker (invisible-ish, at bottom)
  parts.push('', slackMarker(channel, ts));
  const payload = {
    fields: {
      project: { key: JIRA_PROJECT_KEY },
      issuetype: { name: JIRA_ISSUE_TYPE },
      summary,
      description: adfFromText(parts.join('\n')),
    },
  };
  const resp = await jira.post('/issue', payload);
  const key = resp.data.key;
  return { key, url: `https://${JIRA_HOST}/browse/${key}` };
}

async function addJiraComment(issueKey, text, author, replyTs) {
  const body = `${author ? author + ': ' : ''}${text}\n\n${commentMarker(replyTs)}`;
  await jira.post(`/issue/${issueKey}/comment`, { body: adfFromText(body) });
}

// Check if a reply ts is already commented (dedupe via marker)
async function commentExistsForReply(issueKey, replyTs) {
  const marker = commentMarker(replyTs);
  try {
    let startAt = 0;
    while (true) {
      const resp = await jira.get(`/issue/${issueKey}/comment`, { params: { startAt, maxResults: 100 } });
      const comments = resp.data?.comments || [];
      for (const c of comments) {
        const body = JSON.stringify(c.body || '');
        if (body.includes(marker)) return true;
      }
      if (comments.length < 100) return false;
      startAt += comments.length;
      if (startAt > 500) return false;
    }
  } catch (e) {
    console.error('[dedupe] comment list failed:', e.response?.data || e.message);
    return false;
  }
}

async function getDisplayName(userId) {
  try {
    const r = await slack.users.info({ user: userId });
    return r.user?.profile?.display_name || r.user?.real_name || userId;
  } catch { return userId; }
}
async function getPermalink(channel, ts) {
  try { const r = await slack.chat.getPermalink({ channel, message_ts: ts }); return r.permalink; }
  catch { return undefined; }
}
async function getThread(channel, thread_ts) {
  try { const r = await slack.conversations.replies({ channel, ts: thread_ts, limit: 200 }); return r.messages || []; }
  catch { return []; }
}

async function postIncidentCreated(channel, thread_ts, jiraKey, jiraUrl, summary) {
  await slack.chat.postMessage({
    channel, thread_ts,
    text: `Jira incident created: ${jiraKey} - ${summary}`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:rotating_light: *Jira incident created:* <${jiraUrl}|${jiraKey}>` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Summary:*\n${summary}` },
        { type: 'mrkdwn', text: `*Status:*\n:large_blue_circle: Open` },
      ] },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Reply in this thread — comments sync to Jira automatically.' }] },
    ],
  });
}

function extractFileUrls(ev) {
  const files = ev.files || [];
  return files.map(f => {
    const url = f.url_private || f.permalink || '';
    const name = f.name || f.title || 'file';
    return url ? `- ${name}: ${url}` : '';
  }).filter(Boolean);
}

async function handleTopLevel(ev) {
  let text = (ev.text || '').trim();
  const fileLines = extractFileUrls(ev);
  if (fileLines.length) {
    text = (text ? text + '\n\n' : '') + 'Attached files:\n' + fileLines.join('\n');
  }
  if (text.length < INCIDENT_MIN_LENGTH) return;
  console.log(`[incident] qualifying msg ch=${ev.channel} user=${ev.user} len=${text.length}`);

  // SAFEGUARD #1 — dedupe via Jira search
  const existing = await findExistingTicketForMessage(ev.channel, ev.ts);
  if (existing) {
    console.log(`[incident] duplicate detected — existing ticket ${existing.key}, skipping.`);
    return;
  }

  try {
    const displayName = await getDisplayName(ev.user);
    const permalink = await getPermalink(ev.channel, ev.ts);
    const { summary, description } = await generateIncidentContent(text);
    const ticket = await createJiraIncident({
      summary, description, rawMessage: text,
      slackPermalink: permalink, slackUser: displayName,
      channel: ev.channel, ts: ev.ts,
    });
    console.log(`[incident] created ${ticket.key}`);
    await postIncidentCreated(ev.channel, ev.ts, ticket.key, ticket.url, summary);
  } catch (e) {
    console.error('[incident] failed:', e.message);
    try { await slack.chat.postMessage({ channel: ev.channel, thread_ts: ev.ts, text: `:warning: Could not create Jira incident: ${e.message}` }); } catch {}
  }
}

function findJiraKeyInThread(thread) {
  const keyRegex = new RegExp(`\\b${JIRA_PROJECT_KEY}-\\d+\\b`);
  for (const m of thread) {
    const hay = JSON.stringify({ text: m.text, attachments: m.attachments, blocks: m.blocks });
    const match = hay.match(keyRegex);
    if (match) return match[0];
  }
  return null;
}

async function syncReplyToJira(ev) {
  const text = (ev.text || '').trim();
  if (!text) return;
  const thread = await getThread(ev.channel, ev.thread_ts);
  const jiraKey = findJiraKeyInThread(thread);
  if (!jiraKey) return;

  // SAFEGUARD #2 — dedupe via marker in Jira comments
  if (await commentExistsForReply(jiraKey, ev.ts)) {
    console.log(`[comment] already synced for ${jiraKey} reply=${ev.ts}`);
    return;
  }

  const displayName = await getDisplayName(ev.user);
  try {
    await addJiraComment(jiraKey, text, displayName, ev.ts);
    console.log(`[comment] synced to ${jiraKey} from ${displayName}`);
  } catch (e) {
    console.error(`[comment] failed for ${jiraKey}:`, e.message);
  }
}

// SAFEGUARD #3 — Startup catchup: scan recent threads and sync any missed replies
async function catchupMissedReplies() {
  if (SLACK_ALLOWED_CHANNEL_IDS.length === 0) return;
  const oldest = ((Date.now() - CATCHUP_LOOKBACK_HOURS * 3600 * 1000) / 1000).toFixed(6);
  console.log(`[catchup] scanning last ${CATCHUP_LOOKBACK_HOURS}h for missed replies...`);

  for (const channel of SLACK_ALLOWED_CHANNEL_IDS) {
    try {
      const hist = await slack.conversations.history({ channel, oldest, limit: 200 });
      const parents = (hist.messages || []).filter(m => m.reply_count && m.reply_count > 0 && !m.subtype);
      for (const parent of parents) {
        const thread = await getThread(channel, parent.ts);
        const jiraKey = findJiraKeyInThread(thread);
        if (!jiraKey) continue;
        // process replies (skip parent itself)
        for (const reply of thread) {
          if (reply.ts === parent.ts) continue;
          if (reply.subtype || reply.bot_id || reply.app_id) continue;
          const replyText = (reply.text || '').trim();
          if (!replyText) continue;
          // only consider replies within lookback window
          if (parseFloat(reply.ts) * 1000 < Date.now() - CATCHUP_LOOKBACK_HOURS * 3600 * 1000) continue;
          if (await commentExistsForReply(jiraKey, reply.ts)) continue;
          const displayName = await getDisplayName(reply.user);
          try {
            await addJiraComment(jiraKey, replyText, displayName, reply.ts);
            console.log(`[catchup] synced missed reply to ${jiraKey} from ${displayName}`);
          } catch (e) {
            console.error(`[catchup] failed for ${jiraKey}:`, e.message);
          }
        }
      }
    } catch (e) {
      console.error(`[catchup] channel ${channel} failed:`, e.response?.data || e.message);
    }
  }
  console.log('[catchup] done.');
}

socket.on('connecting', () => console.log('Socket Mode: connecting...'));
socket.on('connected',  () => { console.log('Socket Mode: connected ✅'); catchupMissedReplies().catch(e => console.error('catchup err:', e.message)); });
socket.on('disconnected', () => console.log('Socket Mode: disconnected'));
socket.on('error', (err) => console.error('Socket Mode error:', err?.message || err));

socket.on('message', async ({ event, ack }) => {
  try { await ack(); } catch {}
  try {
    const ev = event;
    if (!ev || ev.type !== 'message') return;
    // Allow file_share (message with attached image/file). Skip other subtypes (edits, deletes, joins, etc.)
    if (ev.subtype && ev.subtype !== 'file_share') return;
    if (ev.bot_id || ev.app_id) return;
    const id = ev.client_msg_id || `${ev.channel}-${ev.ts}`;
    if (!markProcessed(id)) return;
    if (SLACK_ALLOWED_CHANNEL_IDS.length === 0) { console.warn('SLACK_ALLOWED_CHANNEL_IDS not set; ignoring.'); return; }
    if (!SLACK_ALLOWED_CHANNEL_IDS.includes(ev.channel)) return;
    if (ev.thread_ts && ev.thread_ts !== ev.ts) { await syncReplyToJira(ev); return; }
    await handleTopLevel(ev);
  } catch (e) {
    console.error('handler error:', e.message);
  }
});

setTimeout(async () => {
  console.log(`Reached MAX_RUN_MS. Disconnecting for restart.`);
  try { await socket.disconnect(); } catch {}
  process.exit(0);
}, MAX_RUN_MS);

socket.start().then(() => console.log('Bot started.')).catch(e => { console.error('Failed to start:', e); process.exit(1); });
