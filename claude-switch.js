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
const LIMITS_FILE = path.join(PROFILES_DIR, '.limits.json');
const AUTO_LOG = path.join(PROFILES_DIR, 'auto.log');

// Claude Code's usage limit resets within 5 hours, so an account that hit it
// more recently than this is skipped by auto-switch.
const LIMIT_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const HOOK_COMMAND = `node "${__filename.replace(/\\/g, '/')}" --hook`;

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
  claude-switch --auto [on]     switch automatically when an account hits its usage limit
  claude-switch --auto off      turn auto-switch off
  claude-switch --auto status   show whether auto-switch is on
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

const readJsonOr = (file, fallback) => (fs.existsSync(file) ? readJson(file) : fallback);

function isOurHook(entry) {
  return (entry.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('claude-switch') && h.command.includes('--hook'));
}

// Removes any existing claude-switch hook, so re-running "on" never duplicates it.
function withoutOurHook(settings) {
  const entries = (settings.hooks && settings.hooks.StopFailure) || [];
  const kept = entries.filter((entry) => !isOurHook(entry));
  if (kept.length) settings.hooks.StopFailure = kept;
  else if (settings.hooks) delete settings.hooks.StopFailure;
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  return settings;
}

function cmdAuto(mode = 'on') {
  const settings = readJsonOr(SETTINGS_FILE, {});
  const enabled = ((settings.hooks && settings.hooks.StopFailure) || []).some(isOurHook);

  if (mode === 'status') {
    console.log(`Auto-switch is ${enabled ? 'on' : 'off'}.`);
    if (fs.existsSync(AUTO_LOG)) console.log(`Log: ${AUTO_LOG}`);
    return;
  }
  if (mode !== 'on' && mode !== 'off') throw new UserError('Usage: claude-switch --auto [on|off|status]');

  withoutOurHook(settings);
  if (mode === 'on') {
    settings.hooks = settings.hooks || {};
    settings.hooks.StopFailure = settings.hooks.StopFailure || [];
    settings.hooks.StopFailure.push({
      matcher: 'rate_limit',
      hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 30 }],
    });
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJson(SETTINGS_FILE, settings);

  if (mode === 'off') return console.log('Auto-switch is off.');
  console.log('Auto-switch is on. When an account hits its usage limit, the next one is switched in;');
  console.log('type "continue" (or start a new session) to carry on.');
  if (savedProfiles().length < 2) console.log('Note: save at least 2 accounts first (claude-switch save).');
}

function logAuto(message) {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
  fs.appendFileSync(AUTO_LOG, `${new Date().toISOString()} ${message}\n`);
}

// Called by Claude Code's StopFailure hook, with the hook event as JSON on stdin.
function cmdHook() {
  let event = {};
  try {
    event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    // No or bad input: fall through and treat it as a usage-limit event, since the matcher already filtered.
  }
  if (event.error && event.error !== 'rate_limit') return;

  const profiles = savedProfiles();
  if (profiles.length < 2) return logAuto('limit hit, but fewer than 2 accounts are saved');

  const current = syncCurrentProfile(profiles);
  const limits = readJsonOr(LIMITS_FILE, {});
  limits[current.accountUuid] = Date.now();
  writeJson(LIMITS_FILE, limits);

  // Try the other accounts in order, starting after the current one, skipping recently limited ones.
  const start = profiles.findIndex((p) => p.accountUuid === current.accountUuid);
  const target = profiles
    .map((_, i) => profiles[(start + 1 + i) % profiles.length])
    .find((p) => p.accountUuid !== current.accountUuid
      && Date.now() - (limits[p.accountUuid] || 0) >= LIMIT_COOLDOWN_MS
      && (p.claudeAiOauth.refreshTokenExpiresAt || Infinity) > Date.now());

  let message;
  if (target) {
    activate(target);
    message = `claude-switch: ${current.email} hit its usage limit. Switched to ${target.email}. Type "continue" to carry on.`;
  } else {
    message = `claude-switch: ${current.email} hit its usage limit, and every other saved account hit its limit in the last 5 hours.`;
  }
  logAuto(message.replace('claude-switch: ', ''));
  console.log(JSON.stringify({ systemMessage: message }));
}

// ----------------------------------------------------------------------------

function main(args) {
  const [command, arg] = args;
  if (command === 'help' || command === '-h' || command === '--help') return console.log(HELP);
  if (command === 'save') return cmdSave();
  if (command === 'list') return cmdList();
  if (command === '--auto' || command === 'auto') return cmdAuto(arg);
  if (command === '--hook') return cmdHook();
  return cmdSwitch(command);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  const message = err instanceof UserError ? err.message : err.stack;
  if (process.argv[2] === '--hook') logAuto(`error: ${message}`);
  console.error(`claude-switch: ${message}`);
  process.exit(1);
}
