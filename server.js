import express from 'express';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import {
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
  readdirSync,
  mkdirSync,
} from 'fs';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 5757;
const HOST = '127.0.0.1';

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason?.stack || reason?.message || reason);
});
// Generous chat timeout: models doing deep research or reading material
// can legitimately take several minutes. Stop button kills hung calls.
const CLI_TIMEOUT_MS = 15 * 60 * 1000;
const WORKER_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_TURNS = 50;
const MAX_TURNS_CEILING = 100;
const APP_DATA_DIR = join(__dirname, 'data');
const DATA_DIR = join(APP_DATA_DIR, 'conversations');
const WORKSPACES_DIR = join(__dirname, 'workspaces');
const SETTINGS_FILE = join(APP_DATA_DIR, 'settings.json');

mkdirSync(APP_DATA_DIR, { recursive: true });
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(WORKSPACES_DIR, { recursive: true });

const PERSONAS = [
  // Thinking style
  {
    id: 'strategist',
    label: 'Strategist',
    icon: 'ST',
    category: 'thinking',
    prompt: 'Think in leverage, sequencing, and second-order effects. Push for a concrete strategic choice when the discussion drifts.',
  },
  {
    id: 'skeptic',
    label: 'Skeptic',
    icon: 'SK',
    category: 'thinking',
    prompt: 'Find weak assumptions, hidden risks, unsupported claims, and false certainty. Be precise, not contrarian for sport.',
  },
  {
    id: 'operator',
    label: 'Operator',
    icon: 'OP',
    category: 'thinking',
    prompt: 'Turn discussion into executable steps, owners, acceptance criteria, and short paths to a shipped result.',
  },
  {
    id: 'researcher',
    label: 'Researcher',
    icon: 'RS',
    category: 'thinking',
    prompt: 'Separate verified facts from inference. Ask what evidence would change the answer and prefer current sources when facts can drift.',
  },
  {
    id: 'historian',
    label: 'Historian',
    icon: 'HI',
    category: 'thinking',
    prompt: 'Use precedent, cycles, incentives, and past analogies carefully. Name where an analogy breaks.',
  },
  {
    id: 'analytical',
    label: 'Analytical',
    icon: 'AN',
    category: 'thinking',
    prompt: 'Decompose claims into their parts. Trace assumptions to conclusions step by step and surface the load-bearing piece.',
  },
  {
    id: 'numerate',
    label: 'Numerate',
    icon: 'NU',
    category: 'thinking',
    prompt: 'Lead with numbers, base rates, magnitudes, and comparisons when available. Call out unit confusions and missing denominators.',
  },
  {
    id: 'creative',
    label: 'Creative',
    icon: 'CR',
    category: 'thinking',
    prompt: 'Propose novel angles, lateral analogies, and unconventional reframings. Generate at least one option the group has not considered.',
  },
  {
    id: 'pragmatic',
    label: 'Pragmatic',
    icon: 'PR',
    category: 'thinking',
    prompt: 'Weigh trade-offs and feasibility before purity. Favor the option that ships within the constraints actually present.',
  },
  // Disposition
  {
    id: 'challenger',
    label: 'Challenger',
    icon: 'CH',
    category: 'disposition',
    prompt: 'Actively push back on the group consensus when the case for it is weak. Never default to agreement. If you have nothing to disagree with, name the strongest counter-argument anyway.',
  },
  {
    id: 'contrarian',
    label: 'Contrarian',
    icon: 'CN',
    category: 'disposition',
    prompt: 'Argue the opposite of what the group seems to want, in good faith. Take the unfashionable side and defend it as well as you can.',
  },
  {
    id: 'decisive',
    label: 'Decisive',
    icon: 'DE',
    category: 'disposition',
    prompt: 'Always end your turn with a clear recommendation, choice, or next step. Resist hedging. If forced to pick, pick.',
  },
  {
    id: 'risk-aware',
    label: 'Risk-aware',
    icon: 'RA',
    category: 'disposition',
    prompt: 'Name failure modes, blast radius, and what would change the answer. Distinguish recoverable from unrecoverable mistakes.',
  },
  {
    id: 'optimistic',
    label: 'Optimistic',
    icon: 'OT',
    category: 'disposition',
    prompt: 'Look for upside, what could go right, and reasons a plan would succeed. Steelman the bull case before critiquing it.',
  },
  {
    id: 'cofounder',
    label: 'Co-founder',
    icon: 'CF',
    category: 'disposition',
    prompt: 'Treat this project as if you have personal skin in the game and your reputation rides on it shipping and succeeding. Care about the outcome, not just answering the current question. Volunteer the next thing the user should worry about even if they did not ask. Push for the highest-leverage move and challenge the user directly when they are wrong - the way an invested partner would. Reference earlier decisions in this chat, hold the user accountable to them, and notice when momentum is stalling.',
  },
  // Communication style
  {
    id: 'diplomatic',
    label: 'Diplomatic',
    icon: 'DP',
    category: 'communication',
    prompt: 'Disagree without escalating. Address ideas, not the person. Acknowledge what was right in the other position before refining it.',
  },
  {
    id: 'blunt',
    label: 'Blunt',
    icon: 'BL',
    category: 'communication',
    prompt: 'Say what you mean without softening, hedging, or excessive politeness. Short sentences. Disagree directly when you disagree.',
  },
  {
    id: 'concise',
    label: 'Concise',
    icon: 'CO',
    category: 'communication',
    prompt: 'Compress sharply. Cut filler, throat-clearing, and recap. Aim for the shortest turn that carries real content.',
  },
  {
    id: 'thorough',
    label: 'Thorough',
    icon: 'TH',
    category: 'communication',
    prompt: 'Cover edge cases, second-order effects, and what could be missing. Prefer completeness when the question is consequential.',
  },
  {
    id: 'pedagogical',
    label: 'Pedagogical',
    icon: 'PD',
    category: 'communication',
    prompt: 'Explain so a smart non-expert can follow. Define terms inline. Use a small concrete example when the abstraction is dense.',
  },
  {
    id: 'empathetic',
    label: 'Empathetic',
    icon: 'EM',
    category: 'communication',
    prompt: 'Notice and name the underlying concern, feeling, or motivation behind a position. Respond to the person, not just the words.',
  },
  {
    id: 'marketer',
    label: 'Marketer',
    icon: 'MK',
    prompt: 'Look for distribution, positioning, message-market fit, and the shortest route to paid or behavioral signal.',
  },
];

const PERSONA_BY_ID = Object.fromEntries(PERSONAS.map(p => [p.id, p]));

const CONVERSATION_MODES = [
  {
    id: 'debate',
    label: 'Debate',
    description: 'Selected models answer, then challenge each other until stop rules fire.',
    prompt: 'Mode: Debate. Challenge weak claims, add missing angles, and avoid empty agreement.',
    autoChain: true,
    startAll: true,
    autoArbitrate: false,
  },
  {
    id: 'council',
    label: 'Council',
    description: 'Selected models each answer once, then the arbiter synthesizes.',
    prompt: 'Mode: Council. Give your best independent judgment. Do not debate unless directly invoked later.',
    autoChain: false,
    startAll: true,
    autoArbitrate: true,
  },
  {
    id: 'fast',
    label: 'Fast Answer',
    description: 'Use the first healthy provider only for quick answers.',
    prompt: 'Mode: Fast answer. Be concise, direct, and answer the user with minimal debate.',
    autoChain: false,
    startAll: false,
    autoArbitrate: false,
  },
  {
    id: 'review',
    label: 'Review',
    description: 'One model proposes, the next model critiques, then the chain stops.',
    prompt: 'Mode: Review. If you are first, propose. If you are responding, review the previous answer for flaws and improvements.',
    autoChain: true,
    startAll: false,
    autoArbitrate: true,
    maxTurnsOverride: 2,
  },
  {
    id: 'executor',
    label: 'Executor',
    description: 'Focus the council on tasks, artifacts, owners, and verification.',
    prompt: 'Mode: Executor. Convert discussion into artifacts, tasks, owners, verification, and blockers. Avoid open-ended debate.',
    autoChain: true,
    startAll: true,
    autoArbitrate: true,
  },
];

const MODE_BY_ID = Object.fromEntries(CONVERSATION_MODES.map(m => [m.id, m]));

const PROVIDERS = [
  {
    id: 'claude',
    label: 'Opus 4.7',
    shortLabel: 'Opus',
    kind: 'cli',
    icon: 'OP',
    color: '#c2613a',
    defaultEnabled: true,
    worker: true,
    free: true,
    fallbackOrder: ['codex'],
  },
  {
    id: 'codex',
    label: 'GPT-5.5',
    shortLabel: 'GPT',
    kind: 'cli',
    icon: 'G5',
    color: '#15803d',
    defaultEnabled: true,
    worker: true,
    free: true,
    fallbackOrder: ['claude'],
  },
];

// PROVIDER_BY_ID and PROVIDER_IDS are mutable runtime indexes that combine the
// built-in providers above with any user-defined custom providers from
// appSettings.customProviders. They are rebuilt by rebuildProviderIndex() on
// startup and any time custom providers change.
let PROVIDER_BY_ID = Object.fromEntries(PROVIDERS.map(p => [p.id, p]));
let PROVIDER_IDS = PROVIDERS.map(p => p.id);

const MAX_CUSTOM_PROVIDERS = 8;
const CUSTOM_PROVIDER_ID_PREFIX = 'cp_';
const ALLOWED_API_FORMATS = new Set(['openai-chat', 'anthropic-messages']);

function rebuildProviderIndex() {
  const customs = (appSettings && Array.isArray(appSettings.customProviders))
    ? appSettings.customProviders.map(toRuntimeProvider).filter(Boolean)
    : [];
  const all = [...PROVIDERS, ...customs];
  PROVIDER_BY_ID = Object.fromEntries(all.map(p => [p.id, p]));
  PROVIDER_IDS = all.map(p => p.id);
}

function toRuntimeProvider(cp) {
  if (!cp || !cp.id) return null;
  return {
    id: cp.id,
    label: cp.label,
    shortLabel: cp.shortLabel || cp.label,
    kind: cp.kind,
    icon: cp.icon || cp.shortLabel?.slice(0, 2).toUpperCase() || cp.label.slice(0, 2).toUpperCase(),
    color: cp.color || '#6d4ca8',
    defaultEnabled: false,
    worker: false, // custom providers do not run as workers yet
    free: cp.kind === 'cli',
    custom: true,
    command: cp.command,
    endpoint: cp.endpoint,
    apiKeyEnv: cp.apiKeyEnv,
    model: cp.model,
    format: cp.format,
    fallbackOrder: [],
  };
}

const DEFAULT_PROVIDER_PROFILES = {
  claude: {
    traits: ['strategist', 'challenger', 'decisive'],
    custom: 'Do not default to agreeing. If the other model has a point, refine or push back rather than endorse. Always have a take of your own.',
  },
  codex: {
    traits: ['skeptic', 'diplomatic', 'numerate'],
    custom: 'Critique ideas, not people. Lead with the strongest version of the other side before disagreeing. Avoid an overbearing or lecturing tone.',
  },
};
const MAX_TRAITS_PER_PROVIDER = 12;
const MAX_CUSTOM_INSTRUCTIONS_LEN = 1000;

const DEFAULT_SETTINGS = {
  groupChat: true,
  conversationMode: 'debate',
  maxChainTurns: DEFAULT_MAX_TURNS,
  fallbackEnabled: true,
  activeProviders: PROVIDERS.filter(p => p.defaultEnabled).map(p => p.id),
  providerProfiles: DEFAULT_PROVIDER_PROFILES,
  customProviders: [],
  stopRules: {
    maxRuntimeMinutes: 8,
    stopAfterAgreementTurns: 2,
    maxConsecutiveErrors: 2,
    autoArbitrate: true,
  },
};

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

