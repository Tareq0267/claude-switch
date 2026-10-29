#!/usr/bin/env node
// Switch Claude Code between saved claude.ai logins without redoing the login flow.
// Usage: see `claude-switch help`.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CREDS_FILE = path.join(CONFIG_DIR, '.credentials.json');
const STATE_FILE = process.env.CLAUDE_CONFIG_DIR
  ? path.join(CONFIG_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const PROFILES_DIR = path.join(CONFIG_DIR, 'accounts');
const BACKUP_DIR = path.join(PROFILES_DIR, '.backup');
const AUTO_STATE_FILE = path.join(PROFILES_DIR, '.auto-state.json');
const AUTO_LOG = path.join(PROFILES_DIR, 'auto.log');

// The same endpoint Claude Code uses for its usage panel.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_WINDOWS = { five_hour: '5-hour', seven_day: 'weekly' };
const DEFAULT_THRESHOLD = 95;
// Usage is checked after each turn, but at most this often until it gets within 10% of the threshold.
const CHECK_INTERVAL_MS = 2 * 60 * 1000;
// Used when an account hit its limit but the reset time is unknown.
const FALLBACK_LIMIT_MS = 5 * 60 * 60 * 1000;
const SCRIPT_PATH = __filename.replace(/\\/g, '/');

// Account-specific caches in .claude.json, swapped along with the login so
// usage limits and model lists from one account don't show up in the other.
const ACCOUNT_CACHE_KEYS = [
  'modelAccessCache', 'orgModelDefaultCache', 'cachedUsageUtilization', 'passesEligibilityCache',
  'cachedExtraUsageDisabledReason', 'additionalModelOptionsCache', 'additionalModelCostsCache',
  'groveConfigCache', 'cachedArtifactRoster', 'promoStartupStatusCache',
];

const HELP = `claude-switch - swap Claude Code between saved claude.ai accounts

  claude-switch                 switch to the next saved account
  claude-switch <email>         switch to a specific account (partial match ok)
  claude-switch save            save the currently logged-in account
  claude-switch list            list saved accounts (* = active)
  claude-switch --auto [N]      auto-switch when usage reaches N% (default ${DEFAULT_THRESHOLD})
  claude-switch --auto off      turn auto-switch off
  claude-switch --auto status   show auto-switch settings and current usage
  claude-switch help            show this help

After switching, start a new Claude session (or type "continue").`;

class UserError extends Error {}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Write via a temp file so a crash never leaves a half-written config behind.
function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function currentAccount() {
  if (!fs.existsSync(CREDS_FILE)) {
    throw new UserError(`No ${CREDS_FILE} found. Log in with /login first (macOS keeps logins in Keychain and isn't supported).`);
  }
  const creds = readJson(CREDS_FILE);
  const state = readJson(STATE_FILE);
  if (!creds.claudeAiOauth || !state.oauthAccount) {
    throw new UserError('Not logged in with a claude.ai account. Run /login first.');
  }

  const caches = {};
  for (const key of ACCOUNT_CACHE_KEYS) {
    if (key in state) caches[key] = state[key];
  }
  return {
    email: state.oauthAccount.emailAddress,
    accountUuid: state.oauthAccount.accountUuid,
    claudeAiOauth: creds.claudeAiOauth,
    organizationUuid: creds.organizationUuid,
    oauthAccount: state.oauthAccount,
    caches,
  };
}

function savedProfiles() {
  if (!fs.existsSync(PROFILES_DIR)) return [];
  return fs.readdirSync(PROFILES_DIR)
    .filter((name) => name.endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map((name) => readJson(path.join(PROFILES_DIR, name)));
}

function saveProfile(account) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  const file = path.join(PROFILES_DIR, `${account.email}.json`);
  writeJson(file, { ...account, savedAt: new Date().toISOString() });
  return file;
}

// Logins refresh themselves while in use, so re-save the active one before
// leaving it; otherwise its saved copy would go stale.
function syncCurrentProfile(profiles) {
  const current = currentAccount();
  if (profiles.some((p) => p.accountUuid === current.accountUuid)) saveProfile(current);
  return current;
}

function activate(profile) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(CREDS_FILE, path.join(BACKUP_DIR, '.credentials.json'));
  fs.copyFileSync(STATE_FILE, path.join(BACKUP_DIR, '.claude.json'));

  // Only the claude.ai login is replaced; MCP server logins stay as they are.
  const creds = readJson(CREDS_FILE);
  creds.claudeAiOauth = profile.claudeAiOauth;
  if (profile.organizationUuid !== undefined) creds.organizationUuid = profile.organizationUuid;
  writeJson(CREDS_FILE, creds);

  const state = readJson(STATE_FILE);
  state.oauthAccount = profile.oauthAccount;
  for (const key of ACCOUNT_CACHE_KEYS) delete state[key];
  Object.assign(state, profile.caches);
  writeJson(STATE_FILE, state);
}

function cmdSave() {
  const account = currentAccount();
  console.log(`Saved ${account.email} -> ${saveProfile(account)}`);
}

