const feed = document.getElementById('feed');
const feedInner = document.getElementById('feedInner');
const status = document.getElementById('status');
const input = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const clearBtn = document.getElementById('clearBtn');
const groupToggle = document.getElementById('groupChatToggle');
const maxTurnsInput = document.getElementById('maxTurnsInput');
const askButtons = document.getElementById('askButtons');
const providerPanel = document.getElementById('providerPanel');
const modeSelect = document.getElementById('modeSelect');
const fallbackToggle = document.getElementById('fallbackToggle');
const newChatBtn = document.getElementById('newChatBtn');
const chatList = document.getElementById('chatList');
const goalInput = document.getElementById('goalInput');
const runArbiterBtn = document.getElementById('runArbiterBtn');
const tasksSidebar = document.getElementById('tasksSidebar');
const tasksList = document.getElementById('tasksList');
const tasksCount = document.getElementById('tasksCount');
const tasksToggleBtn = document.getElementById('tasksToggleBtn');
const stopBtn = document.getElementById('stopBtn');
const goalSaved = document.getElementById('goalSaved');
const pageTitleText = document.getElementById('pageTitleText');
const pageSub = document.getElementById('pageSub');

const busy = {};
let currentId = null;
let currentGoal = null;
let currentTasks = [];
let goalSaveTimer = null;
let goalSavedTimer = null;
let tasksCollapsed = false;
let seenSystemErrorKeys = new Set();
let providers = [];
let personas = [];
let modes = [];
let appSettings = {
  activeProviders: ['claude', 'codex'],
  providerProfiles: {
    claude: { traits: ['strategist', 'challenger', 'decisive'], custom: '' },
    codex: { traits: ['skeptic', 'diplomatic', 'numerate'], custom: '' },
  },
  stopRules: { maxRuntimeMinutes: 8, stopAfterAgreementTurns: 2, maxConsecutiveErrors: 2, autoArbitrate: true },
  conversationMode: 'debate',
  fallbackEnabled: true,
  limits: { maxTraitsPerProvider: 12, maxCustomInstructionsLen: 1000 },
};

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtRelative(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

if (typeof marked !== 'undefined') {
  marked.setOptions({
    gfm: true,
    breaks: true,
    pedantic: false,
    mangle: false,
    headerIds: false,
  });
}

function renderBody(content, from) {
  const body = document.createElement('div');
  body.className = 'body';
  if (from === 'arbiter') {
    try {
      const data = JSON.parse(content);
      renderArbiterCard(body, data);
      return body;
    } catch (e) {
      body.textContent = content;
      return body;
    }
  }
  if (from === 'system' && renderSystemError(body, content)) {
    return body;
  }
  if (from === 'user' || typeof marked === 'undefined') {
    body.textContent = content;
    return body;
  }
  // Render markdown for AI messages AND non-error system messages (worker
  // dispatch / worker finished notes etc. contain headings, lists, and
  // bold spans that should render properly instead of showing raw `##` and `**`).
  // Always sanitize through DOMPurify - model and worker output is untrusted
  // and could contain <script> tags or other injection attempts.
  body.innerHTML = safeMarkdown(content);
  return body;
}

// Render markdown and sanitize before inserting as HTML. Falls back to plain
// text if either library is missing (offline / failed CDN).
function safeMarkdown(content) {
  const raw = String(content || '');
  if (typeof marked === 'undefined') return escapeHtml(raw);
  let html;
  try { html = marked.parse(raw); }
  catch { return escapeHtml(raw); }
  if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.sanitize === 'function') {
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }
  // DOMPurify failed to load; refuse to render unsanitized HTML.
  return escapeHtml(raw);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSystemErrorContent(content) {
  return /^Error invoking \w+:/i.test(String(content || ''))
    || /^Arbiter error:/i.test(String(content || ''))
    || /^\*\*.+ worker FAILED\*\*/i.test(String(content || ''));
}

function parseProcessFailure(detail) {
  const text = String(detail || '').trim();
  const stdoutMarker = 'stdout:\n';
  const stderrMarker = '\nstderr:\n';
  const stdoutAt = text.indexOf(stdoutMarker);
  if (stdoutAt === -1) {
    return { summary: text, stdout: '', stderr: '' };
  }

  const before = text.slice(0, stdoutAt).replace(/:\s*$/, '').trim();
  const afterStdout = text.slice(stdoutAt + stdoutMarker.length);
  const stderrAt = afterStdout.indexOf(stderrMarker);
  if (stderrAt === -1) {
    return { summary: before, stdout: afterStdout.trim(), stderr: '' };
  }

  return {
    summary: before,
    stdout: afterStdout.slice(0, stderrAt).trim(),
    stderr: afterStdout.slice(stderrAt + stderrMarker.length).trim(),
  };
}

function appendErrorBlock(card, label, text) {
  if (!text) return;
  const block = document.createElement('div');
  block.className = 'system-error-block';
  const title = document.createElement('div');
  title.className = 'system-error-block-title';
  title.textContent = label;
  const pre = document.createElement('pre');
  pre.textContent = text;
  block.appendChild(title);
  block.appendChild(pre);
  card.appendChild(block);
}

function resetTextFromQuotaLine(quotaLine) {
  const resetMatch = quotaLine ? String(quotaLine).match(/resets?\s+(.+)$/i) : null;
  return resetMatch ? resetMatch[1].trim() : '';
}

function renderSystemError(container, content) {
  if (!isSystemErrorContent(content)) return false;

  const text = String(content || '');
  const invoke = text.match(/^Error invoking (\w+):\s*([\s\S]*)$/i);
  const who = invoke ? invoke[1].toLowerCase() : 'system';
  const detail = invoke ? invoke[2] : text;
  const parsed = parseProcessFailure(detail);
  const quotaLine = [parsed.stdout, parsed.stderr, parsed.summary]
    .join('\n')
    .split(/\r?\n/)
    .find(line => /hit your limit|rate limit|quota|resets/i.test(line));
  const resetText = resetTextFromQuotaLine(quotaLine);
  const errorKey = quotaLine ? `limit:${who}:${resetText || quotaLine}` : '';
  const isRepeatLimit = !!errorKey && seenSystemErrorKeys.has(errorKey);
  if (errorKey) seenSystemErrorKeys.add(errorKey);

  const card = document.createElement('div');
  card.className = isRepeatLimit ? 'system-error-card compact' : 'system-error-card';

  if (isRepeatLimit) {
    const line = document.createElement('div');
    line.className = 'system-error-compact-line';
    line.textContent = resetText
      ? `${LABELS[who] || who} will reset at ${resetText}.`
      : `${LABELS[who] || who} is currently rate limited.`;
    card.appendChild(line);
    container.appendChild(card);
    return true;
  }

  const header = document.createElement('div');
  header.className = 'system-error-header';

  const badge = document.createElement('span');
  badge.className = 'system-error-badge';
  badge.textContent = quotaLine ? 'Limit reached' : 'CLI error';
  header.appendChild(badge);

  const title = document.createElement('strong');
  title.textContent = invoke
    ? `${LABELS[who] || who} did not return a usable reply`
    : 'System action failed';
  header.appendChild(title);
  card.appendChild(header);

  if (quotaLine) {
    const quota = document.createElement('div');
    quota.className = 'system-error-quota';
    quota.textContent = quotaLine.replace(/^stdout:\s*/i, '').trim();
    card.appendChild(quota);
  }

  if (resetText) {
    const reset = document.createElement('div');
    reset.className = 'system-error-reset';
    reset.textContent = `Try again after ${resetText}`;
    card.appendChild(reset);
  }

  if (parsed.summary && parsed.summary !== quotaLine) {
    const summary = document.createElement('div');
    summary.className = 'system-error-summary';
    summary.textContent = parsed.summary;
    card.appendChild(summary);
  }

  appendErrorBlock(card, 'stdout', parsed.stdout);
  appendErrorBlock(card, 'stderr', parsed.stderr);

  if (!parsed.stdout && !parsed.stderr && !parsed.summary) {
    appendErrorBlock(card, 'details', text);
  }

  container.appendChild(card);
  return true;
}

function renderArbiterCard(container, data) {
  if (data.decision) {
    const block = document.createElement('div');
    block.className = 'arbiter-block';
    const h = document.createElement('h4'); h.textContent = 'Decision'; block.appendChild(h);
    const d = document.createElement('div'); d.className = 'arbiter-decision'; d.textContent = data.decision;
    block.appendChild(d);
    container.appendChild(block);
  } else {
    const block = document.createElement('div');
    block.className = 'arbiter-block';
    const h = document.createElement('h4'); h.textContent = 'Decision'; block.appendChild(h);
    const d = document.createElement('div'); d.className = 'arbiter-decision';
    d.textContent = 'No clear decision reached.';
    d.style.fontStyle = 'italic';
    d.style.color = '#6b5e87';
    block.appendChild(d);
    container.appendChild(block);
  }

  if (data.rationale) {
    const block = document.createElement('div');
    block.className = 'arbiter-block';
    const h = document.createElement('h4'); h.textContent = 'Rationale'; block.appendChild(h);
    const d = document.createElement('div'); d.className = 'arbiter-rationale'; d.textContent = data.rationale;
    block.appendChild(d);
    container.appendChild(block);
  }

  if (Array.isArray(data.rejected_options) && data.rejected_options.length) {
    const block = document.createElement('div');
    block.className = 'arbiter-block';
    const h = document.createElement('h4'); h.textContent = 'Rejected'; block.appendChild(h);
    const ul = document.createElement('ul'); ul.className = 'arbiter-list';
    for (const r of data.rejected_options) {
      const li = document.createElement('li'); li.textContent = r; ul.appendChild(li);
    }
    block.appendChild(ul);
    container.appendChild(block);
  }

  if (Array.isArray(data.open_questions) && data.open_questions.length) {
    const block = document.createElement('div');
    block.className = 'arbiter-block';
    const h = document.createElement('h4'); h.textContent = 'Open questions'; block.appendChild(h);
    const ul = document.createElement('ul'); ul.className = 'arbiter-list';
    for (const q of data.open_questions) {
      const li = document.createElement('li'); li.textContent = q; ul.appendChild(li);
    }
    block.appendChild(ul);
    container.appendChild(block);
  }

  if (Array.isArray(data.next_tasks) && data.next_tasks.length) {
    const block = document.createElement('div');
    block.className = 'arbiter-block';
    const h = document.createElement('h4'); h.textContent = 'Next tasks'; block.appendChild(h);
    for (const t of data.next_tasks) {
      block.appendChild(renderTaskItem(t));
    }
    container.appendChild(block);
  }
}

function renderTaskItem(t) {
  const item = document.createElement('div');
  item.className = 'task-item';
  item.dataset.taskId = t.id || '';

  const desc = document.createElement('span');
  desc.className = 'task-desc';
  desc.textContent = t.description;
  item.appendChild(desc);

  const owner = document.createElement('span');
  owner.className = `task-owner ${t.owner || ''}`;
  owner.textContent = LABELS[t.owner] || t.owner || 'user';
  item.appendChild(owner);

  const status = document.createElement('span');
  status.className = `task-status ${t.status || 'proposed'}`;
  status.textContent = t.status || 'proposed';
  item.appendChild(status);

  if (t.id) {
    const actions = document.createElement('span');
    actions.className = 'task-actions';
    const mkBtn = (label, newStatus) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        updateTaskStatus(t.id, newStatus);
      });
      return b;
    };
    if (t.status !== 'approved') actions.appendChild(mkBtn('Approve', 'approved'));
    if (t.status !== 'done') actions.appendChild(mkBtn('Done', 'done'));
    if (t.status !== 'blocked') actions.appendChild(mkBtn('Block', 'blocked'));
    item.appendChild(actions);
  }

  if (t.success_test) {
    const test = document.createElement('span');
    test.className = 'task-test';
    test.textContent = 'Success: ' + t.success_test;
    item.appendChild(test);
  }

  return item;
}