// LocalCouncil intentionally does NOT load any API keys from disk.
// The built-in providers (claude + codex) are CLI-based and authenticate via
// their own OAuth login sessions.
// Custom providers (added via Settings) may optionally read an API key from
// an environment variable named by the user; we only ever READ that env var
// at invocation time, we never persist it.

function slugifyLabel(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'custom';
}

function uniqueCustomProviderId(base, existingIds) {
  const slug = slugifyLabel(base);
  let candidate = CUSTOM_PROVIDER_ID_PREFIX + slug;
  let n = 2;
  while (existingIds.has(candidate) || PROVIDERS.some(p => p.id === candidate)) {
    candidate = `${CUSTOM_PROVIDER_ID_PREFIX}${slug}-${n++}`;
  }
  return candidate;
}

function sanitizeCustomProvider(raw, existingIds) {
  if (!raw || typeof raw !== 'object') return null;
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 60) : '';
  if (!label) return null;
  const kind = raw.kind === 'api' ? 'api' : 'cli';
  const id = (typeof raw.id === 'string' && raw.id.startsWith(CUSTOM_PROVIDER_ID_PREFIX))
    ? raw.id
    : uniqueCustomProviderId(label, existingIds);

  const shortLabel = typeof raw.shortLabel === 'string'
    ? raw.shortLabel.trim().slice(0, 24)
    : label.slice(0, 12);
  const color = /^#[0-9a-f]{6}$/i.test(raw.color || '') ? raw.color : '#6d4ca8';
  const enabled = raw.enabled !== false;

  const base = { id, label, shortLabel, kind, color, enabled };

  if (kind === 'cli') {
    const command = typeof raw.command === 'string' ? raw.command.trim().slice(0, 2000) : '';
    if (!command) return null;
    base.command = command;
  } else {
    const endpoint = typeof raw.endpoint === 'string' ? raw.endpoint.trim().slice(0, 500) : '';
    if (!endpoint) return null;
    if (!/^https?:\/\//i.test(endpoint)) return null;
    base.endpoint = endpoint;
    base.model = typeof raw.model === 'string' ? raw.model.trim().slice(0, 100) : '';
    base.apiKeyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv.trim().slice(0, 100) : '';
    base.format = ALLOWED_API_FORMATS.has(raw.format) ? raw.format : 'openai-chat';
  }
  return base;
}

function sanitizeCustomProvidersArray(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const ids = new Set();
  for (const r of raw) {
    if (out.length >= MAX_CUSTOM_PROVIDERS) break;
    const cp = sanitizeCustomProvider(r, ids);
    if (cp && !ids.has(cp.id)) {
      out.push(cp);
      ids.add(cp.id);
    }
  }
  return out;
}

function sanitizeSettings(raw) {
  const next = cloneJson(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return next;

  if (typeof raw.groupChat === 'boolean') next.groupChat = raw.groupChat;
  if (MODE_BY_ID[raw.conversationMode]) next.conversationMode = raw.conversationMode;
  if (typeof raw.maxChainTurns === 'number' && Number.isFinite(raw.maxChainTurns)) {
    next.maxChainTurns = Math.max(1, Math.min(MAX_TURNS_CEILING, Math.floor(raw.maxChainTurns)));
  }
  if (typeof raw.fallbackEnabled === 'boolean') next.fallbackEnabled = raw.fallbackEnabled;

  // Custom providers FIRST. We build a local lookup table that includes the
  // built-in providers plus the validated customs, so the rest of this
  // function can validate ids against the merged provider table without
  // mutating module state (this function may run before `appSettings` exists).
  next.customProviders = sanitizeCustomProvidersArray(raw.customProviders);
  const mergedProviderIds = new Set([
    ...PROVIDERS.map(p => p.id),
    ...next.customProviders.map(cp => cp.id),
  ]);

  if (Array.isArray(raw.activeProviders)) {
    const cleaned = raw.activeProviders.filter(id => mergedProviderIds.has(id));
    if (cleaned.length) next.activeProviders = Array.from(new Set(cleaned));
  }
  // Default profile shape per provider, used as a base before merging anything saved.
  next.providerProfiles = {};
  for (const id of mergedProviderIds) {
    const seed = DEFAULT_PROVIDER_PROFILES[id] || { traits: ['operator'], custom: '' };
    next.providerProfiles[id] = { traits: seed.traits.slice(), custom: String(seed.custom || '') };
  }

  // Migrate legacy single-persona-per-provider settings to the new multi-trait shape.
  // The pre-multi-trait defaults were: claude=strategist, codex=skeptic. If the
  // user never customized those (i.e. value still matches the old default), upgrade
  // them to the new richer default profile. Otherwise honor the explicit single trait.
  const LEGACY_DEFAULTS = { claude: 'strategist', codex: 'skeptic' };
  if (raw.providerPersonas && typeof raw.providerPersonas === 'object') {
    for (const id of mergedProviderIds) {
      const personaId = raw.providerPersonas[id];
      if (!PERSONA_BY_ID[personaId]) continue;
      if (LEGACY_DEFAULTS[id] && personaId === LEGACY_DEFAULTS[id] && DEFAULT_PROVIDER_PROFILES[id]) {
        const seed = DEFAULT_PROVIDER_PROFILES[id];
        next.providerProfiles[id] = { traits: seed.traits.slice(), custom: String(seed.custom || '') };
      } else {
        next.providerProfiles[id] = { traits: [personaId], custom: '' };
      }
    }
  }

  // New shape: providerProfiles[id] = { traits: [...], custom: '...' }.
  if (raw.providerProfiles && typeof raw.providerProfiles === 'object') {
    for (const id of mergedProviderIds) {
      const profile = raw.providerProfiles[id];
      if (!profile || typeof profile !== 'object') continue;
      const traits = Array.isArray(profile.traits)
        ? Array.from(new Set(profile.traits.filter(t => PERSONA_BY_ID[t]))).slice(0, MAX_TRAITS_PER_PROVIDER)
        : null;
      const custom = typeof profile.custom === 'string'
        ? profile.custom.slice(0, MAX_CUSTOM_INSTRUCTIONS_LEN)
        : '';
      if (traits) next.providerProfiles[id] = { traits, custom };
    }
  }
  if (raw.stopRules && typeof raw.stopRules === 'object') {
    const sr = raw.stopRules;
    if (typeof sr.maxRuntimeMinutes === 'number' && Number.isFinite(sr.maxRuntimeMinutes)) {
      next.stopRules.maxRuntimeMinutes = Math.max(1, Math.min(60, Math.floor(sr.maxRuntimeMinutes)));
    }
    if (typeof sr.stopAfterAgreementTurns === 'number' && Number.isFinite(sr.stopAfterAgreementTurns)) {
      next.stopRules.stopAfterAgreementTurns = Math.max(0, Math.min(10, Math.floor(sr.stopAfterAgreementTurns)));
    }
    if (typeof sr.maxConsecutiveErrors === 'number' && Number.isFinite(sr.maxConsecutiveErrors)) {
      next.stopRules.maxConsecutiveErrors = Math.max(1, Math.min(10, Math.floor(sr.maxConsecutiveErrors)));
    }
    if (typeof sr.autoArbitrate === 'boolean') next.stopRules.autoArbitrate = sr.autoArbitrate;
  }

  return next;
}

function loadSettings() {
  if (!existsSync(SETTINGS_FILE)) return cloneJson(DEFAULT_SETTINGS);
  try {
    return sanitizeSettings(JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')));
  } catch (e) {
    console.error(`Failed to load settings: ${e.message}`);
    return cloneJson(DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2));
  } catch (e) {
    console.error(`Failed to save settings: ${e.message}`);
  }
}

let appSettings = loadSettings();
let groupChat = !!appSettings.groupChat;
let maxChainTurns = appSettings.maxChainTurns;
rebuildProviderIndex();

const providerHealth = {};
function ensureProviderHealth() {
  for (const id of PROVIDER_IDS) {
    if (!providerHealth[id]) {
      providerHealth[id] = {
        status: appSettings.activeProviders.includes(id) ? 'ready' : 'disabled',
        lastError: '',
        resetAt: '',
        lastLatencyMs: 0,
        updatedAt: Date.now(),
      };
    }
  }
}
ensureProviderHealth();

function providerPublicPayload() {
  ensureProviderHealth();
  return PROVIDER_IDS.map(id => PROVIDER_BY_ID[id]).filter(Boolean).map(p => ({
    id: p.id,
    label: p.label,
    shortLabel: p.shortLabel,
    kind: p.kind,
    icon: p.icon,
    color: p.color,
    worker: !!p.worker,
    free: !!p.free,
    custom: !!p.custom,
    enabled: appSettings.activeProviders.includes(p.id),
    profile: providerProfile(p.id),
    health: providerHealth[p.id] || {},
  }));
}

function settingsPayload() {
  return {
    groupChat,
    maxChainTurns,
    conversationMode: appSettings.conversationMode,
    fallbackEnabled: !!appSettings.fallbackEnabled,
    activeProviders: appSettings.activeProviders.slice(),
    providerProfiles: cloneJson(appSettings.providerProfiles),
    customProviders: cloneJson(appSettings.customProviders || []),
    stopRules: { ...appSettings.stopRules },
    providers: providerPublicPayload(),
    traits: PERSONAS,
    modes: CONVERSATION_MODES,
    limits: {
      maxTraitsPerProvider: MAX_TRAITS_PER_PROVIDER,
      maxCustomInstructionsLen: MAX_CUSTOM_INSTRUCTIONS_LEN,
      maxCustomProviders: MAX_CUSTOM_PROVIDERS,
    },
  };
}

function broadcastSettings() {
  broadcast({ type: 'settings', ...settingsPayload() });
}

function setProviderHealth(id, patch) {
  if (!providerHealth[id]) return;
  providerHealth[id] = {
    ...providerHealth[id],
    ...patch,
    updatedAt: Date.now(),
  };
  broadcast({ type: 'provider-health', providerId: id, health: providerHealth[id], providers: providerPublicPayload() });
}

function enabledProviders() {
  return appSettings.activeProviders.filter(id => PROVIDER_BY_ID[id]);
}

function modeConfig() {
  return MODE_BY_ID[appSettings.conversationMode] || MODE_BY_ID.debate;
}

function providerLabel(id) {
  return PROVIDER_BY_ID[id]?.label || id;
}

function providerProfile(id) {
  const stored = appSettings.providerProfiles && appSettings.providerProfiles[id];
  if (stored && Array.isArray(stored.traits) && stored.traits.length) {
    return { traits: stored.traits.slice(), custom: String(stored.custom || '') };
  }
  const seed = DEFAULT_PROVIDER_PROFILES[id] || { traits: ['operator'], custom: '' };
  return { traits: seed.traits.slice(), custom: String(seed.custom || '') };
}

function renderProfileBlock(profile) {
  const traits = (profile.traits || []).map(t => PERSONA_BY_ID[t]).filter(Boolean);
  const lines = [];
  if (traits.length) {
    lines.push('Character traits (combine, do not pick one):');
    for (const t of traits) lines.push(`- ${t.label}: ${t.prompt}`);
  }
  if (profile.custom && profile.custom.trim()) {
    if (lines.length) lines.push('');
    lines.push('Custom instructions for this model:');
    lines.push(profile.custom.trim());
  }
  return lines.join('\n');
}

function providerCanRun(id) {
  return appSettings.activeProviders.includes(id) && PROVIDER_BY_ID[id] && providerHealth[id]?.status !== 'rate-limited';
}

function getWorkspaceDir(conversationId) {
  const dir = join(WORKSPACES_DIR, conversationId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(join(__dirname, 'public')));

const server = createServer(app);
// Restrict WebSocket connections to local origins. The HTTP listener already
// binds 127.0.0.1 only, but a malicious page (DNS rebinding, a local browser
// extension, another tool reaching localhost) could still attempt to connect
// here. We accept only an empty origin (non-browser clients like curl) or an
// origin whose host resolves to localhost.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const wss = new WebSocketServer({
  server,
  verifyClient: (info) => {
    const origin = info.origin;
    if (!origin) return true;
    try {
      const u = new URL(origin);
      return LOCAL_HOSTS.has(u.hostname) || LOCAL_HOSTS.has(u.host);
    } catch {
      return false;
    }
  },
});