function cmdList() {
  const profiles = savedProfiles();
  if (!profiles.length) {
    console.log('No saved accounts. Log in to each account and run: claude-switch save');
    return;
  }
  const current = syncCurrentProfile(profiles);
  for (const p of profiles) {
    const marker = p.accountUuid === current.accountUuid ? '*' : ' ';
    const expires = p.claudeAiOauth.refreshTokenExpiresAt
      ? new Date(p.claudeAiOauth.refreshTokenExpiresAt).toLocaleDateString()
      : 'unknown';
    console.log(`${marker} ${p.email}  (${p.claudeAiOauth.subscriptionType}, login valid until ~${expires})`);
  }
}

function cmdSwitch(query) {
  const profiles = savedProfiles();
  if (profiles.length < 2) {
    throw new UserError('Need at least 2 saved accounts. Log in to each account and run: claude-switch save');
  }
  const current = syncCurrentProfile(profiles);

  let target;
  if (query) {
    const matches = profiles.filter((p) => p.email.toLowerCase().includes(query.toLowerCase()));
    if (matches.length !== 1) {
      throw new UserError(`"${query}" matches ${matches.length} accounts. See: claude-switch list`);
    }
    target = matches[0];
  } else {
    const index = profiles.findIndex((p) => p.accountUuid === current.accountUuid);
    target = profiles[(index + 1) % profiles.length];
  }

  if (target.accountUuid === current.accountUuid) {
    console.log(`Already on ${current.email}`);
    return;
  }
  const expiresAt = target.claudeAiOauth.refreshTokenExpiresAt;
  if (expiresAt && expiresAt < Date.now()) {
    throw new UserError(`The saved login for ${target.email} has expired. Run /login for it once, then: claude-switch save`);
  }

  activate(target);
  console.log(`Switched ${current.email} -> ${target.email}`);
  console.log('Start a new Claude session to use it.');
}

// --- auto-switch ------------------------------------------------------------
//
// Two hooks call `claude-switch --hook --at N`:
//   Stop         after every turn: switch once 5-hour or weekly usage reaches N%
//   StopFailure  when a turn fails on the usage limit: switch right away (backstop)

const readJsonOr = (file, fallback) => (fs.existsSync(file) ? readJson(file) : fallback);

const isOurHook = (entry) => (entry.hooks || []).some(
  (h) => typeof h.command === 'string' && h.command.includes('claude-switch') && h.command.includes('--hook'),
);

function installedThreshold(settings) {
  for (const event of ['Stop', 'StopFailure']) {
    for (const entry of (settings.hooks && settings.hooks[event]) || []) {
      if (!isOurHook(entry)) continue;
      const match = entry.hooks.map((h) => h.command).join(' ').match(/--at (\d+)/);
      return match ? Number(match[1]) : DEFAULT_THRESHOLD;
    }
  }
  return null;
}