async function updateTaskStatus(taskId, status) {
  await fetch(`/api/tasks/${taskId}/status`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

async function runTaskWorker(taskId) {
  const r = await fetch(`/api/tasks/${taskId}/run`, { method: 'POST' });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    alert(`Could not start worker: ${e.error || r.statusText}`);
  }
}

async function sendTaskBackToChat(taskId) {
  await fetch(`/api/tasks/${taskId}/send-to-chat`, { method: 'POST' });
}

async function deleteTaskById(taskId) {
  if (!confirm('Delete this task?')) return;
  await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
}

function renderTaskEvent(ev) {
  const row = document.createElement('div');
  row.className = 'task-event';
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = ev.ts ? fmtTime(ev.ts) : '';
  const kind = document.createElement('span');
  kind.className = `kind ${ev.kind || 'thought'}`;
  kind.textContent = `[${ev.kind || 'thought'}]`;
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = ev.text || '';
  row.appendChild(ts);
  row.appendChild(kind);
  row.appendChild(text);
  return row;
}

function renderTaskCard(t) {
  const card = document.createElement('li');
  card.className = `task-card ${t.status || 'proposed'}`;
  card.dataset.taskId = t.id;

  const row1 = document.createElement('div');
  row1.className = 'task-row1';

  const desc = document.createElement('div');
  desc.className = 'task-desc';
  if (t.status === 'running') {
    const sp = document.createElement('span');
    sp.className = 'spinner-inline';
    desc.appendChild(sp);
  }
  const descText = document.createElement('span');
  descText.textContent = t.description || '(no description)';
  desc.appendChild(descText);

  const pills = document.createElement('div');
  pills.className = 'task-pills';
  const ownerPill = document.createElement('span');
  ownerPill.className = `pill owner-${t.owner || 'user'}`;
  ownerPill.textContent = LABELS[t.owner] || t.owner || 'user';
  pills.appendChild(ownerPill);
  const statusPill = document.createElement('span');
  statusPill.className = `pill status-${t.status || 'proposed'}`;
  statusPill.textContent = t.status || 'proposed';
  pills.appendChild(statusPill);

  row1.appendChild(desc);
  row1.appendChild(pills);
  card.appendChild(row1);

  if (t.success_test) {
    const test = document.createElement('div');
    test.className = 'task-test';
    test.textContent = 'Success: ' + t.success_test;
    card.appendChild(test);
  }

  if (t.workspace) {
    const ws = document.createElement('div');
    ws.className = 'task-workspace';
    ws.textContent = 'Workspace: ' + t.workspace;
    card.appendChild(ws);
  }

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  const mkBtn = (label, cls, fn, disabled = false) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cls) b.className = cls;
    if (disabled) b.disabled = true;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    return b;
  };

  const canDispatch = !!providerById(t.owner)?.worker;
  if (t.status === 'proposed' || t.status === 'approved' || t.status === 'blocked') {
    if (canDispatch) {
      actions.appendChild(mkBtn(t.status === 'blocked' ? 'Retry worker' : 'Run worker', 'primary', () => runTaskWorker(t.id)));
    }
    if (t.status !== 'approved' && canDispatch) {
      actions.appendChild(mkBtn('Approve only', 'secondary', () => updateTaskStatus(t.id, 'approved')));
    }
    if (!canDispatch && t.status !== 'done') {
      actions.appendChild(mkBtn('Mark done', 'success', () => updateTaskStatus(t.id, 'done')));
    }
    actions.appendChild(mkBtn('Delete', 'danger', () => deleteTaskById(t.id)));
  } else if (t.status === 'running') {
    actions.appendChild(mkBtn('Running...', 'primary', () => {}, true));
  } else if (t.status === 'reviewing') {
    actions.appendChild(mkBtn('Accept', 'success', () => updateTaskStatus(t.id, 'done')));
    actions.appendChild(mkBtn('Send back to council', 'secondary', () => sendTaskBackToChat(t.id)));
    if (canDispatch) actions.appendChild(mkBtn('Re-run', 'secondary', () => runTaskWorker(t.id)));
    actions.appendChild(mkBtn('Delete', 'danger', () => deleteTaskById(t.id)));
  } else if (t.status === 'done') {
    actions.appendChild(mkBtn('Reopen', 'secondary', () => updateTaskStatus(t.id, 'proposed')));
    actions.appendChild(mkBtn('Delete', 'danger', () => deleteTaskById(t.id)));
  }
  card.appendChild(actions);

  if (Array.isArray(t.events) && t.events.length && (t.status === 'running' || t.status === 'reviewing' || t.status === 'blocked')) {
    const eventsEl = document.createElement('div');
    eventsEl.className = 'task-events';
    eventsEl.dataset.eventsFor = t.id;
    const recent = t.events.slice(-60);
    for (const ev of recent) eventsEl.appendChild(renderTaskEvent(ev));
    card.appendChild(eventsEl);
    requestAnimationFrame(() => { eventsEl.scrollTop = eventsEl.scrollHeight; });
  }

  if (t.output && (t.status === 'reviewing' || t.status === 'done' || t.status === 'blocked')) {
    const det = document.createElement('details');
    det.className = 'task-output';
    det.open = t.status === 'reviewing';
    const sum = document.createElement('summary');
    sum.textContent = t.status === 'blocked' ? 'Worker error' : 'Worker output';
    det.appendChild(sum);
    const body = document.createElement('div');
    if (typeof marked !== 'undefined' && t.status !== 'blocked') {
      body.className = 'output-rendered';
      body.innerHTML = safeMarkdown(t.output);
    } else {
      body.className = 'output-body';
      body.textContent = t.output;
    }
    det.appendChild(body);
    card.appendChild(det);
  }

  return card;
}

function renderTasks() {
  if (!tasksSidebar || !tasksList) return;
  const tasks = Array.isArray(currentTasks) ? currentTasks : [];
  const visible = tasks.filter(t => t.status !== 'done' || (t.completedAt && Date.now() - t.completedAt < 1000 * 60 * 30));
  const hasAny = visible.length > 0;

  if (!hasAny) {
    tasksSidebar.classList.add('hidden');
    tasksList.innerHTML = '';
    if (tasksCount) {
      tasksCount.textContent = '0';
      tasksCount.classList.add('empty');
    }
    return;
  }

  tasksSidebar.classList.remove('hidden');
  if (tasksCollapsed) tasksSidebar.classList.add('collapsed'); else tasksSidebar.classList.remove('collapsed');
  if (tasksCount) {
    const active = tasks.filter(t => t.status !== 'done').length;
    tasksCount.textContent = String(active);
    tasksCount.classList.toggle('empty', active === 0);
  }
  const sorted = [...visible].sort((a, b) => {
    const order = { running: 0, reviewing: 1, blocked: 2, approved: 3, proposed: 4, done: 5 };
    const oa = order[a.status] ?? 6;
    const ob = order[b.status] ?? 6;
    if (oa !== ob) return oa - ob;
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
  tasksList.innerHTML = '';
  for (const t of sorted) tasksList.appendChild(renderTaskCard(t));
}

function upsertTask(task) {
  const idx = currentTasks.findIndex(t => t.id === task.id);
  if (idx === -1) currentTasks.push(task);
  else currentTasks[idx] = task;
  renderTasks();
  updateButtons();
}

function appendTaskEvent(taskId, event) {
  const t = currentTasks.find(t => t.id === taskId);
  if (!t) return;
  if (!Array.isArray(t.events)) t.events = [];
  t.events.push(event);
  if (t.events.length > 200) t.events = t.events.slice(-200);
  const existing = tasksList?.querySelector(`[data-task-id="${taskId}"] [data-events-for="${taskId}"]`);
  if (existing) {
    existing.appendChild(renderTaskEvent(event));
    existing.scrollTop = existing.scrollHeight;
  } else {
    renderTasks();
  }
}

const LABELS = {
  claude: 'Opus 4.7',
  codex: 'GPT-5.5',
  user: 'You',
  system: 'System',
  arbiter: 'Arbiter',
};

const LOGOS = {
  claude: '/anthropic.svg',
  codex: '/openai.svg',
};

function providerById(id) {
  return providers.find(p => p.id === id) || null;
}

function labelFor(id) {
  return providerById(id)?.label || LABELS[id] || id;
}

function colorFor(id) {
  return providerById(id)?.color || '#6d4ca8';
}

function activeProviderIds() {
  return Array.isArray(appSettings.activeProviders) ? appSettings.activeProviders : [];
}

function renderWho(from) {
  const who = document.createElement('span');
  who.className = 'who';
  const provider = providerById(from);
  if (LOGOS[from]) {
    const img = document.createElement('img');
    img.className = 'who-logo';
    img.src = LOGOS[from];
    img.alt = '';
    who.appendChild(img);
  } else if (provider) {
    const badge = document.createElement('span');
    badge.className = 'who-badge';
    badge.style.backgroundColor = provider.color || '#6d4ca8';
    badge.textContent = provider.icon || provider.shortLabel?.slice(0, 2) || from.slice(0, 2).toUpperCase();
    who.appendChild(badge);
  }
  const name = document.createElement('span');
  name.className = 'who-name';
  name.textContent = labelFor(from);
  who.appendChild(name);
  return who;
}

function healthLabel(provider) {
  const status = provider?.health?.status || (provider?.enabled ? 'ready' : 'disabled');
  if (status === 'rate-limited' && provider?.health?.resetAt) return `limited until ${provider.health.resetAt}`;
  if (status === 'ready') return 'ready';
  if (status === 'busy') return 'busy';
  if (status === 'disabled') return 'disabled';
  return status;
}

function renderModeOptions(select) {
  if (!select) return;
  const current = select.value || appSettings.conversationMode || 'debate';
  select.innerHTML = '';
  for (const mode of modes) {
    const opt = document.createElement('option');
    opt.value = mode.id;
    opt.textContent = mode.label;
    select.appendChild(opt);
  }
  select.value = modes.some(m => m.id === current) ? current : (appSettings.conversationMode || 'debate');
}

function buildProviderBadge(p) {
  if (LOGOS[p.id]) {
    const img = document.createElement('img');
    img.className = 'provider-icon provider-icon-img';
    img.src = LOGOS[p.id];
    img.alt = '';
    return img;
  }
  const badge = document.createElement('span');
  badge.className = 'provider-icon';
  badge.style.backgroundColor = p.color || '#6d4ca8';
  badge.textContent = p.icon || p.shortLabel?.slice(0, 2) || p.id.slice(0, 2).toUpperCase();
  return badge;
}

function traitsSummary(p) {
  const profile = p.profile || {};
  const traitIds = Array.isArray(profile.traits) ? profile.traits : [];
  if (!traitIds.length) return 'No traits';
  const labels = traitIds
    .map(id => (personas.find(t => t.id === id) || {}).label)
    .filter(Boolean);
  if (!labels.length) return 'Traits';
  if (labels.length <= 2) return labels.join(', ');
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2}`;
}

function renderProviderPanel() {
  if (!providerPanel) return;
  providerPanel.innerHTML = '';
  for (const p of providers) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = `provider-chip provider-chip-clickable ${p.enabled ? 'enabled' : 'disabled'} health-${p.health?.status || 'ready'}`;
    item.style.setProperty('--provider-color', p.color || '#6d4ca8');
    item.title = `Configure ${p.label}'s personality`;
    item.addEventListener('click', () => openProviderDialog(p.id));

    item.appendChild(buildProviderBadge(p));

    const main = document.createElement('span');
    main.className = 'provider-chip-main';
    const name = document.createElement('strong');
    name.textContent = p.shortLabel || p.label;
    const meta = document.createElement('small');
    meta.textContent = `${traitsSummary(p)} / ${healthLabel(p)}`;
    main.appendChild(name);
    main.appendChild(meta);
    item.appendChild(main);

    providerPanel.appendChild(item);
  }
}