const conversations = new Map();
const clients = new Set();

function getRuntime(c) {
  if (!c) return null;
  if (!c.runtime) {
    c.runtime = {
      busy: {},
      chainGeneration: 0,
      chainTurnsUsed: 0,
      chainOwner: null,
      chainQueue: [],
      chainStartedAt: 0,
      consecutiveAgreementTurns: 0,
      consecutiveErrors: 0,
      activeProcesses: new Set(),
      pendingInterject: false,
      pendingUserMessages: [],
    };
  }
  if (typeof c.runtime.pendingInterject !== 'boolean') c.runtime.pendingInterject = false;
  if (!Array.isArray(c.runtime.pendingUserMessages)) c.runtime.pendingUserMessages = [];
  if (!c.runtime.busy) c.runtime.busy = {};
  for (const id of PROVIDER_IDS) {
    if (typeof c.runtime.busy[id] !== 'boolean') c.runtime.busy[id] = false;
  }
  if (!Array.isArray(c.runtime.chainQueue)) c.runtime.chainQueue = [];
  if (typeof c.runtime.chainStartedAt !== 'number') c.runtime.chainStartedAt = 0;
  if (typeof c.runtime.consecutiveAgreementTurns !== 'number') c.runtime.consecutiveAgreementTurns = 0;
  if (typeof c.runtime.consecutiveErrors !== 'number') c.runtime.consecutiveErrors = 0;
  return c.runtime;
}

function trackProcess(proc, conversationId) {
  const c = conversationId ? conversations.get(conversationId) : null;
  const rt = c ? getRuntime(c) : null;
  if (rt) rt.activeProcesses.add(proc);
  const cleanup = () => { if (rt) rt.activeProcesses.delete(proc); };
  proc.once('close', cleanup);
  proc.once('error', cleanup);
}

function cancelChain(conversationId, reason) {
  const c = conversations.get(conversationId);
  if (!c) return;
  const rt = getRuntime(c);
  const before = rt.chainGeneration;
  console.log(`[cancelChain] conv ${conversationId.slice(0, 8)}: ${reason}; killing ${rt.activeProcesses.size} proc(s), gen ${before} -> ${before + 1}`);
  rt.chainGeneration++;
  rt.chainTurnsUsed = 0;
  rt.chainOwner = null;
  rt.chainQueue = [];
  rt.chainStartedAt = 0;
  rt.consecutiveAgreementTurns = 0;
  rt.consecutiveErrors = 0;
  for (const proc of Array.from(rt.activeProcesses)) {
    try { proc.kill('SIGKILL'); } catch {}
  }
  rt.activeProcesses.clear();
}

function cancelAllChains(reason) {
  for (const c of conversations.values()) {
    const rt = c.runtime ? getRuntime(c) : null;
    if (rt && (Object.values(rt.busy).some(Boolean) || rt.activeProcesses.size)) {
      cancelChain(c.id, reason);
    }
  }
}

function loadConversations() {
  try {
    const files = readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        const data = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8'));
        if (data && data.id && Array.isArray(data.messages)) {
          ensureConversationFields(data);
          conversations.set(data.id, data);
        }
      } catch (e) {
        console.error(`Failed to load ${f}: ${e.message}`);
      }
    }
    console.log(`Loaded ${conversations.size} conversation(s).`);
  } catch (e) {
    console.error(`Failed to read data dir: ${e.message}`);
  }
}

function saveConversation(c) {
  try {
    const { runtime, ...persistable } = c;
    writeFileSync(join(DATA_DIR, `${c.id}.json`), JSON.stringify(persistable, null, 2));
  } catch (e) {
    console.error(`Failed to save conversation ${c.id}: ${e.message}`);
  }
}

function deleteConversationFile(id) {
  try { unlinkSync(join(DATA_DIR, `${id}.json`)); } catch {}
}

function createConversation() {
  const id = randomUUID();
  const c = {
    id,
    title: null,
    goal: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    baselinePlan: null,
    tasks: [],
  };
  conversations.set(id, c);
  saveConversation(c);
  return c;
}

function ensureConversationFields(c) {
  if (c.goal === undefined) c.goal = null;
  if (c.baselinePlan === undefined) c.baselinePlan = null;
  if (c.titleUserEdited === undefined) c.titleUserEdited = false;
  if (!Array.isArray(c.tasks)) c.tasks = [];
  for (const t of c.tasks) {
    if (!Array.isArray(t.events)) t.events = [];
    if (typeof t.output !== 'string') t.output = '';
    if (typeof t.workspace !== 'string') t.workspace = '';
    if (typeof t.startedAt !== 'number') t.startedAt = 0;
    if (typeof t.completedAt !== 'number') t.completedAt = 0;
  }
  getRuntime(c);
}

function pickDefaultConversation() {
  let mostRecent = null;
  for (const c of conversations.values()) {
    if (!mostRecent || c.updatedAt > mostRecent.updatedAt) mostRecent = c;
  }
  if (mostRecent) return mostRecent;
  return createConversation();
}

function conversationListPayload() {
  const list = [];
  for (const c of conversations.values()) {
    const rt = c.runtime;
    list.push({
      id: c.id,
      title: c.title || '(new chat)',
      updatedAt: c.updatedAt,
      messageCount: c.messages.length,
      busy: rt ? { ...rt.busy } : Object.fromEntries(PROVIDER_IDS.map(id => [id, false])),
      chainTurnsUsed: rt ? rt.chainTurnsUsed : 0,
    });
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt);
  return list;
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === 1) c.send(data);
  }
}

function broadcastList() {
  broadcast({ type: 'conversation-list', list: conversationListPayload() });
}

function compactForTitle(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t) return null;
  return t.length > 60 ? t.slice(0, 60) + '...' : t;
}

// Derive the auto-title for a conversation: prefer the chat's goal, fall back
// to the first user message. Returns null if there is nothing to derive from.
// Only used when c.titleUserEdited is false; a manual rename always wins.
function deriveAutoTitle(c) {
  if (c.goal && String(c.goal).trim()) return compactForTitle(c.goal);
  const firstUser = (c.messages || []).find(m => m.from === 'user');
  if (firstUser) return compactForTitle(firstUser.content);
  return null;
}

function addMessage(conversationId, from, content) {
  const c = conversations.get(conversationId);
  if (!c) {
    console.error(`addMessage: unknown conversation ${conversationId}`);
    return null;
  }
  const msg = { id: c.messages.length + 1, from, content, ts: Date.now() };
  c.messages.push(msg);
  c.updatedAt = msg.ts;
  // Refresh the auto-title from goal-or-first-user-message unless the user
  // has manually renamed the chat (in which case their choice wins).
  if (!c.titleUserEdited && from === 'user') {
    const auto = deriveAutoTitle(c);
    if (auto) c.title = auto;
  }
  saveConversation(c);
  broadcast({ type: 'message', conversationId, ...msg });
  broadcastList();
  return msg;
}

wss.on('connection', (ws) => {
  clients.add(ws);
  if (conversations.size === 0) createConversation();
  ws.send(JSON.stringify({
    type: 'init',
    list: conversationListPayload(),
    ...settingsPayload(),
  }));
  ws.on('close', () => clients.delete(ws));
});

function buildPromptLegacy(conversationId, self, other, allowPass) {
  const c = conversations.get(conversationId);
  const messages = c ? c.messages : [];
  const lines = messages.length
    ? messages.map(m => `[${m.from}]: ${m.content}`).join('\n\n')
    : '(no messages yet - say hello and introduce yourself)';

  const goalBlock = c && c.goal
    ? `\n\nGoal of this chat (keep this in mind for every reply):\n${c.goal}\n`
    : '';

  const passClause = allowPass
    ? `

PASS option (use SPARINGLY):
- You MAY output the single word PASS (and nothing else) ONLY if the conversation has fully resolved and you have genuinely nothing of substance to add, counter, or build on.
- DEFAULT to engaging. PASSing should be uncommon, not the polite default. A real participant in a group chat keeps the conversation alive.
- DO NOT PASS if ${other} or user addressed you by name, asked you a question, or made a claim you have any reaction to. Respond instead.
- DO NOT PASS just because you'd be "mostly agreeing" - add a nuance, a counter-example, a new angle, or a question. Pure agreement without color is fine; only PASS if you literally have zero content to contribute.`
    : '';

  return `You are "${self}" in a 3-way group chat with "${other}" (another AI assistant) and "user" (a human).

Voice and behavior:
- Output ONLY your next chat message as plain text or light markdown (bold, lists, code blocks OK). No "[${self}]:" prefix. No quotes. No preamble like "Here is my response:". No top-level markdown header lines.
- Do NOT include a date, timestamp, current-date line, "Today is...", "It is now...", or any time-of-day stamp anywhere in your reply. The UI already shows when the message was sent. Start directly with the substance of your reply.
- Be conversational. Usually 1 to 4 sentences. Longer only when the topic genuinely warrants depth.
- Address ${other} or user by name when relevant. Ask them direct questions. Make claims.
- Lean into disagreement, push back on weak reasoning, correct mistakes, and call out anything ${other} said that you think is wrong or incomplete. Friendly debate is the point of this chat. Do NOT be agreeable for the sake of it.
- Build on what was just said: react to specifics, quote a phrase, extend an example. Don't restart the topic.${passClause}${goalBlock}

Transcript so far:
${lines}

Your reply as ${self}:`;
}

function buildArbiterPromptLegacy(conversationId) {
  const c = conversations.get(conversationId);
  const messages = c ? c.messages : [];
  const transcript = messages
    .filter(m => m.from !== 'system' && m.from !== 'arbiter')
    .map(m => `[${m.from}]: ${m.content}`)
    .join('\n\n');
  const goal = c?.goal || '(no explicit goal set)';

  return `You are the Arbiter for a 3-way group chat between user, claude (Opus 4.7), and codex (GPT-5.5). The discussion has paused. Produce a structured summary of what was decided, what remains open, and what to do next.

Output ONLY valid JSON matching this exact schema. No prose, no markdown fences, no commentary outside the JSON. Do not wrap in code blocks. Just raw JSON, ready to parse.

Schema:
{
  "decision": "<single-sentence primary outcome of this discussion, or null if no clear decision was reached>",
  "rationale": "<short paragraph justifying the decision; null if decision is null>",
  "rejected_options": ["<option that was considered but rejected, with one-line reason>"],
  "open_questions": ["<question that remains unresolved>"],
  "next_tasks": [
    {
      "description": "<concrete next action>",
      "owner": "user" | "claude" | "codex",
      "success_test": "<how we will know it is done>"
    }
  ]
}

If any array would be empty, output [] (not null). The decision and rationale fields may be null if the conversation didn't actually converge on anything. Be ruthlessly honest about ambiguity - do not invent a decision that wasn't actually made.

Goal of this chat:
${goal}

Transcript:
${transcript}

Output the JSON now:`;
}

function transcriptLine(m) {
  return `[${providerLabel(m.from)}]: ${m.content}`;
}

