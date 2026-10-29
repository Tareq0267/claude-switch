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
const PROFILES_DIR = path.join(CONFIG_DIR, 'accounts');
const BACKUP_DIR = path.join(PROFILES_DIR, '.backup');

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
  claude-switch help            show this help

After switching, start a new Claude session.`;

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
    .filter((name) => name.endsWith('.json'))
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

function main(args) {
  const [command] = args;
  if (command === 'help' || command === '-h' || command === '--help') return console.log(HELP);
  if (command === 'save') return cmdSave();
  if (command === 'list') return cmdList();
  return cmdSwitch(command);
}

try {
  main(process.argv.slice(2));
} catch (err) {
  console.error(`claude-switch: ${err instanceof UserError ? err.message : err.stack}`);
  process.exit(1);
}