function renderAskButtons() {
  if (!askButtons) return;
  askButtons.innerHTML = '';
  for (const p of providers.filter(x => x.enabled)) {
    const btn = document.createElement('button');
    btn.className = 'provider-ask';
    btn.style.setProperty('--provider-color', p.color || '#6d4ca8');
    btn.disabled = !!busy[p.id] || p.health?.status === 'rate-limited';
    btn.title = p.health?.status === 'rate-limited' && p.health?.resetAt
      ? `${p.label} resets at ${p.health.resetAt}`
      : `Ask ${p.label}`;
    const icon = buildProviderBadge(p);
    icon.classList.add('provider-ask-icon');
    const text = document.createElement('span');
    text.textContent = `Ask ${p.shortLabel || p.label}`;
    btn.appendChild(icon);
    btn.appendChild(text);
    btn.addEventListener('click', () => ask(p.id));
    askButtons.appendChild(btn);
  }
}

const TRAIT_CATEGORY_LABELS = {
  thinking: 'Thinking style',
  disposition: 'Disposition',
  communication: 'Communication style',
};

function profileForProvider(p) {
  const profile = (p && p.profile) || appSettings.providerProfiles?.[p?.id];
  const traits = Array.isArray(profile?.traits) ? profile.traits.slice() : [];
  const custom = typeof profile?.custom === 'string' ? profile.custom : '';
  return { traits, custom };
}

function buildProviderProfileCard(p, opts = {}) {
  const maxTraits = appSettings.limits?.maxTraitsPerProvider || 6;
  const maxCustom = appSettings.limits?.maxCustomInstructionsLen || 1000;

  const card = document.createElement('div');
  card.className = 'provider-profile-card';
  card.style.setProperty('--provider-color', p.color || '#6d4ca8');

  // Header: enable toggle + logo + label + health
  const header = document.createElement('div');
  header.className = 'provider-profile-header';

  const enableLabel = document.createElement('label');
  enableLabel.className = 'provider-enable';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = !!p.enabled;
  checkbox.addEventListener('change', () => {
    const active = new Set(activeProviderIds());
    if (checkbox.checked) active.add(p.id);
    else active.delete(p.id);
    if (active.size === 0) {
      checkbox.checked = true;
      active.add(p.id);
    }
    saveCouncilSettings({ activeProviders: Array.from(active) });
  });
  enableLabel.appendChild(checkbox);
  enableLabel.appendChild(buildProviderBadge(p));
  const labelSpan = document.createElement('span');
  labelSpan.className = 'provider-profile-name';
  labelSpan.textContent = opts.showFullLabel ? p.label : p.label;
  enableLabel.appendChild(labelSpan);
  header.appendChild(enableLabel);

  const health = document.createElement('span');
  health.className = `provider-health health-${p.health?.status || 'ready'}`;
  health.textContent = healthLabel(p);
  header.appendChild(health);

  card.appendChild(header);

  // Traits multi-select grouped by category
  const traitsLabel = document.createElement('div');
  traitsLabel.className = 'provider-profile-sublabel';
  traitsLabel.textContent = `Character traits (pick up to ${maxTraits})`;
  card.appendChild(traitsLabel);

  const current = profileForProvider(p);
  const selected = new Set(current.traits);

  const groups = {};
  for (const t of personas) {
    const cat = t.category || 'thinking';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(t);
  }

  const orderedCats = ['thinking', 'disposition', 'communication'].filter(c => groups[c]);

  const traitsArea = document.createElement('div');
  traitsArea.className = 'provider-trait-area';

  // Track every chip so we can refresh the at-cap disabled state across all
  // categories whenever a trait is toggled.
  const chipRegistry = [];
  function refreshCapState() {
    const atCap = selected.size >= maxTraits;
    for (const { id, el } of chipRegistry) {
      const isSelected = selected.has(id);
      const disabled = atCap && !isSelected;
      el.disabled = disabled;
      el.title = disabled
        ? `Max ${maxTraits} traits. Remove one to add another.`
        : (personas.find(t => t.id === id) || {}).prompt || '';
    }
  }

  for (const cat of orderedCats) {
    const catWrap = document.createElement('div');
    catWrap.className = 'provider-trait-group';

    const catTitle = document.createElement('div');
    catTitle.className = 'provider-trait-group-title';
    catTitle.textContent = TRAIT_CATEGORY_LABELS[cat] || cat;
    catWrap.appendChild(catTitle);

    const chipsRow = document.createElement('div');
    chipsRow.className = 'provider-trait-chips';

    for (const trait of groups[cat]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `trait-chip${selected.has(trait.id) ? ' selected' : ''}`;
      chip.title = trait.prompt;
      chip.setAttribute('aria-pressed', selected.has(trait.id) ? 'true' : 'false');
      chip.textContent = trait.label;

      chip.addEventListener('click', () => {
        if (selected.has(trait.id)) {
          selected.delete(trait.id);
          chip.classList.remove('selected');
          chip.setAttribute('aria-pressed', 'false');
        } else {
          if (selected.size >= maxTraits) return;
          selected.add(trait.id);
          chip.classList.add('selected');
          chip.setAttribute('aria-pressed', 'true');
        }
        refreshCapState();
        saveProviderProfile(p.id, { traits: Array.from(selected) });
      });

      chipRegistry.push({ id: trait.id, el: chip });
      chipsRow.appendChild(chip);
    }

    catWrap.appendChild(chipsRow);
    traitsArea.appendChild(catWrap);
  }

  refreshCapState();
  card.appendChild(traitsArea);

  // Custom freeform textarea
  const customLabel = document.createElement('div');
  customLabel.className = 'provider-profile-sublabel';
  customLabel.textContent = 'Custom instructions (optional)';
  card.appendChild(customLabel);

  const customArea = document.createElement('textarea');
  customArea.className = 'provider-custom-textarea';
  customArea.rows = opts.tallTextarea ? 6 : 3;
  customArea.maxLength = maxCustom;
  customArea.placeholder = `Anything extra to say about how this model should behave. Up to ${maxCustom} chars.`;
  customArea.value = current.custom;
  let saveTimer = null;
  customArea.addEventListener('input', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveProviderProfile(p.id, { custom: customArea.value });
    }, 400);
  });
  card.appendChild(customArea);

  return card;
}

function renderSettingsProviders() {
  if (!settingsProviders) return;
  settingsProviders.innerHTML = '';
  for (const p of providers) {
    settingsProviders.appendChild(buildProviderProfileCard(p));
  }
}

// ============================================================
// Custom providers section in Settings
// ============================================================
const settingsCustomProviders = document.getElementById('settingsCustomProviders');
const settingsAddCustomProvider = document.getElementById('settingsAddCustomProvider');

function renderSettingsCustomProviders() {
  if (!settingsCustomProviders) return;
  settingsCustomProviders.innerHTML = '';
  const customs = (appSettings.customProviders || []).slice();
  const maxCustom = appSettings.limits?.maxCustomProviders || 8;

  if (!customs.length) {
    const empty = document.createElement('div');
    empty.className = 'custom-provider-empty';
    empty.textContent = 'No custom providers yet. Add one below.';
    settingsCustomProviders.appendChild(empty);
  } else {
    for (const cp of customs) settingsCustomProviders.appendChild(buildCustomProviderRow(cp));
  }

  if (settingsAddCustomProvider) {
    settingsAddCustomProvider.innerHTML = '';
    if (customs.length >= maxCustom) {
      const note = document.createElement('div');
      note.className = 'settings-hint';
      note.textContent = `Reached the maximum of ${maxCustom} custom providers.`;
      settingsAddCustomProvider.appendChild(note);
    } else {
      settingsAddCustomProvider.appendChild(buildCustomProviderForm(null));
    }
  }
}