function buildPrompt(conversationId, self, otherIds, allowPass) {
  const c = conversations.get(conversationId);
  const messages = c ? c.messages : [];
  const lines = messages.length
    ? messages.map(transcriptLine).join('\n\n')
    : '(no messages yet, say hello and introduce yourself)';

  const goalBlock = c && c.goal
    ? `\n\nGoal of this chat (keep this in mind for every reply):\n${c.goal}\n`
    : '';
  const provider = PROVIDER_BY_ID[self] || { label: self };
  const profile = providerProfile(self);
  const profileBlock = renderProfileBlock(profile);
  const mode = modeConfig();
  const others = Array.isArray(otherIds) ? otherIds : [otherIds].filter(Boolean);
  const otherNames = others.length ? others.map(providerLabel).join(', ') : 'the other council members';

  const passClause = allowPass
    ? `

PASS option (use SPARINGLY):
- You MAY output the single word PASS (and nothing else) ONLY if the conversation has fully resolved and you have genuinely nothing of substance to add, counter, or build on.
- DEFAULT to engaging. PASSing should be uncommon, not the polite default. A real participant in a group chat keeps the conversation alive.
- DO NOT PASS if ${otherNames} or user addressed you by name, asked you a question, or made a claim you have any reaction to. Respond instead.
- DO NOT PASS just because you'd be mostly agreeing. Add a nuance, a counter-example, a new angle, or a question. Pure agreement without color is fine; only PASS if you literally have zero content to contribute.`
    : '';

  return `You are "${provider.label}" in a LocalCouncil group chat with ${otherNames} and "user" (a human).

${profileBlock}

${mode.prompt}

Voice and behavior:
- Output ONLY your next chat message as plain text or light markdown (bold, lists, code blocks OK). No "[${provider.label}]:" prefix. No quotes. No preamble like "Here is my response:". No top-level markdown header lines.
- Do NOT include a date, timestamp, current-date line, "Today is...", "It is now...", or any time-of-day stamp anywhere in your reply. The UI already shows when the message was sent. Start directly with the substance of your reply.
- Be conversational. Usually 1 to 4 sentences. Longer only when the topic genuinely warrants depth.
- Address other council members or user when relevant. Ask direct questions. Make claims.
- Lean into disagreement, push back on weak reasoning, correct mistakes, and call out anything the other council members said that you think is wrong or incomplete. Friendly debate is the point of this chat. Do NOT be agreeable for the sake of it.
- Build on what was just said: react to specifics, quote a phrase, extend an example. Don't restart the topic.${passClause}${goalBlock}

Transcript so far:
${lines}

Your reply as ${provider.label}:`;
}

function buildArbiterPrompt(conversationId) {
  const c = conversations.get(conversationId);
  const messages = c ? c.messages : [];
  const transcript = messages
    .filter(m => m.from !== 'system' && m.from !== 'arbiter')
    .map(transcriptLine)
    .join('\n\n');
  const goal = c?.goal || '(no explicit goal set)';
  const ownerOptions = ['user', ...enabledProviders()].join('" | "');

  return `You are the Arbiter for a LocalCouncil group chat between user and these model participants: ${enabledProviders().map(providerLabel).join(', ')}. The discussion has paused. Produce a structured summary of what was decided, what remains open, and what to do next.

Output ONLY valid JSON matching this exact schema. No prose, no markdown fences, no commentary outside the JSON. Do not wrap in code blocks. Just raw JSON, ready to parse.

Schema:
{
  "decision": "<single-sentence primary outcome of this discussion, or null if no clear decision was reached>",
  "rationale": "<short paragraph justifying the decision; null if decision is null>",
  "rejected_options": ["<option that was considered but rejected, with one-line reason>"],
  "open_questions": ["<question that remains unresolved>"],
  "next_tasks": [
    {
      "description": "<concrete next action>",
      "owner": "${ownerOptions}",
      "success_test": "<how we will know it is done>"
    }
  ]
}

If any array would be empty, output [] (not null). The decision and rationale fields may be null if the conversation did not actually converge on anything. Be ruthlessly honest about ambiguity. Do not invent a decision that was not actually made.

Goal of this chat:
${goal}

Transcript:
${transcript}

Output the JSON now:`;
}

function parseArbiterJson(raw) {
  if (!raw) return null;
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1) return null;
  text = text.slice(firstBrace, lastBrace + 1);
  try {
    const parsed = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      decision: typeof parsed.decision === 'string' ? parsed.decision : null,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale : null,
      rejected_options: Array.isArray(parsed.rejected_options) ? parsed.rejected_options.filter(x => typeof x === 'string') : [],
      open_questions: Array.isArray(parsed.open_questions) ? parsed.open_questions.filter(x => typeof x === 'string') : [],
      next_tasks: Array.isArray(parsed.next_tasks)
        ? parsed.next_tasks
            .filter(t => t && typeof t === 'object' && typeof t.description === 'string')
            .map(t => ({
              description: t.description,
              owner: ['user', ...PROVIDER_IDS].includes(t.owner) ? t.owner : 'user',
              success_test: typeof t.success_test === 'string' ? t.success_test : '',
            }))
        : [],
    };
  } catch {
    return null;
  }
}

async function runArbiter(conversationId) {
  const c = conversations.get(conversationId);
  if (!c) return;
  if (c.messages.length < 2) return;
  const lastNonSystem = [...c.messages].reverse().find(m => m.from !== 'system');
  if (!lastNonSystem || lastNonSystem.from === 'arbiter') return;

  console.log(`[arbiter ${conversationId.slice(0,8)}] running`);
  const rt = getRuntime(c);
  const arbiterProvider = providerCanRun('claude') ? 'claude' : (enabledProviders().find(providerCanRun) || 'claude');
  rt.busy[arbiterProvider] = true;
  broadcast({ type: 'busy', conversationId, who: arbiterProvider, busy: true });
  broadcastList();

  try {
    const prompt = buildArbiterPrompt(conversationId);
    const raw = await invokeProviderWithPrompt(arbiterProvider, prompt, conversationId);
    console.log(`[arbiter] raw (${raw?.length ?? 0} chars):`, JSON.stringify(raw?.slice(0, 200) ?? ''));
    const parsed = parseArbiterJson(raw);
    if (!parsed) {
      addMessage(conversationId, 'system', 'Arbiter could not produce valid JSON. Skipping synthesis.');
      return;
    }

    c.baselinePlan = parsed;
    for (const t of parsed.next_tasks) {
      c.tasks.push({
        id: randomUUID(),
        description: t.description,
        owner: t.owner,
        success_test: t.success_test,
        status: 'proposed',
        createdAt: Date.now(),
        startedAt: 0,
        completedAt: 0,
        workspace: '',
        output: '',
        events: [],
      });
    }
    c.updatedAt = Date.now();
    saveConversation(c);

    const arbiterMsg = {
      id: c.messages.length + 1,
      from: 'arbiter',
      content: JSON.stringify(parsed),
      ts: Date.now(),
    };
    c.messages.push(arbiterMsg);
    saveConversation(c);
    broadcast({ type: 'message', conversationId, ...arbiterMsg });
    broadcastList();
  } catch (e) {
    if (isCancellationKill(e)) {
      console.log(`[arbiter ${conversationId.slice(0,8)}] cancelled by user action (kill signal); suppressing system message`);
    } else {
      addMessage(conversationId, 'system', `Arbiter error: ${e.message}`);
    }
  } finally {
    rt.busy[arbiterProvider] = false;
    broadcast({ type: 'busy', conversationId, who: arbiterProvider, busy: false });
    broadcastList();
  }
}

function isPass(reply) {
  if (!reply) return false;
  const cleaned = reply.trim().replace(/^[\[<("'`*_\s]+|[\]>)"'`*_.\s]+$/g, '').toUpperCase();
  return cleaned === 'PASS';
}

function tailText(text, limit = 800) {
  const cleaned = String(text || '').trim();
  if (!cleaned) return '';
  return cleaned.length > limit ? cleaned.slice(-limit) : cleaned;
}

function processExitError(label, code, stdout, stderr, limit = 800) {
  const parts = [];
  const out = tailText(stdout, limit);
  const err = tailText(stderr, limit);
  if (out) parts.push(`stdout:\n${out}`);
  if (err) parts.push(`stderr:\n${err}`);
  return new Error(`${label} exited ${code}: ${parts.join('\n\n') || '(empty stdout/stderr)'}`);
}

function pipeStdinSpawn(cmd, args, prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`${cmd} timed out after ${CLI_TIMEOUT_MS / 1000}s`));
    }, CLI_TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, stderr: err });
      else reject(processExitError(cmd, code, out, err));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function isTransientProviderError(err) {
  const msg = String(err && (err.message || err) || '');
  if (!msg) return false;
  return (
    /Failed to authenticate/i.test(msg) ||
    /socket connection was closed unexpectedly/i.test(msg) ||
    /\b401\b/.test(msg) ||
    /\b429\b/.test(msg) ||
    /\b50[234]\b/.test(msg) ||
    /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_SOCKET/i.test(msg) ||
    /rate.?limit/i.test(msg)
  );
}

async function withTransientRetry(label, conversationId, fn) {
  const tag = conversationId ? conversationId.slice(0, 8) : '-';
  try {
    return await fn();
  } catch (e) {
    if (!isTransientProviderError(e)) throw e;
    console.log(`[retry ${tag}] ${label} transient error, retrying once in 1500ms: ${String(e?.message || e).slice(0, 240)}`);
    await new Promise(r => setTimeout(r, 1500));
    return await fn();
  }
}

