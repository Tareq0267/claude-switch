# claude-switch

Switch Claude Code between multiple claude.ai accounts with one command, without going through the login flow again. Handy when one account hits its usage limit and you want to keep working on another.

Works with Claude Code in the terminal and in VS Code. Tested on Windows (Git Bash); should also work on Linux. Not supported on macOS, where Claude Code keeps the login in Keychain instead of a file.

## Install

Requires [Node.js](https://nodejs.org).

```bash
git clone https://github.com/Tareq0267/claude-switch.git
cd claude-switch
./install.sh
source ~/.bashrc
```

`install.sh` adds `bin/` to your PATH and creates the `cs` alias in `~/.bashrc`. Running it again is safe.

For cmd or PowerShell instead of bash, add the `bin` folder to your PATH and use `claude-switch.cmd`.

## Setup (once per machine)

Save each account once:

1. In Claude Code, run `/login` and sign in to the first account.
2. Run `claude-switch save`.
3. Repeat for each other account.

## Usage

```bash
cs                  # switch to the next account
cs gmail            # switch to a specific account (any part of its email)
cs list             # show saved accounts; * marks the active one
cs save             # save or update the current login
```

After switching, start a new Claude session. You don't need to reload VS Code.

## Auto-switch

```bash
cs --auto           # turn on: switch when usage reaches 95%
cs --auto 90        # turn on with your own threshold (1-100)
cs --auto status    # show the threshold and the current account's usage
cs --auto off       # turn it off
```

After each Claude reply, auto-switch checks the current account's usage. When its 5-hour or weekly usage reaches the threshold, the next saved account is switched in and Claude shows a message, so you switch before ever hitting the wall.

If a reply hits the limit before the threshold is reached, auto-switch switches right away instead. That reply still fails; type `continue` (or start a new session) to carry on.

Notes:

- Usage is checked at most every 2 minutes, and after every reply once it's within 10% of the threshold. Each check is a single small request to the same usage endpoint Claude Code's own usage panel uses.
- An account that's used up is skipped until its limit resets. If every account is used up, nothing is switched and you're told once.
- Every auto-switch is logged in `~/.claude/accounts/auto.log`.
- It works by adding a `Stop` hook and a `StopFailure` hook to `~/.claude/settings.json`. Your other settings and hooks are left alone, and `cs --auto off` removes only these. If you move the repo folder, run `cs --auto` again so the hooks point to the new location.
- The usage endpoint isn't a public API, so a Claude Code update could change it. If it does, the percentage check quietly stops (the log says why), and switching when you actually hit the limit still works.

## How it works

Claude Code keeps the login in two files:

- `~/.claude/.credentials.json`: the claude.ai OAuth tokens (`claudeAiOauth`)
- `~/.claude.json`: the account details (`oauthAccount`) plus some per-account caches

`claude-switch save` copies those parts into `~/.claude/accounts/<email>.json`. Switching writes another account's copy back in. Logins for MCP servers and all other settings stay untouched.

Logins refresh themselves while in use, so before switching away the script re-saves the current account, keeping every saved copy up to date.

## Notes

- **Saved logins are passwords.** `~/.claude/accounts/` holds live tokens. Don't commit, sync or share it. Each machine saves its own logins.
- **Saved logins expire** if an account goes unused for about 30 days. `cs list` shows the dates. If one expires, run `/login` for that account and `cs save` again.
- **Backup:** both files as they were before the most recent switch are copied to `~/.claude/accounts/.backup/`.
- Set `CLAUDE_CONFIG_DIR` if you've moved your Claude config somewhere else; the script follows it.