function buildCustomProviderRow(cp) {
  const row = document.createElement('div');
  row.className = 'custom-provider-row';
  row.style.setProperty('--provider-color', cp.color || '#6d4ca8');

  const head = document.createElement('div');
  head.className = 'custom-provider-head';

  const badge = document.createElement('span');
  badge.className = 'provider-icon';
  badge.style.background = cp.color || '#6d4ca8';
  badge.textContent = (cp.shortLabel || cp.label || '?').slice(0, 2).toUpperCase();
  head.appendChild(badge);

  const titleWrap = document.createElement('div');
  titleWrap.className = 'custom-provider-title';
  const name = document.createElement('strong');
  name.textContent = cp.label;
  titleWrap.appendChild(name);
  const sub = document.createElement('small');
  sub.textContent = cp.kind === 'cli'
    ? `CLI - ${cp.command ? cp.command.slice(0, 60) + (cp.command.length > 60 ? '...' : '') : ''}`
    : `API ${cp.format || 'openai-chat'} - ${cp.endpoint || ''}`;
  titleWrap.appendChild(sub);
  head.appendChild(titleWrap);

  const actions = document.createElement('div');
  actions.className = 'custom-provider-actions';

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'ghost';
  testBtn.textContent = 'Test';
  testBtn.addEventListener('click', () => testCustomProvider(cp.id, testBtn));
  actions.appendChild(testBtn);

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'ghost';
  editBtn.textContent = 'Edit';
  editBtn.addEventListener('click', () => {
    if (row.querySelector('.custom-provider-form')) {
      row.querySelector('.custom-provider-form').remove();
    } else {
      row.appendChild(buildCustomProviderForm(cp));
    }
  });
  actions.appendChild(editBtn);

  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'ghost danger';
  delBtn.textContent = 'Delete';
  delBtn.addEventListener('click', () => deleteCustomProvider(cp.id));
  actions.appendChild(delBtn);

  head.appendChild(actions);
  row.appendChild(head);
  return row;
}

function buildCustomProviderForm(existing) {
  const form = document.createElement('div');
  form.className = 'custom-provider-form';

  const isEdit = !!existing;
  const data = existing || { kind: 'cli', color: '#6d4ca8' };

  const fields = {};
  function addField(key, labelText, opts = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'custom-provider-field';
    const lab = document.createElement('span');
    lab.textContent = labelText;
    wrap.appendChild(lab);
    let input;
    if (opts.type === 'select') {
      input = document.createElement('select');
      for (const o of opts.options) {
        const opt = document.createElement('option');
        opt.value = o.value; opt.textContent = o.label;
        if (o.value === (data[key] || opts.options[0].value)) opt.selected = true;
        input.appendChild(opt);
      }
    } else if (opts.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = opts.rows || 2;
      input.value = data[key] || '';
    } else {
      input = document.createElement('input');
      input.type = opts.type || 'text';
      input.value = data[key] || '';
      if (opts.placeholder) input.placeholder = opts.placeholder;
    }
    wrap.appendChild(input);
    if (opts.hint) {
      const hint = document.createElement('small');
      hint.className = 'custom-provider-hint';
      hint.textContent = opts.hint;
      wrap.appendChild(hint);
    }
    fields[key] = input;
    form.appendChild(wrap);
    return input;
  }

  addField('label', 'Display name', { placeholder: 'e.g. GLM 4.6' });
  addField('shortLabel', 'Short label', { placeholder: 'e.g. GLM' });
  addField('color', 'Color', { type: 'color' });
  addField('kind', 'Provider type', {
    type: 'select',
    options: [
      { value: 'cli', label: 'CLI command' },
      { value: 'api', label: 'HTTP API endpoint' },
    ],
  });

  const cliWrap = document.createElement('div');
  cliWrap.className = 'custom-provider-fields-cli';
  const apiWrap = document.createElement('div');
  apiWrap.className = 'custom-provider-fields-api';
  apiWrap.style.display = 'none';
  form.appendChild(cliWrap);
  form.appendChild(apiWrap);

  function addCliField(key, labelText, opts) {
    const orig = form.appendChild;
    let captured;
    form.appendChild = (el) => { captured = el; return el; };
    addField(key, labelText, opts);
    form.appendChild = orig;
    if (captured) cliWrap.appendChild(captured);
  }
  function addApiField(key, labelText, opts) {
    const orig = form.appendChild;
    let captured;
    form.appendChild = (el) => { captured = el; return el; };
    addField(key, labelText, opts);
    form.appendChild = orig;
    if (captured) apiWrap.appendChild(captured);
  }

  addCliField('command', 'Command template', {
    type: 'textarea',
    rows: 3,
    placeholder: 'e.g. glm chat --model glm-4.6 < {{PROMPT_FILE}}',
    hint: 'Placeholders: {{PROMPT_FILE}} - path to a temp file containing the prompt. {{OUT_FILE}} - if present, the reply is read from this file (otherwise stdout is used). The command is run via your shell.',
  });

  addApiField('endpoint', 'Endpoint URL', { placeholder: 'https://api.provider.com/v1/chat/completions' });
  addApiField('model', 'Model name', { placeholder: 'e.g. glm-4.6' });
  addApiField('apiKeyEnv', 'API key env var (optional)', {
    placeholder: 'e.g. GLM_API_KEY',
    hint: 'Name of the env var holding the API key. The key itself is never stored in LocalCouncil; it is read from the environment at request time. Leave blank if the endpoint does not require auth.',
  });
  addApiField('format', 'Request format', {
    type: 'select',
    options: [
      { value: 'openai-chat', label: 'OpenAI Chat Completions (/v1/chat/completions)' },
      { value: 'anthropic-messages', label: 'Anthropic Messages (/v1/messages)' },
    ],
  });

  function refreshKindVisibility() {
    const k = fields.kind.value;
    cliWrap.style.display = k === 'cli' ? '' : 'none';
    apiWrap.style.display = k === 'api' ? '' : 'none';
  }
  fields.kind.addEventListener('change', refreshKindVisibility);
  refreshKindVisibility();

  const buttons = document.createElement('div');
  buttons.className = 'custom-provider-form-actions';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'primary';
  saveBtn.textContent = isEdit ? 'Save changes' : 'Add provider';
  saveBtn.addEventListener('click', () => {
    const payload = {
      id: existing?.id,
      label: fields.label.value.trim(),
      shortLabel: fields.shortLabel.value.trim() || fields.label.value.trim().slice(0, 12),
      color: fields.color.value,
      kind: fields.kind.value,
      command: fields.command.value.trim(),
      endpoint: fields.endpoint.value.trim(),
      model: fields.model.value.trim(),
      apiKeyEnv: fields.apiKeyEnv.value.trim(),
      format: fields.format.value,
      enabled: existing?.enabled !== false,
    };
    if (!payload.label) { saveBtn.textContent = 'Label is required'; setTimeout(() => saveBtn.textContent = isEdit ? 'Save changes' : 'Add provider', 1500); return; }
    if (payload.kind === 'cli' && !payload.command) { saveBtn.textContent = 'Command is required'; setTimeout(() => saveBtn.textContent = isEdit ? 'Save changes' : 'Add provider', 1500); return; }
    if (payload.kind === 'api' && (!payload.endpoint || !/^https?:\/\//i.test(payload.endpoint))) { saveBtn.textContent = 'HTTP/S endpoint required'; setTimeout(() => saveBtn.textContent = isEdit ? 'Save changes' : 'Add provider', 1500); return; }
    saveCustomProvider(payload, isEdit);
  });
  buttons.appendChild(saveBtn);

  if (isEdit) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => form.remove());
    buttons.appendChild(cancelBtn);
  }
  form.appendChild(buttons);

  return form;
}

function saveCustomProvider(payload, isEdit) {
  const list = (appSettings.customProviders || []).slice();
  if (isEdit) {
    const idx = list.findIndex(p => p.id === payload.id);
    if (idx >= 0) list[idx] = { ...list[idx], ...payload };
    else list.push(payload);
    saveCouncilSettings({ customProviders: list });
  } else {
    list.push(payload);
    // For a newly added provider, auto-include it in activeProviders so it
    // actually joins the chat. The server generates its real id, so we wait
    // for the response and then enable on a second POST. (Two round trips
    // happens once per add, which is fine.)
    saveCouncilSettings({ customProviders: list }).then(() => {
      const newOne = (appSettings.customProviders || []).find(p =>
        p.label === payload.label && !(activeProviderIds().includes(p.id))
      );
      if (newOne) {
        const active = Array.from(new Set([...activeProviderIds(), newOne.id]));
        saveCouncilSettings({ activeProviders: active });
      }
    });
  }
}

function deleteCustomProvider(id) {
  const list = (appSettings.customProviders || []).filter(p => p.id !== id);
  saveCouncilSettings({ customProviders: list });
}

async function testCustomProvider(id, btn) {
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Testing...';
  try {
    const r = await fetch(`/api/custom-providers/${encodeURIComponent(id)}/test`, { method: 'POST' });
    const data = await r.json();
    if (r.ok && data.ok) {
      btn.textContent = `OK (${data.ms}ms)`;
    } else {
      btn.textContent = 'Failed';
      console.error('Custom provider test failed:', data);
      alert(`Test failed:\n\n${data.error || 'Unknown error'}`);
    }
  } catch (e) {
    btn.textContent = 'Failed';
    console.error(e);
    alert(`Test failed: ${e.message}`);
  } finally {
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }, 2000);
  }
}

// ============================================================
// Per-provider personality dialog (opened from routing chip click)
// ============================================================
let openProviderDialogId = null;
let providerDialogEl = null;

function openProviderDialog(providerId) {
  const p = providers.find(x => x.id === providerId);
  if (!p) return;
  openProviderDialogId = providerId;

  if (!providerDialogEl) {
    providerDialogEl = document.createElement('div');
    providerDialogEl.className = 'modal-backdrop provider-dialog-backdrop';
    providerDialogEl.setAttribute('role', 'dialog');
    providerDialogEl.setAttribute('aria-modal', 'true');
    providerDialogEl.addEventListener('click', (e) => {
      if (e.target === providerDialogEl) closeProviderDialog();
    });
    document.body.appendChild(providerDialogEl);
  }
  providerDialogEl.classList.remove('hidden');
  renderProviderDialog();
  document.addEventListener('keydown', providerDialogEscHandler);
}

function closeProviderDialog() {
  openProviderDialogId = null;
  if (providerDialogEl) providerDialogEl.classList.add('hidden');
  document.removeEventListener('keydown', providerDialogEscHandler);
}

function providerDialogEscHandler(e) {
  if (e.key === 'Escape') closeProviderDialog();
}