async function invokeClaudeWithPrompt(prompt, conversationId) {
  return withTransientRetry('claude', conversationId, async () => {
    const promptFile = join(tmpdir(), `modelchat-claude-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(promptFile, prompt, 'utf8');
    try {
      const fullCmd = `claude -p --model opus --permission-mode bypassPermissions --allowedTools "WebSearch,WebFetch" < "${promptFile}"`;
      const stdout = await runShellCommand(fullCmd, 'claude', conversationId);
      return stdout.trim();
    } finally {
      try { unlinkSync(promptFile); } catch {}
    }
  });
}

async function invokeCodexWithPrompt(prompt, conversationId) {
  return withTransientRetry('codex', conversationId, async () => {
    const promptFile = join(tmpdir(), `modelchat-codex-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const outFile = join(tmpdir(), `modelchat-codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(promptFile, prompt, 'utf8');
    try {
      const fullCmd = `codex exec -m gpt-5.5 -s read-only --skip-git-repo-check -o "${outFile}" < "${promptFile}"`;
      await runShellCommand(fullCmd, 'codex', conversationId);
      if (!existsSync(outFile)) throw new Error(`codex did not write output file ${outFile}`);
      return readFileSync(outFile, 'utf8').trim();
    } finally {
      try { unlinkSync(promptFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  });
}

function resetFromErrorMessage(message) {
  const text = String(message || '');
  const match = text.match(/resets?\s+([^\n]+)/i);
  return match ? match[1].trim() : '';
}

function isLimitError(message) {
  return /hit your limit|rate limit|quota|too many requests|HTTP 429/i.test(String(message || ''));
}

// `exited null` means the OS terminated the process via signal (we SIGKILL when
// user sends a new message mid-chain, switches chats, clicks Stop, etc). Those
// kills are intentional and should not surface as user-facing CLI errors.
function isCancellationKill(e) {
  const msg = String(e && (e.message || e) || '');
  return /\bexited\s+null\b/i.test(msg);
}

function recordProviderError(id, e) {
  const message = e?.message || String(e);
  const resetAt = resetFromErrorMessage(message);
  setProviderHealth(id, {
    status: isLimitError(message) ? 'rate-limited' : 'error',
    lastError: message,
    resetAt,
  });
}

async function invokeCustomCliProvider(provider, prompt, conversationId) {
  return withTransientRetry(provider.id, conversationId, async () => {
    const stamp = Date.now() + '-' + Math.random().toString(36).slice(2);
    const promptFile = join(tmpdir(), `localcouncil-${provider.id}-prompt-${stamp}.txt`);
    const outFile = join(tmpdir(), `localcouncil-${provider.id}-out-${stamp}.txt`);
    writeFileSync(promptFile, prompt, 'utf8');
    try {
      const usesOutFile = provider.command.includes('{{OUT_FILE}}');
      const cmd = provider.command
        .replace(/\{\{PROMPT_FILE\}\}/g, `"${promptFile}"`)
        .replace(/\{\{OUT_FILE\}\}/g, `"${outFile}"`);
      const stdout = await runShellCommand(cmd, provider.id, conversationId);
      if (usesOutFile) {
        if (!existsSync(outFile)) throw new Error(`${provider.label} did not write to OUT_FILE`);
        return readFileSync(outFile, 'utf8').trim();
      }
      return stdout.trim();
    } finally {
      try { unlinkSync(promptFile); } catch {}
      try { unlinkSync(outFile); } catch {}
    }
  });
}

async function invokeCustomApiProvider(provider, prompt, conversationId) {
  const apiKey = provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : '';
  if (provider.apiKeyEnv && !apiKey) {
    throw new Error(`API key env var ${provider.apiKeyEnv} is not set; provider "${provider.label}" cannot run. Set it in your shell and restart the server.`);
  }
  let body;
  let headers = { 'content-type': 'application/json' };
  if (provider.format === 'anthropic-messages') {
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = JSON.stringify({
      model: provider.model || 'claude-3-5-sonnet-latest',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
  } else {
    // openai-chat default
    if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
    body = JSON.stringify({
      model: provider.model || 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
    });
  }
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLI_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(provider.endpoint, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${provider.label} returned HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  if (provider.format === 'anthropic-messages') {
    const block = Array.isArray(data?.content) ? data.content.find(b => b.type === 'text') : null;
    return (block?.text || '').trim();
  }
  return (data?.choices?.[0]?.message?.content || '').trim();
}

async function invokeProviderWithPrompt(id, prompt, conversationId) {
  const provider = PROVIDER_BY_ID[id];
  if (!provider) throw new Error(`Unknown provider ${id}`);
  const startedAt = Date.now();
  try {
    let reply;
    if (id === 'claude') reply = await invokeClaudeWithPrompt(prompt, conversationId);
    else if (id === 'codex') reply = await invokeCodexWithPrompt(prompt, conversationId);
    else if (provider.custom && provider.kind === 'cli') reply = await invokeCustomCliProvider(provider, prompt, conversationId);
    else if (provider.custom && provider.kind === 'api') reply = await invokeCustomApiProvider(provider, prompt, conversationId);
    else throw new Error(`Provider ${provider.label} has no invocation adapter.`);
    setProviderHealth(id, {
      status: 'ready',
      lastError: '',
      resetAt: '',
      lastLatencyMs: Date.now() - startedAt,
    });
    return reply;
  } catch (e) {
    recordProviderError(id, e);
    throw e;
  }
}

function pickFallbackProvider(id) {
  if (!appSettings.fallbackEnabled) return null;
  const provider = PROVIDER_BY_ID[id];
  const options = provider?.fallbackOrder || [];
  return options.find(candidate => candidate !== id && providerCanRun(candidate)) || null;
}

function buildWorkerPrompt(c, task) {
  const goal = c.goal || '(no explicit goal set)';
  const plan = c.baselinePlan;
  const decisionBlock = plan && plan.decision
    ? `Most recent council decision (context):\n${plan.decision}\n${plan.rationale || ''}`
    : '(no consolidated council decision yet)';
  const otherTasks = c.tasks
    .filter(t => t.id !== task.id)
    .map(t => `- [${t.status}] (${t.owner}) ${t.description}`)
    .join('\n') || '(none)';

  return `You are a worker dispatched by the LocalCouncil orchestrator to execute a single task and report back.

PROJECT GOAL:
${goal}

${decisionBlock}

OTHER TASKS IN THIS COUNCIL (for context, do NOT do them - only your assigned task):
${otherTasks}

YOUR ASSIGNED TASK:
${task.description}

SUCCESS TEST (how the council will know it's done):
${task.success_test || '(none specified, use your judgment)'}

WORKSPACE:
You have been spawned inside a dedicated workspace directory for this task (your current working directory). You have full read/write access there and can run shell commands, edit files, search the web. Stay within that workspace, do NOT modify files outside it. Do NOT touch the LocalCouncil source code itself.

EXECUTION RULES:
- One-shot: you have a single execution. No follow-up Q&A loop. Use your tools freely.
- Be focused. Do not ask for clarification you can resolve by trying.
- Use sub-agents (Agent / Task tool) freely if it speeds things up.
- Your FINAL message (after all tool use) MUST contain, in order:
  1. ## Summary, 2 to 4 sentences of what you did.
  2. ## Files, bullet list of files created or modified (relative to workspace).
  3. ## Notes, anything uncertain, blocked, or worth a human eye. Use "(none)" if there's nothing.

Begin work now.`;
}

function summarizeToolUse(block) {
  if (!block || typeof block !== 'object') return null;
  const name = block.name;
  const input = block.input || {};
  if (name === 'Read' && input.file_path) return `Read ${input.file_path}`;
  if (name === 'Write' && input.file_path) return `Write ${input.file_path}`;
  if (name === 'Edit' && input.file_path) return `Edit ${input.file_path}`;
  if (name === 'NotebookEdit' && input.notebook_path) return `NotebookEdit ${input.notebook_path}`;
  if (name === 'Bash' && input.command) return `Bash: ${String(input.command).slice(0, 120)}`;
  if (name === 'PowerShell' && input.command) return `PowerShell: ${String(input.command).slice(0, 120)}`;
  if (name === 'Glob' && input.pattern) return `Glob ${input.pattern}`;
  if (name === 'Grep' && input.pattern) return `Grep ${input.pattern}`;
  if (name === 'WebFetch' && input.url) return `WebFetch ${input.url}`;
  if (name === 'WebSearch' && input.query) return `WebSearch "${input.query}"`;
  if (name === 'Agent') return `Spawn sub-agent: ${input.description || '(no description)'}`;
  return name || 'tool';
}

function simplifyClaudeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'system' && event.subtype === 'init') {
    return { kind: 'start', text: `Worker started (model: ${event.model || 'opus'})` };
  }
  if (event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
    for (const block of event.message.content) {
      if (block.type === 'tool_use') {
        const text = summarizeToolUse(block);
        if (text) return { kind: 'tool', text };
      }
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const t = block.text.trim().replace(/\s+/g, ' ');
        return { kind: 'thought', text: t.length > 240 ? t.slice(0, 237) + '...' : t };
      }
    }
  }
  if (event.type === 'result' && event.subtype === 'success') {
    return { kind: 'end', text: 'Worker finished.' };
  }
  if (event.type === 'result' && event.subtype && event.subtype !== 'success') {
    return { kind: 'error', text: `Worker ended with subtype=${event.subtype}` };
  }
  return null;
}

function onTaskEvent(conversationId, taskId, event) {
  const c = conversations.get(conversationId);
  if (!c) return;
  const task = c.tasks.find(t => t.id === taskId);
  if (!task) return;
  const stamped = { ...event, ts: Date.now() };
  if (!Array.isArray(task.events)) task.events = [];
  task.events.push(stamped);
  if (task.events.length > 200) task.events = task.events.slice(-200);
  c.updatedAt = Date.now();
  saveConversation(c);
  broadcast({ type: 'task-event', conversationId, taskId, event: stamped });
}

async function runClaudeWorker(prompt, workspace, onEvent, conversationId) {
  const promptFile = join(tmpdir(), `lc-worker-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(promptFile, prompt, 'utf8');
  try {
    return await new Promise((resolve, reject) => {
      const cmd = `claude -p --model opus --permission-mode bypassPermissions --output-format stream-json --verbose < "${promptFile}"`;
      const proc = spawn(cmd, { shell: true, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env: envForLabel('claude worker') });
      trackProcess(proc, conversationId);
      let buf = '';
      let stdoutRaw = '';
      let finalText = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`claude worker timed out after ${WORKER_TIMEOUT_MS / 1000}s`));
      }, WORKER_TIMEOUT_MS);
      proc.stdout.on('data', (d) => {
        const chunk = d.toString();
        stdoutRaw += chunk;
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'result' && typeof event.result === 'string') {
              finalText = event.result;
            }
            const simplified = simplifyClaudeEvent(event);
            if (simplified) onEvent(simplified);
          } catch {
            // non-JSON line, skip
          }
        }
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(finalText || '(worker produced no final text)');
        } else {
          reject(processExitError('claude worker', code, stdoutRaw, stderr));
        }
      });
    });
  } finally {
    try { unlinkSync(promptFile); } catch {}
  }
}

async function runCodexWorker(prompt, workspace, onEvent, conversationId) {
  const promptFile = join(tmpdir(), `lc-worker-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  const outFile = join(tmpdir(), `lc-worker-codex-out-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(promptFile, prompt, 'utf8');
  onEvent({ kind: 'start', text: 'Worker started (codex gpt-5.5, workspace-write sandbox)' });
  try {
    return await new Promise((resolve, reject) => {
      const cmd = `codex exec -m gpt-5.5 -s workspace-write --skip-git-repo-check -C "${workspace}" -o "${outFile}" < "${promptFile}"`;
      const proc = spawn(cmd, { shell: true, cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
      trackProcess(proc, conversationId);
      let stderr = '';
      let stdoutBuf = '';
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        reject(new Error(`codex worker timed out after ${WORKER_TIMEOUT_MS / 1000}s`));
      }, WORKER_TIMEOUT_MS);
      proc.stdout.on('data', (d) => {
        stdoutBuf += d.toString();
        const lines = stdoutBuf.split(/\r?\n/);
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          onEvent({ kind: 'thought', text: t.length > 240 ? t.slice(0, 237) + '...' : t });
        }
      });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          if (!existsSync(outFile)) return reject(new Error('codex worker produced no output file'));
          onEvent({ kind: 'end', text: 'Worker finished.' });
          resolve(readFileSync(outFile, 'utf8').trim() || '(empty output)');
        } else {
          reject(new Error(`codex worker exited ${code}: ${stderr.trim().slice(0, 600) || '(empty stderr)'}`));
        }
      });
    });
  } finally {
    try { unlinkSync(promptFile); } catch {}
    try { unlinkSync(outFile); } catch {}
  }
}

// Workers spawn the claude/codex CLIs with permission-bypass enabled so the
// model can read/write files, run shell commands, etc., inside the task
// workspace. That capability is real and dangerous, so it is OFF by default.
// Set LC_ALLOW_WORKER_BYPASS=1 in the environment to enable worker dispatch.
const WORKER_BYPASS_ALLOWED = process.env.LC_ALLOW_WORKER_BYPASS === '1';
if (WORKER_BYPASS_ALLOWED) {
  console.warn('[WARN] LC_ALLOW_WORKER_BYPASS=1 - worker dispatch enabled. Workers run the claude/codex CLIs with permission bypass and can modify files / run shell commands inside the task workspace. Only use on a workstation you trust with that level of access.');
} else {
  console.log('[info] worker dispatch disabled. Set LC_ALLOW_WORKER_BYPASS=1 to enable (see SECURITY note in README).');
}