// Removes our hooks only, so re-running never duplicates them and other hooks survive.
function removeOurHooks(settings) {
  if (!settings.hooks) return;
  for (const event of ['Stop', 'StopFailure']) {
    const kept = (settings.hooks[event] || []).filter((entry) => !isOurHook(entry));
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

async function fetchUsage(accessToken) {
  const res = await fetch(USAGE_URL, {
    headers: { Authorization: `Bearer ${accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`usage request failed (HTTP ${res.status})`);
  return res.json();
}

// The most-used window, plus when the account frees up again if it is at or over the threshold.
function summarizeUsage(usage, threshold) {
  let worst = { pct: 0, name: USAGE_WINDOWS.five_hour };
  let freeAt = 0;
  for (const [key, name] of Object.entries(USAGE_WINDOWS)) {
    const window = usage[key];
    if (!window || typeof window.utilization !== 'number') continue;
    if (window.utilization > worst.pct) worst = { pct: window.utilization, name };
    if (window.utilization >= threshold) {
      freeAt = Math.max(freeAt, Date.parse(window.resets_at) || Date.now() + FALLBACK_LIMIT_MS);
    }
  }
  return { ...worst, freeAt };
}

async function cmdAuto(arg) {
  const settings = readJsonOr(SETTINGS_FILE, {});
  const installed = installedThreshold(settings);

  if (arg === 'status') {
    console.log(installed === null ? 'Auto-switch is off.' : `Auto-switch is on: switches at ${installed}% usage.`);
    try {
      const account = currentAccount();
      const { pct, name } = summarizeUsage(await fetchUsage(account.claudeAiOauth.accessToken), 100);
      console.log(`${account.email} is at ${pct}% of its ${name} limit.`);
    } catch (err) {
      console.log(`Couldn't read current usage: ${err.message}`);
    }
    if (fs.existsSync(AUTO_LOG)) console.log(`Log: ${AUTO_LOG}`);
    return;
  }

  removeOurHooks(settings);
  if (arg === 'off') {
    writeJson(SETTINGS_FILE, settings);
    console.log('Auto-switch is off.');
    return;
  }

  const threshold = arg === undefined || arg === 'on' ? DEFAULT_THRESHOLD : Number(String(arg).replace(/%$/, ''));
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 100) {
    throw new UserError('Usage: claude-switch --auto [1-100|off|status]');
  }
  const hook = { type: 'command', command: `node "${SCRIPT_PATH}" --hook --at ${threshold}`, timeout: 30 };
  settings.hooks = settings.hooks || {};
  settings.hooks.Stop = [...(settings.hooks.Stop || []), { hooks: [hook] }];
  settings.hooks.StopFailure = [...(settings.hooks.StopFailure || []), { matcher: 'rate_limit', hooks: [hook] }];
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJson(SETTINGS_FILE, settings);

  console.log(`Auto-switch is on: switches to the next account when usage reaches ${threshold}%`);
  console.log('(or right away if a turn hits the limit first).');
  if (savedProfiles().length < 2) console.log('Note: save at least 2 accounts first (claude-switch save).');
}

function logAuto(message) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.appendFileSync(AUTO_LOG, `${new Date().toISOString()} ${message}\n`);
}

function readAutoState() {
  return { exhausted: {}, lastCheck: 0, lastPct: 0, ...readJsonOr(AUTO_STATE_FILE, {}) };
}

// Called by Claude Code's hooks, with the hook event as JSON on stdin.
async function cmdHook(args) {
  const atIndex = args.indexOf('--at');
  const threshold = atIndex >= 0 ? Number(args[atIndex + 1]) : DEFAULT_THRESHOLD;
  let event = {};
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    // Unreadable input: treat it as a plain end-of-turn check.
  }
  const hitLimit = event.hook_event_name === 'StopFailure';
  if (hitLimit && event.error !== 'rate_limit') return;

  const profiles = savedProfiles();
  if (profiles.length < 2) return;
  const current = currentAccount();
  const state = readAutoState();
  const now = Date.now();

  let reason;
  let freeAt;
  if (hitLimit) {
    reason = 'hit its usage limit';
    freeAt = now + FALLBACK_LIMIT_MS;
    try {
      freeAt = summarizeUsage(await fetchUsage(current.claudeAiOauth.accessToken), 100).freeAt || freeAt;
    } catch {
      // Keep the fallback reset time.
    }
  } else {
    const nearThreshold = state.lastPct >= threshold - 10;
    if (!nearThreshold && now - state.lastCheck < CHECK_INTERVAL_MS) return;
    state.lastCheck = now;
    let usage;
    try {
      usage = summarizeUsage(await fetchUsage(current.claudeAiOauth.accessToken), threshold);
    } catch (err) {
      writeJson(AUTO_STATE_FILE, state);
      logAuto(`usage check skipped: ${err.message}`);
      return;
    }
    state.lastPct = usage.pct;
    if (usage.pct < threshold) {
      writeJson(AUTO_STATE_FILE, state);
      return;
    }
    reason = `is at ${usage.pct}% of its ${usage.name} limit`;
    freeAt = usage.freeAt;
  }
  state.exhausted[current.accountUuid] = freeAt;

  // Next account in order after the current one that isn't used up or expired.
  const start = profiles.findIndex((p) => p.accountUuid === current.accountUuid);
  const target = profiles
    .map((_, i) => profiles[(start + 1 + i) % profiles.length])
    .find((p) => p.accountUuid !== current.accountUuid
      && (state.exhausted[p.accountUuid] || 0) <= now
      && (p.claudeAiOauth.refreshTokenExpiresAt || Infinity) > now);

  let message;
  if (target) {
    syncCurrentProfile(profiles);
    activate(target);
    Object.assign(state, { lastCheck: 0, lastPct: 0, quietUntil: 0 });
    message = `${current.email} ${reason}. Switched to ${target.email}.`;
    if (hitLimit) message += ' Type "continue" to carry on.';
  } else if ((state.quietUntil || 0) <= now) {
    // Say this once per limit period, not after every turn.
    state.quietUntil = freeAt;
    message = `${current.email} ${reason}, and no other saved account has usage left right now.`;
  }
  writeJson(AUTO_STATE_FILE, state);
  if (!message) return;
  logAuto(message);
  console.log(JSON.stringify({ systemMessage: `claude-switch: ${message}` }));
}

// ----------------------------------------------------------------------------

async function main(args) {
  const [command, arg] = args;
  if (command === 'help' || command === '-h' || command === '--help') return console.log(HELP);
  if (command === 'save') return cmdSave();
  if (command === 'list') return cmdList();
  if (command === '--auto' || command === 'auto') return cmdAuto(arg);
  if (command === '--hook') return cmdHook(args.slice(1));
  return cmdSwitch(command);
}

main(process.argv.slice(2)).catch((err) => {
  const message = err instanceof UserError ? err.message : err.stack;
  if (process.argv[2] === '--hook') logAuto(`error: ${message}`);
  console.error(`claude-switch: ${message}`);
  process.exit(1);
});