function renderProviderDialog() {
  if (!providerDialogEl || !openProviderDialogId) return;
  const p = providers.find(x => x.id === openProviderDialogId);
  if (!p) { closeProviderDialog(); return; }

  providerDialogEl.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'modal-card provider-dialog-card';
  card.style.setProperty('--provider-color', p.color || '#6d4ca8');

  const head = document.createElement('header');
  head.className = 'modal-header';
  const titleWrap = document.createElement('div');
  titleWrap.className = 'provider-dialog-title';
  titleWrap.appendChild(buildProviderBadge(p));
  const h2 = document.createElement('h2');
  h2.textContent = `Configure ${p.label}`;
  titleWrap.appendChild(h2);
  head.appendChild(titleWrap);

  const close = document.createElement('button');
  close.className = 'modal-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = 'x';
  close.addEventListener('click', closeProviderDialog);
  head.appendChild(close);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'provider-dialog-body';
  body.appendChild(buildProviderProfileCard(p, { tallTextarea: true }));
  card.appendChild(body);

  const foot = document.createElement('footer');
  foot.className = 'modal-footer';
  const done = document.createElement('button');
  done.className = 'primary';
  done.textContent = 'Done';
  done.addEventListener('click', closeProviderDialog);
  foot.appendChild(done);
  card.appendChild(foot);

  providerDialogEl.appendChild(card);
}

function saveProviderProfile(providerId, partial) {
  const existing = appSettings.providerProfiles?.[providerId] || { traits: [], custom: '' };
  const next = {
    traits: Array.isArray(partial.traits) ? partial.traits : existing.traits,
    custom: typeof partial.custom === 'string' ? partial.custom : existing.custom,
  };
  // Optimistic local update so any re-render in flight reflects the change
  // immediately and the chip's selected state never visually reverts.
  appSettings.providerProfiles = {
    ...(appSettings.providerProfiles || {}),
    [providerId]: next,
  };
  const p = providers.find(x => x.id === providerId);
  if (p) p.profile = next;
  renderProviderPanel();
  saveCouncilSettings({
    providerProfiles: { ...appSettings.providerProfiles },
  });
}

function applyCouncilSettings(data) {
  if (!data) return;
  providers = Array.isArray(data.providers) ? data.providers : providers;
  // Server now sends `traits`; older versions sent `personas` - support both.
  if (Array.isArray(data.traits)) personas = data.traits;
  else if (Array.isArray(data.personas)) personas = data.personas;
  modes = Array.isArray(data.modes) ? data.modes : modes;
  appSettings = {
    ...appSettings,
    activeProviders: Array.isArray(data.activeProviders) ? data.activeProviders : appSettings.activeProviders,
    providerProfiles: data.providerProfiles || appSettings.providerProfiles || {},
    customProviders: Array.isArray(data.customProviders) ? data.customProviders : appSettings.customProviders || [],
    stopRules: data.stopRules || appSettings.stopRules,
    conversationMode: data.conversationMode || appSettings.conversationMode,
    fallbackEnabled: typeof data.fallbackEnabled === 'boolean' ? data.fallbackEnabled : appSettings.fallbackEnabled,
    limits: data.limits || appSettings.limits,
  };

  for (const p of providers) {
    LABELS[p.id] = p.label;
    if (typeof busy[p.id] !== 'boolean') busy[p.id] = false;
  }

  if (groupToggle && typeof data.groupChat === 'boolean') groupToggle.checked = data.groupChat;
  if (fallbackToggle) fallbackToggle.checked = !!appSettings.fallbackEnabled;
  if (typeof data.maxChainTurns === 'number') maxTurnsInput.value = data.maxChainTurns;
  renderModeOptions(modeSelect);
  if (modeSelect) modeSelect.value = appSettings.conversationMode;
  renderProviderPanel();
  renderAskButtons();
  // Do not rebuild the settings/dialog trait UI while the user is actively
  // interacting with it (clicking chips, typing custom instructions) - a
  // rebuild would steal focus and feel like clicks are being dropped. The
  // optimistic local update in saveProviderProfile already keeps it in sync.
  if (!isInteractingWithProfileUI()) {
    renderSettingsProviders();
    renderSettingsCustomProviders();
    if (openProviderDialogId) renderProviderDialog();
  }
  updatePageHeader();
}

function isInteractingWithProfileUI() {
  const active = document.activeElement;
  if (!active) return false;
  return !!active.closest('.provider-dialog-card, .settings-providers, #settingsProviders');
}

async function saveCouncilSettings(partial) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(partial),
  });
  if (response.ok) {
    const data = await response.json();
    applyCouncilSettings(data);
  }
}

function isNearBottom(threshold = 80) {
  if (!feed) return true;
  return (feed.scrollHeight - feed.scrollTop - feed.clientHeight) < threshold;
}

// Tracks user's intent: true when they are at (or just left) the bottom of the
// feed, false when they have scrolled up to read older messages. Updated on
// every scroll event. Used so that a new message arriving while the user is
// reading mid-conversation does NOT yank the viewport down.
let followBottom = true;

function scrollToBottom() {
  if (!feed) return;
  feed.scrollTop = feed.scrollHeight;
  followBottom = true;
  hideNewMessagesPill();
}

let newMessagesPill = null;
function ensureNewMessagesPill() {
  if (newMessagesPill) return newMessagesPill;
  const pill = document.createElement('button');
  pill.id = 'newMessagesPill';
  pill.className = 'new-messages-pill hidden';
  pill.textContent = '↓ New messages';
  pill.addEventListener('click', scrollToBottom);
  // Anchor the pill inside the main column so it is centered relative to the
  // chat area (between the left chat-list sidebar and the right tasks sidebar),
  // not the entire viewport.
  const host = document.querySelector('.main-col') || document.body;
  host.appendChild(pill);
  newMessagesPill = pill;
  return pill;
}
function showNewMessagesPill() {
  ensureNewMessagesPill().classList.remove('hidden');
}
function hideNewMessagesPill() {
  if (newMessagesPill) newMessagesPill.classList.add('hidden');
}

// Client-side cache of the messages currently rendered in the feed, so the
// "Copy entire discussion" button can serialize the full thread without
// scraping the DOM. Populated by renderTranscript and renderMessage.
let currentMessages = [];

function renderMessage(m, opts = {}) {
  const div = document.createElement('div');
  div.className = `msg ${m.from}`;
  if (m.from === 'system' && isSystemErrorContent(m.content)) {
    div.classList.add('error');
  }
  const who = renderWho(m.from);
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = fmtTime(m.ts);
  who.appendChild(ts);
  div.appendChild(who);
  div.appendChild(renderBody(m.content, m.from));
  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  actions.appendChild(buildCopyButton(m));
  if (providerById(m.from) || m.from === 'arbiter') {
    actions.appendChild(buildSpeakButton(m));
  }
  div.appendChild(actions);
  feedInner.appendChild(div);
  if (!opts.skipMessageCache) currentMessages.push(m);
  ensureCopyAllAnchor();
  // Only auto-scroll if the user is actively following the bottom (i.e. has
  // not scrolled up to read earlier messages). Initial chat load passes
  // forceScroll=true to override this.
  if (opts.forceScroll || followBottom) {
    scrollToBottom();
  } else {
    showNewMessagesPill();
  }
}

let copyAllBtn = null;
function ensureCopyAllAnchor() {
  if (!feedInner) return;
  if (!copyAllBtn) {
    copyAllBtn = document.createElement('button');
    copyAllBtn.type = 'button';
    copyAllBtn.id = 'copyAllBtn';
    copyAllBtn.className = 'copy-all-btn';
    copyAllBtn.title = 'Copy the entire discussion as plain text';
    copyAllBtn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg><span>Copy entire discussion</span>';
    copyAllBtn.addEventListener('click', copyEntireDiscussion);
  }
  if (currentMessages.length > 0) {
    feedInner.appendChild(copyAllBtn);
    copyAllBtn.classList.remove('hidden');
  } else if (copyAllBtn.parentNode) {
    copyAllBtn.parentNode.removeChild(copyAllBtn);
  }
}

function textForFullTranscript() {
  const lines = [];
  for (const m of currentMessages) {
    const label = labelFor(m.from) || m.from;
    const time = m.ts ? fmtTime(m.ts) : '';
    lines.push(`[${label}${time ? ' ' + time : ''}]`);
    lines.push(textForCopy(m));
    lines.push('');
  }
  return lines.join('\n').trim();
}

async function copyEntireDiscussion() {
  if (!copyAllBtn) return;
  const text = textForFullTranscript();
  if (!text) return;
  const flash = (label) => {
    const span = copyAllBtn.querySelector('span');
    const original = span ? span.textContent : null;
    copyAllBtn.classList.add('copied');
    if (span) span.textContent = label;
    setTimeout(() => {
      copyAllBtn.classList.remove('copied');
      if (span && original !== null) span.textContent = original;
    }, 1400);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      flash('Copied!');
      return;
    }
  } catch (err) {
    console.warn('navigator.clipboard failed, falling back:', err);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); flash('Copied!'); }
  catch (e2) { console.error('Copy fallback failed:', e2); }
  document.body.removeChild(ta);
}

function textForCopy(m) {
  if (m.from === 'arbiter') {
    try {
      const data = JSON.parse(m.content);
      const lines = [];
      if (data.decision) lines.push(`Decision: ${data.decision}`);
      if (data.rationale) lines.push(`Rationale: ${data.rationale}`);
      if (Array.isArray(data.rejected_options) && data.rejected_options.length) {
        lines.push('Rejected:');
        for (const r of data.rejected_options) lines.push(`  - ${r}`);
      }
      if (Array.isArray(data.open_questions) && data.open_questions.length) {
        lines.push('Open questions:');
        for (const q of data.open_questions) lines.push(`  - ${q}`);
      }
      if (Array.isArray(data.next_tasks) && data.next_tasks.length) {
        lines.push('Next tasks:');
        for (const t of data.next_tasks) lines.push(`  - (${t.owner}) ${t.description}`);
      }
      return lines.join('\n') || m.content;
    } catch {
      return m.content;
    }
  }
  return m.content;
}

function buildCopyButton(m) {
  const btn = document.createElement('button');
  btn.className = 'msg-action-btn copy-btn';
  btn.type = 'button';
  btn.title = 'Copy message';
  btn.setAttribute('aria-label', 'Copy message');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = textForCopy(m);
    const flash = () => {
      btn.classList.add('copied');
      btn.title = 'Copied!';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.title = 'Copy message';
      }, 1200);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        flash();
        return;
      }
    } catch (err) {
      console.warn('navigator.clipboard failed, falling back:', err);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      flash();
    } catch (e2) {
      console.error('Copy fallback failed:', e2);
    }
    document.body.removeChild(ta);
  });
  return btn;
}

// ============================================================
// Text-to-speech (Web Speech API, browser-native)
// ============================================================