async function runTask(conversationId, taskId) {
  const c = conversations.get(conversationId);
  if (!c) return;
  const task = c.tasks.find(t => t.id === taskId);
  if (!task) return;
  if (task.owner === 'user') return;
  if (task.status === 'running') return;

  if (!WORKER_BYPASS_ALLOWED) {
    task.status = 'blocked';
    task.output = 'Worker dispatch is disabled. Set the environment variable LC_ALLOW_WORKER_BYPASS=1 and restart the server to enable. See the SECURITY section of the README before doing so.';
    task.completedAt = Date.now();
    c.updatedAt = Date.now();
    saveConversation(c);
    broadcast({ type: 'task-updated', conversationId, task });
    addMessage(conversationId, 'system', `**Worker dispatch is disabled.** Set \`LC_ALLOW_WORKER_BYPASS=1\` in the environment and restart to enable. See the SECURITY section of the README before turning it on.`);
    return;
  }

  const workspace = getWorkspaceDir(conversationId);
  task.workspace = workspace;
  task.status = 'running';
  task.startedAt = Date.now();
  task.events = [];
  task.output = '';
  c.updatedAt = Date.now();
  saveConversation(c);
  broadcast({ type: 'task-updated', conversationId, task });

  addMessage(conversationId, 'system', `Dispatching task to **${providerLabel(task.owner)}** worker:\n\n> ${task.description}`);

  try {
    const prompt = buildWorkerPrompt(c, task);
    const emit = (event) => onTaskEvent(conversationId, taskId, event);
    let output;
    if (task.owner === 'claude') output = await runClaudeWorker(prompt, workspace, emit, conversationId);
    else if (task.owner === 'codex') output = await runCodexWorker(prompt, workspace, emit, conversationId);
    else throw new Error(`${providerLabel(task.owner)} does not support worker execution yet`);

    task.output = output;
    task.status = 'reviewing';
    task.completedAt = Date.now();
    c.updatedAt = Date.now();
    saveConversation(c);
    broadcast({ type: 'task-updated', conversationId, task });

    // Include more of the worker output so the council can actually evaluate
    // it (was: only the last 6 non-empty lines, which left context dangling).
    // Cap at ~10k chars head + tail to keep the transcript scrollable.
    const fullOutput = String(output || '').trim();
    const MAX = 10000;
    let body;
    if (fullOutput.length <= MAX) {
      body = fullOutput;
    } else {
      const headChars = Math.floor(MAX * 0.7);
      const tailChars = MAX - headChars;
      body = `${fullOutput.slice(0, headChars)}\n\n_..[output truncated, ${fullOutput.length - MAX} chars omitted]_..\n\n${fullOutput.slice(-tailChars)}`;
    }
    addMessage(
      conversationId,
      'system',
      `**${providerLabel(task.owner)} worker finished** task: _"${task.description}"_\n\n---\n\n${body}`,
    );
    // Ask the council to review the worker's output, then kick off a chain so
    // the models discuss whether the task was completed correctly and decide
    // the next step. This runs in the background and politely waits if a chat
    // chain is already in flight.
    requestCouncilReviewOfWorker(c.id, task);
  } catch (e) {
    task.output = `Worker error: ${e.message}`;
    task.status = 'blocked';
    task.completedAt = Date.now();
    c.updatedAt = Date.now();
    saveConversation(c);
    broadcast({ type: 'task-updated', conversationId, task });
    addMessage(conversationId, 'system', `**${task.owner} worker FAILED** task "${task.description}":\n\n${e.message}`);
  }
}

function findTask(taskId) {
  for (const c of conversations.values()) {
    const t = c.tasks.find(t => t.id === taskId);
    if (t) return { conversation: c, task: t };
  }
  return null;
}

// When a worker finishes, ask the council to evaluate its output. Adds a
// system prompt that frames the review, then kicks off a fresh chain so both
// models discuss it. If the chain is currently in flight, waits for it to
// clear (polite interject - never kills an in-flight reply).
function requestCouncilReviewOfWorker(conversationId, task) {
  const c = conversations.get(conversationId);
  if (!c) return;
  if (!groupChat) return;
  const rt = getRuntime(c);
  const tag = c.id.slice(0, 8);
  const promptMsg = `Council, please evaluate the **${providerLabel(task.owner)} worker's** output above for the task: _"${task.description}"_.\n\nAnswer:\n1. Was the task completed correctly? Be specific about gaps, mistakes, or missing pieces.\n2. Are there issues, risks, or follow-ups the user should know about?\n3. What is the single highest-leverage next step?`;
  addMessage(c.id, 'system', promptMsg);

  const inFlight = Object.values(rt.busy).some(Boolean);
  if (!inFlight) {
    console.log(`[worker-review ${tag}] kicking off council review immediately for task ${task.id}`);
    kickOffFreshChain(c, `worker-review ${task.owner}`);
    return;
  }
  // Wait for the in-flight chain to clear, then start the review chain.
  if (rt.pendingInterject) {
    console.log(`[worker-review ${tag}] interject already pending; review will run when chain clears`);
    return;
  }
  rt.pendingInterject = true;
  rt.pendingTarget = null;
  console.log(`[worker-review ${tag}] in-flight chain still running; will start review when it clears`);
  let polls = 0;
  const poll = setInterval(() => {
    polls++;
    const stillBusy = Object.values(rt.busy).some(Boolean);
    if (!stillBusy) {
      clearInterval(poll);
      console.log(`[worker-review ${tag}] chain cleared after ${polls} polls; starting council review`);
      kickOffFreshChain(c, `worker-review ${task.owner} post-interject`);
    } else if (polls > 12000) {
      clearInterval(poll);
      rt.pendingInterject = false;
      console.log(`[worker-review ${tag}] interject wait timed out after 20 minutes; bailing`);
    }
  }, 100);
}

function envForLabel(label) {
  if (label === 'claude' || label === 'claude worker') {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    return env;
  }
  return process.env;
}

function runShellCommand(fullCmd, label, conversationId) {
  return new Promise((resolve, reject) => {
    const proc = spawn(fullCmd, { shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: envForLabel(label) });
    trackProcess(proc, conversationId);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS / 1000}s`));
    }, CLI_TIMEOUT_MS);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(processExitError(label, code, out, err));
    });
  });
}

function activeRunnableProviders() {
  return enabledProviders().filter(providerCanRun);
}

function nextProviderAfter(current) {
  const active = activeRunnableProviders();
  if (!active.length) return null;
  const idx = active.indexOf(current);
  if (idx === -1) return active[0];
  return active[(idx + 1) % active.length];
}

function chainLimitForMode() {
  return modeConfig().maxTurnsOverride || maxChainTurns;
}

function shouldAutoArbitrate() {
  return !!appSettings.stopRules.autoArbitrate || !!modeConfig().autoArbitrate;
}

function looksLikeAgreement(reply) {
  return /^(agreed|agree|yes|exactly|fair|good|locked|right|that works|sounds right)\b/i.test(String(reply || '').trim());
}

function finishChain(conversationId, message) {
  addMessage(conversationId, 'system', message);
  if (shouldAutoArbitrate()) setTimeout(() => runArbiter(conversationId), 400);
}

function shortenProviderError(message) {
  const m = String(message || '').trim();
  if (!m) return 'unknown error';
  const limitMatch = m.match(/You['’]ve hit your limit[^\n]*/i);
  if (limitMatch) return limitMatch[0].trim();
  const apiMatch = m.match(/API Error:\s*\d+[^\n]*/i);
  if (apiMatch) return apiMatch[0].trim();
  const authMatch = m.match(/Failed to authenticate[^\n]*/i);
  if (authMatch) return authMatch[0].trim();
  const isNoise = (line) => {
    const l = line.trim();
    if (!l) return true;
    if (/^(stdout|stderr):\s*$/i.test(l)) return true;
    if (/^SessionEnd hook/i.test(l)) return true;
    if (/^Error:\s*$/i.test(l)) return true;
    if (/^\(empty stdout\/stderr\)$/.test(l)) return true;
    return false;
  };
  const lines = m.split(/\r?\n/);
  const meaningful = lines.find(l => !isNoise(l) && !/exited\s+\S+:\s*$/i.test(l.trim()));
  if (meaningful) return meaningful.trim().slice(0, 200);
  const exited = m.match(/(claude|codex)\s+exited\s+\S+[^\n]*/i);
  if (exited) return exited[0].trim();
  return m.split('\n')[0].slice(0, 200);
}

async function invokeWithFallback(who, prompt, conversationId, busyIds) {
  try {
    return { actualWho: who, reply: await invokeProviderWithPrompt(who, prompt, conversationId) };
  } catch (e) {
    if (isCancellationKill(e)) {
      console.log(`[fallback ${conversationId.slice(0,8)}] ${who} cancelled by user action (kill signal); not falling back`);
      throw e;
    }
    const rawMsg = String(e?.message || e);
    const reason = shortenProviderError(rawMsg);
    console.log(`[fallback ${conversationId.slice(0,8)}] ${who} failed (reason: ${reason})`);
    console.log(`[fallback ${conversationId.slice(0,8)}] ${who} RAW ERROR (${rawMsg.length} chars):\n----- BEGIN RAW -----\n${rawMsg}\n----- END RAW -----`);
    const fallback = pickFallbackProvider(who);
    if (!fallback) throw e;
    addMessage(conversationId, 'system', `${providerLabel(who)} is unavailable (${reason}), routing this turn to ${providerLabel(fallback)}.`);
    const c = conversations.get(conversationId);
    const rt = getRuntime(c);
    rt.busy[fallback] = true;
    busyIds.add(fallback);
    broadcast({ type: 'busy', conversationId, who: fallback, busy: true });
    broadcastList();
    const others = activeRunnableProviders().filter(id => id !== fallback);
    const fallbackPrompt = buildPrompt(conversationId, fallback, others, false);
    return { actualWho: fallback, reply: await invokeProviderWithPrompt(fallback, fallbackPrompt, conversationId) };
  }
}

async function runTurn(who, { allowPass, autoChain, generation, conversationId }) {
  const c = conversations.get(conversationId);
  if (!c) { console.log(`[runTurn] SKIP ${who}: unknown conv ${conversationId}`); return; }
  const rt = getRuntime(c);
  const tag = conversationId.slice(0, 8);
  console.log(`[runTurn ${tag}] enter who=${who} allowPass=${allowPass} autoChain=${autoChain} gen=${generation} currentGen=${rt.chainGeneration} busy=${rt.busy[who]}`);
  if (!providerCanRun(who)) {
    const fallback = pickFallbackProvider(who);
    if (!fallback) {
      addMessage(conversationId, 'system', `${providerLabel(who)} is not available and no fallback provider is ready.`);
      return;
    }
    who = fallback;
  }
  if (rt.busy[who]) {
    console.log(`[runTurn ${tag}] SKIP ${who}: already busy in this conv`);
    return;
  }
  if (autoChain && generation !== rt.chainGeneration) {
    console.log(`[runTurn ${tag}] SKIP ${who}: gen mismatch (${generation} != ${rt.chainGeneration})`);
    return;
  }
  rt.busy[who] = true;
  const busyIds = new Set([who]);
  broadcast({ type: 'busy', conversationId, who, busy: true });
  broadcastList();
  console.log(`[runTurn ${tag}] ${who} START invoking provider`);
  const startedAt = Date.now();

  try {
    const others = activeRunnableProviders().filter(id => id !== who);
    const prompt = buildPrompt(conversationId, who, others, allowPass);
    const { actualWho, reply } = await invokeWithFallback(who, prompt, conversationId, busyIds);

    const elapsedMs = Date.now() - startedAt;
    if (autoChain && generation !== rt.chainGeneration) {
      console.log(`[runTurn ${tag}] ${actualWho} reply received in ${elapsedMs}ms but gen moved (${generation} != ${rt.chainGeneration}). Discarding.`);
      return;
    }

    rt.consecutiveErrors = 0;
    console.log(`[${actualWho} ${tag}] reply (${reply?.length ?? 0} chars in ${elapsedMs}ms):`, JSON.stringify(reply?.slice(0, 200) ?? ''));

    if (allowPass && isPass(reply)) {
      console.log(`[${actualWho} ${tag}] PASSED. Chain ends.`);
      finishChain(conversationId, `${providerLabel(actualWho)} passed (nothing to add).`);
      return;
    }

    if (!reply || !reply.trim()) {
      addMessage(conversationId, 'system', `${providerLabel(actualWho)} returned an empty reply.`);
      return;
    }

    addMessage(conversationId, actualWho, reply);

    if (autoChain && groupChat) {
      rt.chainTurnsUsed++;
      if (looksLikeAgreement(reply)) rt.consecutiveAgreementTurns++;
      else rt.consecutiveAgreementTurns = 0;
      const turnLimit = chainLimitForMode();
      const runtimeMs = rt.chainStartedAt ? Date.now() - rt.chainStartedAt : 0;
      const runtimeLimitMs = appSettings.stopRules.maxRuntimeMinutes * 60 * 1000;
      if (rt.chainTurnsUsed >= turnLimit) {
        finishChain(conversationId, `Group chat turn cap (${turnLimit}) reached. Send another message to restart.`);
        return;
      }
      if (runtimeLimitMs > 0 && runtimeMs >= runtimeLimitMs) {
        finishChain(conversationId, `Group chat runtime cap (${appSettings.stopRules.maxRuntimeMinutes}m) reached. Send another message to restart.`);
        return;
      }
      if (appSettings.stopRules.stopAfterAgreementTurns > 0 && rt.consecutiveAgreementTurns >= appSettings.stopRules.stopAfterAgreementTurns) {
        finishChain(conversationId, `Stop rule fired: ${rt.consecutiveAgreementTurns} agreement-like turns in a row.`);
        return;
      }
      if (rt.pendingInterject) {
        console.log(`[chain ${tag}] user interject pending; not scheduling next turn after ${actualWho}`);
        return;
      }
      const next = nextProviderAfter(actualWho);
      if (!next || next === actualWho) {
        finishChain(conversationId, 'No other runnable provider is available. Chain paused.');
        return;
      }
      console.log(`[chain ${tag}] turn ${rt.chainTurnsUsed}/${turnLimit}, scheduling ${next}`);
      scheduleChainTurn(next, generation, conversationId);
    }
  } catch (e) {
    console.error(`[runTurn ${tag}] ${who} ERROR:`, e?.stack || e?.message || e);
    if (autoChain && generation !== rt.chainGeneration) {
      console.log(`[runTurn ${tag}] ${who} error on stale gen; suppressing system message`);
    } else if (isCancellationKill(e)) {
      console.log(`[runTurn ${tag}] ${who} cancelled by user action; suppressing system message`);
    } else {
      rt.consecutiveErrors++;
      addMessage(conversationId, 'system', `Error invoking ${who}: ${e.message}`);
      if (rt.consecutiveErrors >= appSettings.stopRules.maxConsecutiveErrors) {
        finishChain(conversationId, `Stop rule fired: ${rt.consecutiveErrors} provider errors in a row.`);
      }
    }
  } finally {
    for (const id of busyIds) {
      rt.busy[id] = false;
      broadcast({ type: 'busy', conversationId, who: id, busy: false });
    }
    broadcastList();
    console.log(`[runTurn ${tag}] ${who} DONE (busy cleared)`);
  }
}

function scheduleChainTurn(who, generation, conversationId, delay = 250) {
  const c = conversations.get(conversationId);
  if (!c) return;
  const rt = getRuntime(c);
  const tag = conversationId.slice(0, 8);
  rt.chainOwner = who;
  setTimeout(() => {
    if (rt.busy[who] || !groupChat || generation !== rt.chainGeneration || rt.chainOwner !== who || rt.pendingInterject) {
      console.log(`[chain ${tag}] skipped ${who}: busy=${rt.busy[who]}, gc=${groupChat}, gen-match=${generation === rt.chainGeneration}, owner-match=${rt.chainOwner === who}, interject=${!!rt.pendingInterject}`);
      return;
    }
    rt.chainOwner = null;
    runTurn(who, { allowPass: true, autoChain: true, generation, conversationId });
  }, delay);
}

function runArbiterWhenIdle(conversationId, generation, polls = 0) {
  const c = conversations.get(conversationId);
  if (!c) return;
  const rt = getRuntime(c);
  if (generation !== rt.chainGeneration) return;
  if (Object.values(rt.busy).some(Boolean) && polls < 240) {
    setTimeout(() => runArbiterWhenIdle(conversationId, generation, polls + 1), 500);
    return;
  }
  if (!Object.values(rt.busy).some(Boolean)) runArbiter(conversationId);
}

// If a user message starts with a model name (e.g. "opus, ..." or "@gpt ..."),
// return the provider id of the addressed model so the chain can be routed
// to that model only. Returns null if no direct address is detected.
function detectAddressedProvider(text) {
  if (!text || typeof text !== 'string') return null;
  const head = text.trimStart().toLowerCase();
  // Match @name or name as the FIRST token, followed by punctuation or space.
  if (/^@?(opus|claude)\b[\s,:.!?\-]/.test(head)) return 'claude';
  if (/^@?(gpt(?:[-.\d]*)?|codex)\b[\s,:.!?\-]/.test(head)) return 'codex';
  return null;
}

function kickOffFreshChain(c, reason, opts = {}) {
  const rt = getRuntime(c);
  const tag = c.id.slice(0, 8);
  rt.chainGeneration++;
  rt.chainTurnsUsed = 0;
  rt.chainOwner = null;
  rt.chainStartedAt = Date.now();
  rt.consecutiveAgreementTurns = 0;
  rt.consecutiveErrors = 0;
  rt.pendingInterject = false;
  const generation = rt.chainGeneration;
  if (!groupChat) return;
  const mode = modeConfig();

  // If the user explicitly addressed one model, run only that model with
  // autoChain disabled so the other model does NOT pile on. Falls back to
  // normal multi-starter behavior if the target is disabled or not runnable.
  const runnable = activeRunnableProviders();
  const target = opts.targetProvider;
  const directedToOne = target && PROVIDER_BY_ID[target] && runnable.includes(target);
  const starters = directedToOne
    ? [target]
    : (mode.startAll ? runnable : runnable.slice(0, 1));

  if (!starters.length) {
    addMessage(c.id, 'system', 'No enabled provider is currently runnable. Enable a provider or wait for rate limits to reset.');
    return;
  }
  const autoChainEffective = directedToOne ? false : !!mode.autoChain;
  console.log(`[chain ${tag}] starting fresh chain gen=${generation} (${reason || 'manual'})${directedToOne ? ` directed=${target}` : ''}`);
  starters.forEach((id, idx) => {
    setTimeout(() => {
      if (!groupChat || generation !== rt.chainGeneration) return;
      runTurn(id, { allowPass: false, autoChain: autoChainEffective, generation, conversationId: c.id });
    }, 150 + (idx * 40));
  });
  if (!directedToOne && mode.autoArbitrate && !mode.autoChain) {
    setTimeout(() => runArbiterWhenIdle(c.id, generation), 1000);
  }
}

function startFreshChainForUserMessages(c, messages) {
  for (const m of messages) addMessage(c.id, 'user', m);
  kickOffFreshChain(c, `user-message x${messages.length}`);
}

app.post('/api/user-message', (req, res) => {
  const { content, conversationId } = req.body || {};
  if (!content || !content.trim()) return res.status(400).json({ error: 'empty content' });
  const c = conversationId ? conversations.get(conversationId) : pickDefaultConversation();
  if (!c) return res.status(404).json({ error: 'unknown conversation' });
  const rt = getRuntime(c);
  const tag = c.id.slice(0, 8);
  const trimmed = content.trim();
  console.log(`[user-message ${tag}] received (${content.length} chars), busy=${JSON.stringify(rt.busy)}, gen=${rt.chainGeneration}`);
  res.json({ ok: true });

  // If not in group chat, just record the message and let direct invokes handle replies.
  if (!groupChat) {
    addMessage(c.id, 'user', trimmed);
    return;
  }

  const inFlight = Object.values(rt.busy).some(Boolean);

  // Always append the user's message to the transcript IMMEDIATELY so it
  // shows up in the chat right away. This is true whether or not a reply
  // is currently in flight; the user expects to see what they sent.
  addMessage(c.id, 'user', trimmed);

  // Detect direct addressing like "opus, ..." or "@gpt ..." so the chain
  // can be routed to that single model only.
  const target = detectAddressedProvider(trimmed);
  if (target) console.log(`[user-message ${tag}] addressed directly to ${target}`);

  if (!inFlight) {
    // Nothing running: kick off a fresh chain right away.
    kickOffFreshChain(c, 'user-message immediate', { targetProvider: target });
    return;
  }

  // An in-flight reply (chat turn or arbiter) is still running. Do NOT kill
  // it. Mark that an interject is pending so the chain stops scheduling new
  // turns after the current one, then wait for the in-flight to finish and
  // kick off a fresh chain so the models reply to the new user message.
  // Remember the most recently addressed model so the next chain is routed
  // correctly even when the user typed during an in-flight reply.
  rt.pendingTarget = target || null;
  if (rt.pendingInterject) {
    console.log(`[user-message ${tag}] another message queued (already waiting for in-flight to finish)`);
    return;
  }
  rt.pendingInterject = true;
  console.log(`[user-message ${tag}] in-flight reply still running; will start fresh chain when it clears`);

  let polls = 0;
  const poll = setInterval(() => {
    polls++;
    const stillBusy = Object.values(rt.busy).some(Boolean);
    if (!stillBusy) {
      clearInterval(poll);
      const queuedTarget = rt.pendingTarget || null;
      rt.pendingTarget = null;
      console.log(`[user-message ${tag}] in-flight cleared after ${polls} polls; starting fresh chain${queuedTarget ? ` directed=${queuedTarget}` : ''}`);
      kickOffFreshChain(c, 'user-message post-interject', { targetProvider: queuedTarget });
    } else if (polls > 12000) {
      clearInterval(poll);
      rt.pendingInterject = false;
      rt.pendingTarget = null;
      console.log(`[user-message ${tag}] interject wait timed out after 20 minutes; bailing`);
    }
  }, 100);
});

app.post('/api/invoke', (req, res) => {
  const { who, conversationId } = req.body || {};
  if (!PROVIDER_BY_ID[who]) {
    return res.status(400).json({ error: 'unknown provider' });
  }
  const c = conversationId ? conversations.get(conversationId) : pickDefaultConversation();
  if (!c) return res.status(404).json({ error: 'unknown conversation' });
  const rt = getRuntime(c);
  console.log(`[invoke ${c.id.slice(0,8)}] direct ask: who=${who}, busy=${JSON.stringify(rt.busy)}`);
  if (rt.busy[who]) return res.status(409).json({ error: `${who} is already thinking in this chat` });
  if (!providerCanRun(who) && !pickFallbackProvider(who)) return res.status(409).json({ error: `${providerLabel(who)} is not runnable and no fallback is ready` });
  res.json({ ok: true, accepted: true });
  runTurn(who, { allowPass: false, autoChain: false, generation: rt.chainGeneration, conversationId: c.id });
});

app.post('/api/mode', (req, res) => {
  const { groupChat: gc, conversationMode } = req.body || {};
  if (typeof gc === 'boolean') groupChat = gc;
  if (MODE_BY_ID[conversationMode]) appSettings.conversationMode = conversationMode;
  appSettings.groupChat = groupChat;
  if (!groupChat) {
    for (const c of conversations.values()) {
      const rt = c.runtime;
      if (rt) { rt.chainGeneration++; rt.chainOwner = null; }
    }
  }
  saveSettings();
  broadcast({ type: 'mode', groupChat, conversationMode: appSettings.conversationMode });
  broadcastSettings();
  res.json({ ok: true, ...settingsPayload() });
});

app.post('/api/settings', (req, res) => {
  const { maxChainTurns: m, activeProviders, fallbackEnabled, providerProfiles, providerPersonas, customProviders, stopRules, conversationMode } = req.body || {};
  // Accept the customProviders array first so subsequent activeProviders /
  // providerProfiles validation against PROVIDER_BY_ID picks up new ids.
  if (Array.isArray(customProviders)) {
    appSettings.customProviders = sanitizeCustomProvidersArray(customProviders);
    rebuildProviderIndex();
    ensureProviderHealth();
  }
  if (typeof m === 'number' && Number.isFinite(m) && m >= 1 && m <= MAX_TURNS_CEILING) {
    maxChainTurns = Math.floor(m);
    appSettings.maxChainTurns = maxChainTurns;
  }
  if (Array.isArray(activeProviders)) {
    const cleaned = activeProviders.filter(id => PROVIDER_BY_ID[id]);
    if (cleaned.length) {
      appSettings.activeProviders = Array.from(new Set(cleaned));
      for (const id of PROVIDER_IDS) {
        if (!appSettings.activeProviders.includes(id)) setProviderHealth(id, { status: 'disabled', lastError: '', resetAt: '' });
        else if (providerHealth[id]?.status === 'disabled') setProviderHealth(id, { status: 'ready', lastError: '', resetAt: '' });
      }
    }
  }
  if (typeof fallbackEnabled === 'boolean') appSettings.fallbackEnabled = fallbackEnabled;
  if (MODE_BY_ID[conversationMode]) appSettings.conversationMode = conversationMode;
  // Accept the new multi-trait profile shape.
  if (providerProfiles && typeof providerProfiles === 'object') {
    for (const id of PROVIDER_IDS) {
      const incoming = providerProfiles[id];
      if (!incoming || typeof incoming !== 'object') continue;
      const traits = Array.isArray(incoming.traits)
        ? Array.from(new Set(incoming.traits.filter(t => PERSONA_BY_ID[t]))).slice(0, MAX_TRAITS_PER_PROVIDER)
        : null;
      const custom = typeof incoming.custom === 'string'
        ? incoming.custom.slice(0, MAX_CUSTOM_INSTRUCTIONS_LEN)
        : null;
      if (!appSettings.providerProfiles[id]) appSettings.providerProfiles[id] = { traits: [], custom: '' };
      if (traits) appSettings.providerProfiles[id].traits = traits;
      if (custom !== null) appSettings.providerProfiles[id].custom = custom;
    }
  }
  // Backward compat: also accept old single-persona shape.
  if (providerPersonas && typeof providerPersonas === 'object') {
    for (const id of PROVIDER_IDS) {
      if (PERSONA_BY_ID[providerPersonas[id]]) {
        appSettings.providerProfiles[id] = { traits: [providerPersonas[id]], custom: appSettings.providerProfiles[id]?.custom || '' };
      }
    }
  }
  if (stopRules && typeof stopRules === 'object') {
    appSettings = sanitizeSettings({ ...appSettings, stopRules });
  }
  groupChat = !!appSettings.groupChat;
  maxChainTurns = appSettings.maxChainTurns;
  saveSettings();
  broadcastSettings();
  res.json({ ok: true, ...settingsPayload() });
});

app.post('/api/custom-providers/:id/test', async (req, res) => {
  const { id } = req.params;
  const provider = PROVIDER_BY_ID[id];
  if (!provider || !provider.custom) return res.status(404).json({ error: 'not a custom provider' });
  const prompt = 'Respond with the single word: OK';
  const startedAt = Date.now();
  try {
    const reply = provider.kind === 'cli'
      ? await invokeCustomCliProvider(provider, prompt, null)
      : await invokeCustomApiProvider(provider, prompt, null);
    res.json({ ok: true, reply: String(reply || '').slice(0, 200), ms: Date.now() - startedAt });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e && e.message || e).slice(0, 400) });
  }
});

app.post('/api/conversations/:id/goal', (req, res) => {
  const { id } = req.params;
  const c = conversations.get(id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const { goal } = req.body || {};
  c.goal = typeof goal === 'string' && goal.trim() ? goal.trim() : null;
  c.updatedAt = Date.now();
  // When the goal changes, refresh the chat's sidebar title so it follows
  // the goal by default. Skipped if the user has manually renamed the chat.
  let titleChanged = false;
  if (!c.titleUserEdited) {
    const auto = deriveAutoTitle(c);
    if (auto && auto !== c.title) {
      c.title = auto;
      titleChanged = true;
    }
  }
  saveConversation(c);
  broadcast({ type: 'goal-updated', conversationId: c.id, goal: c.goal });
  if (titleChanged) broadcastList();
  res.json({ ok: true, goal: c.goal });
});

app.post('/api/stop', (req, res) => {
  const { conversationId } = req.body || {};
  const targets = conversationId
    ? [conversations.get(conversationId)].filter(Boolean)
    : Array.from(conversations.values());
  let killed = 0;
  for (const c of targets) {
    const rt = c.runtime ? getRuntime(c) : null;
    if (!rt) continue;
    killed += rt.activeProcesses.size;
    cancelChain(c.id, conversationId ? 'user clicked Stop for this chat' : 'user clicked Stop (all)');
    for (const id of PROVIDER_IDS) {
      rt.busy[id] = false;
      broadcast({ type: 'busy', conversationId: c.id, who: id, busy: false });
    }
    let mutated = false;
    for (const t of c.tasks) {
      if (t.status === 'running') {
        t.status = 'blocked';
        t.output = (t.output || '') + (t.output ? '\n\n' : '') + 'Stopped by user.';
        t.completedAt = Date.now();
        mutated = true;
        broadcast({ type: 'task-updated', conversationId: c.id, task: t });
      }
    }
    if (mutated) {
      c.updatedAt = Date.now();
      saveConversation(c);
    }
    addMessage(c.id, 'system', `Stopped by user.`);
  }
  broadcastList();
  res.json({ ok: true, killed });
});

app.post('/api/conversations/:id/rename', (req, res) => {
  const { id } = req.params;
  const c = conversations.get(id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const { title } = req.body || {};
  if (typeof title !== 'string') return res.status(400).json({ error: 'title must be a string' });
  const trimmed = title.trim();
  if (trimmed.length) {
    c.title = trimmed.slice(0, 200);
    // Manual rename: pin this title so the goal change never overwrites it.
    c.titleUserEdited = true;
  } else {
    // Clearing the title returns the chat to auto-title mode.
    c.title = null;
    c.titleUserEdited = false;
    const auto = deriveAutoTitle(c);
    if (auto) c.title = auto;
  }
  c.updatedAt = Date.now();
  saveConversation(c);
  broadcastList();
  res.json({ ok: true, title: c.title });
});

app.post('/api/conversations/:id/run-arbiter', async (req, res) => {
  const { id } = req.params;
  if (!conversations.has(id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
  runArbiter(id);
});

app.post('/api/tasks/:taskId/status', (req, res) => {
  const { taskId } = req.params;
  const { status } = req.body || {};
  const valid = ['proposed', 'approved', 'running', 'reviewing', 'done', 'blocked'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'invalid status' });
  for (const c of conversations.values()) {
    const t = c.tasks.find(t => t.id === taskId);
    if (t) {
      t.status = status;
      t.updatedAt = Date.now();
      c.updatedAt = Date.now();
      saveConversation(c);
      broadcast({ type: 'task-updated', conversationId: c.id, task: t });
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'task not found' });
});

app.post('/api/tasks/:taskId/run', (req, res) => {
  const found = findTask(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'task not found' });
  const { conversation, task } = found;
  if (task.owner === 'user') return res.status(400).json({ error: 'user-owned tasks cannot be dispatched to a worker' });
  if (!PROVIDER_BY_ID[task.owner]?.worker) return res.status(400).json({ error: `${providerLabel(task.owner)} does not support worker execution yet` });
  if (task.status === 'running') return res.status(409).json({ error: 'task already running' });
  res.json({ ok: true });
  runTask(conversation.id, task.id);
});

app.post('/api/tasks/:taskId/send-to-chat', (req, res) => {
  const found = findTask(req.params.taskId);
  if (!found) return res.status(404).json({ error: 'task not found' });
  const { conversation, task } = found;
  const head = task.output ? task.output.split('\n').slice(0, 40).join('\n') : '(no output captured)';
  addMessage(conversation.id, 'system', `User sent task **"${task.description}"** back to the council for review. Worker output:\n\n${head}`);
  task.status = 'proposed';
  task.completedAt = 0;
  conversation.updatedAt = Date.now();
  saveConversation(conversation);
  broadcast({ type: 'task-updated', conversationId: conversation.id, task });
  res.json({ ok: true });
});

app.delete('/api/tasks/:taskId', (req, res) => {
  const { taskId } = req.params;
  for (const c of conversations.values()) {
    const idx = c.tasks.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      c.tasks.splice(idx, 1);
      c.updatedAt = Date.now();
      saveConversation(c);
      broadcast({ type: 'task-deleted', conversationId: c.id, taskId });
      return res.json({ ok: true });
    }
  }
  res.status(404).json({ error: 'task not found' });
});

app.post('/api/conversations/new', (req, res) => {
  const c = createConversation();
  broadcastList();
  res.json({ ok: true, id: c.id });
});

app.get('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  const c = conversations.get(id);
  if (!c) return res.status(404).json({ error: 'not found' });
  const rt = getRuntime(c);
  res.json({
    id: c.id,
    title: c.title,
    goal: c.goal,
    baselinePlan: c.baselinePlan,
    tasks: c.tasks,
    messages: c.messages,
    busy: { ...rt.busy },
    chainTurnsUsed: rt.chainTurnsUsed,
    settings: settingsPayload(),
  });
});

app.get('/api/conversations', (req, res) => {
  res.json({ list: conversationListPayload() });
});

app.get('/api/providers', (req, res) => {
  res.json(settingsPayload());
});

app.post('/api/conversations/:id/select', (req, res) => {
  const { id } = req.params;
  if (!conversations.has(id)) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.post('/api/conversations/:id/clear', (req, res) => {
  const { id } = req.params;
  const c = conversations.get(id);
  if (!c) return res.status(404).json({ error: 'not found' });
  cancelChain(c.id, `cleared chat`);
  c.messages = [];
  c.title = null;
  // Clearing puts the chat back into auto-title mode; the goal (if still
  // set) will become the title immediately via the deriveAutoTitle fallback.
  c.titleUserEdited = false;
  const auto = deriveAutoTitle(c);
  if (auto) c.title = auto;
  c.updatedAt = Date.now();
  saveConversation(c);
  broadcast({ type: 'switched', conversationId: c.id, transcript: c.messages });
  broadcastList();
  res.json({ ok: true });
});

app.delete('/api/conversations/:id', (req, res) => {
  const { id } = req.params;
  if (!conversations.has(id)) return res.status(404).json({ error: 'not found' });
  cancelChain(id, 'deleted chat');
  conversations.delete(id);
  deleteConversationFile(id);
  broadcastList();
  res.json({ ok: true });
});

app.get('/c/:slug', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

loadConversations();
if (conversations.size === 0) createConversation();

server.listen(PORT, HOST, () => {
  console.log(`LocalCouncil running at http://${HOST}:${PORT}`);
  console.log(`groupChat=${groupChat}, maxChainTurns=${maxChainTurns}, conversations=${conversations.size}`);
});