let cachedVoices = [];
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  cachedVoices = speechSynthesis.getVoices() || [];
}
if ('speechSynthesis' in window) {
  loadVoices();
  speechSynthesis.addEventListener('voiceschanged', loadVoices);
}

function getVoicePref(role) {
  try { return localStorage.getItem('voice.' + role) || null; } catch { return null; }
}
function setVoicePref(role, name) {
  try {
    if (name) localStorage.setItem('voice.' + role, name);
    else localStorage.removeItem('voice.' + role);
  } catch {}
}

function pickVoiceForRole(from) {
  if (!cachedVoices.length) loadVoices();
  if (!cachedVoices.length) return null;
  const pref = getVoicePref(from);
  if (pref) {
    const match = cachedVoices.find(v => v.name === pref);
    if (match) return match;
  }
  const english = cachedVoices.filter(v => v.lang && v.lang.toLowerCase().startsWith('en'));
  const pool = english.length ? english : cachedVoices;
  const find = (re) => pool.find(v => re.test(v.name || ''));
  if (from === 'claude') {
    return (
      find(/Google US English$/) ||
      find(/Microsoft .*Guy/i) ||
      find(/Microsoft .*Davis/i) ||
      find(/Microsoft .*Mark/i) ||
      find(/Daniel|Alex|Aaron/i) ||
      pool[0]
    );
  }
  if (from === 'codex') {
    return (
      find(/Microsoft .*Aria/i) ||
      find(/Microsoft .*Jenny/i) ||
      find(/Microsoft .*Zira/i) ||
      find(/Samantha|Victoria|Karen/i) ||
      find(/Google UK English Female/i) ||
      pool[pool.length > 1 ? 1 : 0]
    );
  }
  if (from === 'arbiter') {
    return (
      find(/Microsoft .*Sonia/i) ||
      find(/Microsoft .*Libby/i) ||
      find(/Tessa|Moira|Susan/i) ||
      pool[Math.min(2, pool.length - 1)]
    );
  }
  return pool[0];
}

function stripMarkdownForSpeech(text) {
  if (!text) return '';
  return text
    .replace(/```[\s\S]*?```/g, ' (code block omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunkTextForSpeech(text, max = 220) {
  const sentences = text.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g) || [text];
  const chunks = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > max && buf) {
      chunks.push(buf.trim());
      buf = s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
}

let activeSpeakBtn = null;
function clearSpeakingUi() {
  document.querySelectorAll('.speak-btn.speaking').forEach(b => b.classList.remove('speaking'));
  activeSpeakBtn = null;
}

function speakText(text, from, btn) {
  if (!('speechSynthesis' in window)) {
    alert('Your browser does not support speech synthesis.');
    return;
  }
  if (activeSpeakBtn === btn) {
    speechSynthesis.cancel();
    clearSpeakingUi();
    return;
  }
  speechSynthesis.cancel();
  clearSpeakingUi();

  const clean = stripMarkdownForSpeech(text);
  if (!clean) return;
  const chunks = chunkTextForSpeech(clean);
  const voice = pickVoiceForRole(from);

  let i = 0;
  let cancelled = false;
  function speakNext() {
    if (cancelled) return;
    if (i >= chunks.length) {
      if (btn) btn.classList.remove('speaking');
      if (activeSpeakBtn === btn) activeSpeakBtn = null;
      return;
    }
    const utt = new SpeechSynthesisUtterance(chunks[i++]);
    if (voice) utt.voice = voice;
    utt.rate = getSpeechRate();
    utt.pitch = 1.0;
    utt.volume = 1.0;
    utt.onend = speakNext;
    utt.onerror = () => {
      cancelled = true;
      if (btn) btn.classList.remove('speaking');
      if (activeSpeakBtn === btn) activeSpeakBtn = null;
    };
    speechSynthesis.speak(utt);
  }

  if (btn) btn.classList.add('speaking');
  activeSpeakBtn = btn;
  speakNext();
}

function textForSpeech(m) {
  if (m.from === 'arbiter') {
    try {
      const data = JSON.parse(m.content);
      const parts = [];
      if (data.decision) parts.push('Decision. ' + data.decision);
      if (data.rationale) parts.push('Rationale. ' + data.rationale);
      if (Array.isArray(data.open_questions) && data.open_questions.length) {
        parts.push('Open questions. ' + data.open_questions.join('. '));
      }
      if (Array.isArray(data.next_tasks) && data.next_tasks.length) {
        parts.push('Next tasks. ' + data.next_tasks.map(t => t.description).join('. '));
      }
      return parts.join(' ');
    } catch {
      return m.content;
    }
  }
  return m.content;
}

function buildSpeakButton(m) {
  const btn = document.createElement('button');
  btn.className = 'speak-btn';
  btn.type = 'button';
  btn.title = 'Speak this message';
  btn.setAttribute('aria-label', 'Speak this message');
  btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4.03v8.06A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06A7 7 0 0 1 19 12a7 7 0 0 1-5 6.71v2.06A9 9 0 0 0 21 12 9 9 0 0 0 14 3.23z"/></svg>';
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    speakText(textForSpeech(m), m.from, btn);
  });
  return btn;
}

window.addEventListener('beforeunload', () => {
  if ('speechSynthesis' in window) speechSynthesis.cancel();
});

// ============================================================
// Settings modal (chat + voices + speech)
// ============================================================
const settingsBtn = document.getElementById('settingsBtn');
const settingsModalBackdrop = document.getElementById('settingsModalBackdrop');
const settingsModalClose = document.getElementById('settingsModalClose');
const settingsDoneBtn = document.getElementById('settingsDoneBtn');
const voicesResetBtn = document.getElementById('voicesResetBtn');
const voicesPickers = document.getElementById('voicesPickers');
const settingsGroupChat = document.getElementById('settingsGroupChat');
const settingsMode = document.getElementById('settingsMode');
const settingsFallback = document.getElementById('settingsFallback');
const settingsMaxTurns = document.getElementById('settingsMaxTurns');
const settingsProviders = document.getElementById('settingsProviders');
const settingsRuntime = document.getElementById('settingsRuntime');
const settingsAgreement = document.getElementById('settingsAgreement');
const settingsErrors = document.getElementById('settingsErrors');
const settingsAutoArbitrate = document.getElementById('settingsAutoArbitrate');
const settingsRate = document.getElementById('settingsRate');
const settingsRateValue = document.getElementById('settingsRateValue');
const settingsAutoSpeak = document.getElementById('settingsAutoSpeak');

const VOICE_ROLES = [
  { key: 'claude', label: 'Opus 4.7 (Claude)', sample: 'Hello. I am Opus four point seven. I think we should weigh the trade-offs before committing.' },
  { key: 'codex',  label: 'GPT-5.5 (Codex)',   sample: 'Hi. I am GPT five point five. Let me play devil\'s advocate for a moment.' },
  { key: 'arbiter', label: 'Arbiter',          sample: 'Decision. We will proceed with the proposed plan. Rationale follows.' },
];

function getSpeechRate() {
  try {
    const v = parseFloat(localStorage.getItem('speech.rate'));
    if (Number.isFinite(v) && v >= 0.5 && v <= 2.0) return v;
  } catch {}
  return 1.0;
}
function setSpeechRate(v) {
  try { localStorage.setItem('speech.rate', String(v)); } catch {}
}
function getAutoSpeak() {
  try { return localStorage.getItem('speech.autoSpeak') === '1'; } catch { return false; }
}
function setAutoSpeak(v) {
  try { localStorage.setItem('speech.autoSpeak', v ? '1' : '0'); } catch {}
}

function openSettingsModal() {
  if (!settingsModalBackdrop) return;
  loadVoices();
  renderVoicePickers();
  renderModeOptions(settingsMode);
  if (settingsMode) settingsMode.value = appSettings.conversationMode || 'debate';
  if (settingsGroupChat) settingsGroupChat.checked = !!groupToggle.checked;
  if (settingsFallback) settingsFallback.checked = !!appSettings.fallbackEnabled;
  if (settingsMaxTurns) settingsMaxTurns.value = maxTurnsInput.value || '50';
  if (settingsRuntime) settingsRuntime.value = appSettings.stopRules?.maxRuntimeMinutes || 8;
  if (settingsAgreement) settingsAgreement.value = appSettings.stopRules?.stopAfterAgreementTurns ?? 2;
  if (settingsErrors) settingsErrors.value = appSettings.stopRules?.maxConsecutiveErrors || 2;
  if (settingsAutoArbitrate) settingsAutoArbitrate.checked = appSettings.stopRules?.autoArbitrate !== false;
  renderSettingsProviders();
  const r = getSpeechRate();
  if (settingsRate) settingsRate.value = String(r);
  if (settingsRateValue) settingsRateValue.textContent = r.toFixed(2) + '×';
  if (settingsAutoSpeak) settingsAutoSpeak.checked = getAutoSpeak();
  settingsModalBackdrop.classList.remove('hidden');
}
function closeSettingsModal() {
  if (!settingsModalBackdrop) return;
  settingsModalBackdrop.classList.add('hidden');
  speechSynthesis.cancel();
  clearSpeakingUi();
}

function renderVoicePickers() {
  if (!voicesPickers) return;
  voicesPickers.innerHTML = '';
  const voicesList = cachedVoices.slice().sort((a, b) => {
    const aE = (a.lang || '').toLowerCase().startsWith('en') ? 0 : 1;
    const bE = (b.lang || '').toLowerCase().startsWith('en') ? 0 : 1;
    if (aE !== bE) return aE - bE;
    return (a.name || '').localeCompare(b.name || '');
  });

  for (const role of VOICE_ROLES) {
    const row = document.createElement('div');
    row.className = 'voice-row';

    const label = document.createElement('label');
    label.className = 'voice-row-label';
    label.textContent = role.label;
    row.appendChild(label);

    const select = document.createElement('select');
    select.className = 'voice-select';
    const autoOpt = document.createElement('option');
    autoOpt.value = '';
    autoOpt.textContent = '(auto)';
    select.appendChild(autoOpt);
    for (const v of voicesList) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = `${v.name} - ${v.lang}${v.localService ? '' : ' / cloud'}`;
      select.appendChild(opt);
    }
    const currentPref = getVoicePref(role.key);
    select.value = currentPref || '';
    select.addEventListener('change', () => {
      setVoicePref(role.key, select.value || null);
    });
    row.appendChild(select);

    const testBtn = document.createElement('button');
    testBtn.className = 'voice-test-btn';
    testBtn.type = 'button';
    testBtn.textContent = 'Test';
    testBtn.addEventListener('click', () => {
      speechSynthesis.cancel();
      clearSpeakingUi();
      const voiceName = select.value;
      const voice = voiceName ? cachedVoices.find(v => v.name === voiceName) : pickVoiceForRole(role.key);
      const utt = new SpeechSynthesisUtterance(role.sample);
      if (voice) utt.voice = voice;
      utt.rate = getSpeechRate();
      speechSynthesis.speak(utt);
    });
    row.appendChild(testBtn);

    voicesPickers.appendChild(row);
  }
}

if (settingsBtn) settingsBtn.addEventListener('click', openSettingsModal);
if (settingsModalClose) settingsModalClose.addEventListener('click', closeSettingsModal);
if (settingsDoneBtn) settingsDoneBtn.addEventListener('click', closeSettingsModal);
if (voicesResetBtn) {
  voicesResetBtn.addEventListener('click', () => {
    for (const role of VOICE_ROLES) setVoicePref(role.key, null);
    renderVoicePickers();
  });
}
if (settingsGroupChat) {
  settingsGroupChat.addEventListener('change', () => {
    groupToggle.checked = settingsGroupChat.checked;
    setGroupChat();
  });
}
if (settingsMode) {
  settingsMode.addEventListener('change', () => {
    if (modeSelect) modeSelect.value = settingsMode.value;
    setConversationMode(settingsMode.value);
  });
}
if (settingsFallback) {
  settingsFallback.addEventListener('change', () => {
    if (fallbackToggle) fallbackToggle.checked = settingsFallback.checked;
    saveCouncilSettings({ fallbackEnabled: settingsFallback.checked });
  });
}
if (settingsMaxTurns) {
  settingsMaxTurns.addEventListener('change', () => {
    maxTurnsInput.value = settingsMaxTurns.value;
    setMaxTurns();
  });
}
function saveStopRulesFromSettings() {
  saveCouncilSettings({
    stopRules: {
      maxRuntimeMinutes: parseInt(settingsRuntime?.value || '8', 10),
      stopAfterAgreementTurns: parseInt(settingsAgreement?.value || '2', 10),
      maxConsecutiveErrors: parseInt(settingsErrors?.value || '2', 10),
      autoArbitrate: !!settingsAutoArbitrate?.checked,
    },
  });
}
for (const el of [settingsRuntime, settingsAgreement, settingsErrors, settingsAutoArbitrate]) {
  if (el) el.addEventListener('change', saveStopRulesFromSettings);
}
if (settingsRate) {
  settingsRate.addEventListener('input', () => {
    const v = parseFloat(settingsRate.value);
    if (Number.isFinite(v)) {
      setSpeechRate(v);
      if (settingsRateValue) settingsRateValue.textContent = v.toFixed(2) + '×';
    }
  });
}
if (settingsAutoSpeak) {
  settingsAutoSpeak.addEventListener('change', () => {
    setAutoSpeak(settingsAutoSpeak.checked);
  });
}
if (settingsModalBackdrop) {
  settingsModalBackdrop.addEventListener('click', (e) => {
    if (e.target === settingsModalBackdrop) closeSettingsModal();
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsModalBackdrop && !settingsModalBackdrop.classList.contains('hidden')) {
    closeSettingsModal();
  }
});

function renderTranscript(messages) {
  seenSystemErrorKeys = new Set();
  currentMessages = [];
  feedInner.innerHTML = '';
  for (const m of messages) renderMessage(m, { forceScroll: true });
  ensureCopyAllAnchor();
  scrollToBottom();
}

function renderChatList(list) {
  chatList.innerHTML = '';
  for (const c of list) {
    const li = document.createElement('li');
    const isActive = c.id === currentId;
    const isBusy = c.busy && Object.values(c.busy).some(Boolean);
    li.className = 'chat-item' + (isActive ? ' active' : '') + (isBusy ? ' busy' : '');
    li.dataset.id = c.id;
    li.title = 'Double-click to rename';

    const titleRow = document.createElement('div');
    titleRow.className = 'chat-title-row';
    if (isBusy) {
      const dot = document.createElement('span');
      dot.className = 'chat-busy-dot';
      dot.title = 'Chain in progress';
      titleRow.appendChild(dot);
    }

    const title = document.createElement('span');
    title.className = 'chat-title';
    title.textContent = c.title || '(new chat)';
    titleRow.appendChild(title);

    const meta = document.createElement('span');
    meta.className = 'chat-meta';
    const time = document.createElement('span');
    time.textContent = fmtRelative(c.updatedAt);
    const count = document.createElement('span');
    count.textContent = `${c.messageCount} msg`;
    meta.appendChild(time);
    meta.appendChild(count);

    const del = document.createElement('button');
    del.className = 'chat-delete';
    del.title = 'Delete chat';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChat(c.id, c.title);
    });

    li.appendChild(titleRow);
    li.appendChild(meta);
    li.appendChild(del);
    li.addEventListener('click', () => selectChat(c.id));
    li.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      beginInlineRename(c.id, c.title || '', title);
    });
    chatList.appendChild(li);
  }
}

window.addEventListener('popstate', () => {
  const slug = getSlugFromUrl();
  const target = slug ? findConvByShort(slug) : null;
  if (target && target.id !== currentId) loadChat(target.id, { skipUrl: true });
});

let busyStartedAt = {};
let thinkingTicker = null;

function renderStatus() {
  const thinking = [];
  for (const id of Object.keys(busy)) {
    if (busy[id]) thinking.push(labelFor(id));
  }
  if (thinking.length === 0) {
    status.textContent = '';
    if (thinkingTicker) { clearInterval(thinkingTicker); thinkingTicker = null; }
    return;
  }
  const now = Date.now();
  for (const id of Object.keys(busy)) {
    if (busy[id] && !busyStartedAt[id]) busyStartedAt[id] = now;
    if (!busy[id]) busyStartedAt[id] = 0;
  }
  const elapsed = Math.max(...Object.keys(busy).map(id => busy[id] ? Math.floor((now - busyStartedAt[id]) / 1000) : 0));
  const elapsedTxt = elapsed > 0 ? ` <span class="thinking-time">${elapsed}s</span>` : '';
  status.innerHTML = `<span class="thinking"><span class="dot"></span>${thinking.join(' and ')} thinking...${elapsedTxt}</span>`;
  if (!thinkingTicker) {
    thinkingTicker = setInterval(renderStatus, 1000);
  }
}

function updateButtons() {
  const anyRunningTask = (currentTasks || []).some(t => t.status === 'running');
  const disabled = !(Object.values(busy).some(Boolean) || anyRunningTask);
  if (stopBtn) stopBtn.disabled = disabled;
  const footer = document.getElementById('stopBtnFooter');
  if (footer) footer.disabled = disabled;
  renderAskButtons();
}

let conversationList = [];

function getSlugFromUrl() {
  const m = location.pathname.match(/^\/c\/([a-z0-9-]+)/i);
  return m ? m[1] : null;
}

function findConvByShort(short) {
  if (!short) return null;
  for (const c of conversationList) {
    if (c.id.startsWith(short) || c.id === short) return c;
  }
  return null;
}

function urlForConv(id) {
  return '/c/' + id.slice(0, 8);
}

async function loadChat(id, options = {}) {
  if (!id) return;
  currentId = id;
  try {
    const r = await fetch(`/api/conversations/${id}`);
    if (!r.ok) {
      console.error(`Failed to load chat ${id}:`, r.status);
      return;
    }
    const data = await r.json();
    if (data.settings) applyCouncilSettings(data.settings);
    currentGoal = data.goal || null;
    currentTasks = Array.isArray(data.tasks) ? data.tasks : [];
    // Reset busy start times on chat switch so the elapsed counter reflects
    // time in THIS chat, not a stale carry-over from another conversation.
    // Also clear any provider busy flag that the new chat does not explicitly
    // mark true (so a thinking flag from chat A does not leak into chat B).
    busyStartedAt = {};
    const incomingBusy = data.busy || {};
    const now = Date.now();
    for (const id of Object.keys(busy)) busy[id] = false;
    for (const id of Object.keys(incomingBusy)) {
      busy[id] = !!incomingBusy[id];
      if (busy[id]) busyStartedAt[id] = now;
    }
    goalInput.value = currentGoal || '';
    renderTranscript(data.messages || []);
    renderTasks();
    renderChatList(conversationList);
    renderStatus();
    updateButtons();
    updatePageHeader();
  } catch (e) {
    console.error('loadChat failed:', e);
  }
  if (!options.skipUrl) {
    const target = urlForConv(id);
    if (location.pathname !== target) {
      history.pushState({ id }, '', target);
    }
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'init') {
      conversationList = Array.isArray(msg.list) ? msg.list : [];
      applyCouncilSettings(msg);
      renderChatList(conversationList);
      const slug = getSlugFromUrl();
      let target = slug ? findConvByShort(slug) : null;
      if (!target) target = conversationList[0];
      if (target) loadChat(target.id, { skipUrl: !!slug });
    } else if (msg.type === 'message') {
      if (msg.conversationId === currentId) {
        renderMessage(msg);
        if (getAutoSpeak() && (providerById(msg.from) || msg.from === 'arbiter')) {
          const last = feedInner.lastElementChild;
          const btn = last ? last.querySelector('.speak-btn') : null;
          speakText(textForSpeech(msg), msg.from, btn);
        }
      }
    } else if (msg.type === 'busy') {
      if (msg.conversationId === currentId) {
        busy[msg.who] = msg.busy;
        renderStatus();
        updateButtons();
        renderAskButtons();
      }
    } else if (msg.type === 'switched') {
      if (msg.conversationId === currentId) {
        renderTranscript(msg.transcript || []);
        if (msg.tasks) { currentTasks = msg.tasks; renderTasks(); }
        if (typeof msg.goal !== 'undefined') {
          currentGoal = msg.goal || null;
          if (document.activeElement !== goalInput) goalInput.value = currentGoal || '';
        }
      }
    } else if (msg.type === 'conversation-list') {
      conversationList = Array.isArray(msg.list) ? msg.list : [];
      renderChatList(conversationList);
      updatePageHeader();
    } else if (msg.type === 'mode') {
      applyCouncilSettings(msg);
    } else if (msg.type === 'settings') {
      applyCouncilSettings(msg);
    } else if (msg.type === 'provider-health') {
      if (Array.isArray(msg.providers)) applyCouncilSettings({ providers: msg.providers });
    } else if (msg.type === 'goal-updated') {
      if (msg.conversationId === currentId) {
        currentGoal = msg.goal || null;
        if (document.activeElement !== goalInput) goalInput.value = currentGoal || '';
        updatePageHeader();
      }
    } else if (msg.type === 'task-updated') {
      if (msg.conversationId === currentId && msg.task) upsertTask(msg.task);
    } else if (msg.type === 'task-deleted') {
      if (msg.conversationId === currentId) {
        currentTasks = currentTasks.filter(t => t.id !== msg.taskId);
        renderTasks();
      }
    } else if (msg.type === 'task-event') {
      if (msg.conversationId === currentId) appendTaskEvent(msg.taskId, msg.event);
    }
  };
  ws.onclose = () => {
    status.textContent = 'Disconnected. Retrying...';
    setTimeout(connectWs, 1500);
  };
}

async function sendUserMessage() {
  const content = input.value.trim();
  if (!content || !currentId) return;
  input.value = '';
  await fetch('/api/user-message', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, conversationId: currentId }),
  });
}

async function ask(who) {
  if (!currentId) return;
  if (busy[who]) return;
  await fetch('/api/invoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ who, conversationId: currentId }),
  });
}

async function clearChat() {
  if (!confirm('Clear this conversation\'s messages?\n(Keeps the chat in the sidebar but wipes its contents.)')) return;
  await fetch(`/api/conversations/${currentId}/clear`, { method: 'POST' });
}

async function setGroupChat() {
  const r = await fetch('/api/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupChat: groupToggle.checked, conversationMode: appSettings.conversationMode }),
  });
  if (r.ok) applyCouncilSettings(await r.json());
}

async function setConversationMode(mode) {
  const r = await fetch('/api/mode', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ groupChat: groupToggle.checked, conversationMode: mode }),
  });
  if (r.ok) applyCouncilSettings(await r.json());
}

async function setMaxTurns() {
  const v = parseInt(maxTurnsInput.value, 10);
  if (!Number.isFinite(v) || v < 1) return;
  const r = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ maxChainTurns: v }),
  });
  if (r.ok) applyCouncilSettings(await r.json());
}

async function newChat() {
  const r = await fetch('/api/conversations/new', { method: 'POST' });
  if (!r.ok) return;
  const data = await r.json();
  if (data && data.id) {
    await loadChat(data.id);
  }
}

async function saveGoal() {
  const goal = goalInput.value.trim();
  currentGoal = goal || null;
  updatePageHeader();
  await fetch(`/api/conversations/${currentId}/goal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ goal }),
  });
  flashGoalSaved();
}

async function runArbiter() {
  if (!currentId) return;
  const realMsgCount = feedInner.querySelectorAll('.msg:not(.system)').length;
  if (realMsgCount === 0) {
    const goal = (currentGoal || goalInput.value || '').trim();
    if (!goal) {
      alert('Set a goal first, then click Synthesize to kick off the discussion.');
      goalInput.focus();
      return;
    }
    await fetch('/api/user-message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content: `Let's begin. The goal of this chat: ${goal}\n\nBoth of you, share your initial framing and where you'd start. Don't agree just to agree, bring different angles.`,
        conversationId: currentId,
      }),
    });
    return;
  }
  await fetch(`/api/conversations/${currentId}/run-arbiter`, { method: 'POST' });
}

async function selectChat(id) {
  if (id === currentId) return;
  await loadChat(id);
}

async function deleteChat(id, title) {
  if (!confirm(`Delete chat "${title || '(new chat)'}"? This cannot be undone.`)) return;
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  if (id === currentId) {
    const next = conversationList.find(c => c.id !== id);
    if (next) await loadChat(next.id);
  }
}

sendBtn.addEventListener('click', sendUserMessage);
clearBtn.addEventListener('click', clearChat);
groupToggle.addEventListener('change', setGroupChat);
maxTurnsInput.addEventListener('change', setMaxTurns);
if (modeSelect) modeSelect.addEventListener('change', () => setConversationMode(modeSelect.value));
if (fallbackToggle) fallbackToggle.addEventListener('change', () => saveCouncilSettings({ fallbackEnabled: fallbackToggle.checked }));
newChatBtn.addEventListener('click', newChat);

if (tasksToggleBtn) {
  tasksToggleBtn.addEventListener('click', () => {
    tasksCollapsed = !tasksCollapsed;
    tasksToggleBtn.textContent = tasksCollapsed ? 'Show' : 'Hide';
    tasksSidebar.classList.toggle('collapsed', tasksCollapsed);
  });
}

// Resizable tasks sidebar
const TASKS_SIDEBAR_MIN = 260;
const TASKS_SIDEBAR_DEFAULT = 340;
const tasksResizeHandle = document.getElementById('tasksResizeHandle');

function clampTasksSidebarWidth(w) {
  const max = Math.max(TASKS_SIDEBAR_MIN, Math.floor(window.innerWidth * 0.7));
  return Math.max(TASKS_SIDEBAR_MIN, Math.min(max, w));
}

function applyTasksSidebarWidth(w) {
  if (!tasksSidebar) return;
  const clamped = clampTasksSidebarWidth(w);
  tasksSidebar.style.width = clamped + 'px';
  return clamped;
}

(function initTasksSidebarWidth() {
  try {
    const saved = parseInt(localStorage.getItem('tasksSidebarWidth') || '', 10);
    if (Number.isFinite(saved) && saved >= TASKS_SIDEBAR_MIN) {
      applyTasksSidebarWidth(saved);
    } else {
      applyTasksSidebarWidth(TASKS_SIDEBAR_DEFAULT);
    }
  } catch {
    applyTasksSidebarWidth(TASKS_SIDEBAR_DEFAULT);
  }
})();

if (tasksResizeHandle) {
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  const onMouseMove = (e) => {
    if (!dragging) return;
    const delta = startX - e.clientX;
    const next = startWidth + delta;
    applyTasksSidebarWidth(next);
  };
  const onMouseUp = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('is-resizing-tasks');
    tasksResizeHandle.classList.remove('dragging');
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    try {
      const w = parseInt(tasksSidebar.style.width, 10);
      if (Number.isFinite(w)) localStorage.setItem('tasksSidebarWidth', String(w));
    } catch {}
  };
  tasksResizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startWidth = tasksSidebar.getBoundingClientRect().width;
    document.body.classList.add('is-resizing-tasks');
    tasksResizeHandle.classList.add('dragging');
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
  tasksResizeHandle.addEventListener('dblclick', () => {
    applyTasksSidebarWidth(TASKS_SIDEBAR_DEFAULT);
    try { localStorage.setItem('tasksSidebarWidth', String(TASKS_SIDEBAR_DEFAULT)); } catch {}
  });
}

window.addEventListener('resize', () => {
  if (!tasksSidebar) return;
  const cur = tasksSidebar.getBoundingClientRect().width;
  applyTasksSidebarWidth(cur);
});

function flashGoalSaved() {
  if (!goalSaved) return;
  goalSaved.classList.add('visible');
  if (goalSavedTimer) clearTimeout(goalSavedTimer);
  goalSavedTimer = setTimeout(() => goalSaved.classList.remove('visible'), 1500);
}

function updatePageHeader() {
  if (!pageTitleText) return;
  const goal = (currentGoal || '').trim();
  const conv = conversationList.find(c => c.id === currentId);
  const chatTitle = (conv && conv.title) ? conv.title : '';

  // Browser tab title: always prefer the chat title (the short name in the
  // sidebar). The full goal is too long for a tab and confusing across many
  // tabs - the chat title is the durable identifier.
  if (chatTitle) document.title = chatTitle + ' - LocalCouncil';
  else if (goal) document.title = (goal.length > 60 ? goal.slice(0, 60) + '...' : goal) + ' - LocalCouncil';
  else document.title = 'LocalCouncil';

  if (goal) {
    // Goal-as-H1 on the page. Hide the secondary line so the header is not
    // cluttered with a mode badge ("Debate") next to the goal.
    pageTitleText.textContent = goal;
    pageTitleText.classList.add('is-goal');
    if (pageSub) pageSub.classList.add('hidden');
  } else if (chatTitle) {
    pageTitleText.textContent = chatTitle;
    pageTitleText.classList.remove('is-goal');
    if (pageSub) {
      pageSub.classList.remove('hidden');
      pageSub.textContent = providers.filter(p => p.enabled).map(p => p.shortLabel || p.label).join(' / ') || 'LocalCouncil';
    }
  } else {
    pageTitleText.textContent = 'LocalCouncil';
    pageTitleText.classList.remove('is-goal');
    if (pageSub) {
      pageSub.classList.remove('hidden');
      pageSub.textContent = providers.filter(p => p.enabled).map(p => p.shortLabel || p.label).join(' / ') || 'LocalCouncil';
    }
  }
}

function updateStopButton() {
  const anyRunningTask = (currentTasks || []).some(t => t.status === 'running');
  const disabled = !(Object.values(busy).some(Boolean) || anyRunningTask);
  if (stopBtn) stopBtn.disabled = disabled;
  const footer = document.getElementById('stopBtnFooter');
  if (footer) footer.disabled = disabled;
}

async function stopEverything() {
  if (!currentId) return;
  await fetch('/api/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: currentId }),
  });
}

async function renameChat(id, newTitle) {
  await fetch(`/api/conversations/${id}/rename`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
}

function beginInlineRename(id, oldTitle, titleEl) {
  if (!titleEl) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'chat-rename-input';
  input.value = oldTitle || '';
  input.maxLength = 200;
  const parent = titleEl.parentElement;
  parent.replaceChild(input, titleEl);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    input.removeEventListener('blur', onBlur);
    input.removeEventListener('keydown', onKey);
    if (commit) {
      const next = input.value.trim();
      if (next && next !== oldTitle) await renameChat(id, next);
    }
  };
  const onBlur = () => finish(true);
  const onKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); done = true; input.removeEventListener('blur', onBlur); input.removeEventListener('keydown', onKey); }
  };
  input.addEventListener('blur', onBlur);
  input.addEventListener('keydown', onKey);
}

if (stopBtn) stopBtn.addEventListener('click', stopEverything);
const stopBtnFooter = document.getElementById('stopBtnFooter');
if (stopBtnFooter) stopBtnFooter.addEventListener('click', stopEverything);

goalInput.addEventListener('input', () => {
  if (goalSaveTimer) clearTimeout(goalSaveTimer);
  goalSaveTimer = setTimeout(saveGoal, 600);
});
goalInput.addEventListener('blur', () => {
  if (goalSaveTimer) { clearTimeout(goalSaveTimer); goalSaveTimer = null; }
  saveGoal();
});
runArbiterBtn.addEventListener('click', runArbiter);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendUserMessage();
  }
});

if (feed) {
  feed.addEventListener('scroll', () => {
    // Update the user's bottom-following intent. A relatively generous threshold
    // (160px) so reading the most recent message still counts as following.
    followBottom = isNearBottom(160);
    if (followBottom) hideNewMessagesPill();
  });
}

connectWs();
