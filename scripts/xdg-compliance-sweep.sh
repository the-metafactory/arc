#!/bin/bash
#
# XDG compliance sweep (arc#325, epic arc#316 WS7). For one migrated repo:
# fresh `arc install` in a clean XDG-isolated environment (a throwaway HOME +
# XDG_* pointing into a temp dir), then assert the spec §3.2 / compass
# standards/xdg-base-directories.md matrix. Run once per repo; aggregate the
# lines into the repo × check matrix.
#
# Usage:
#   scripts/xdg-compliance-sweep.sh <repo-name> [<arc-cli-path>] [<install-source>]
#
#   <repo-name>        the-metafactory repo, e.g. metafactory-skill-code-review.
#   <arc-cli-path>     arc CLI entrypoint to test (default: this repo's src/cli.ts,
#                      so the build under test is whatever tree you run from).
#   <install-source>   what to install (default: the public https URL). For a
#                      PRIVATE repo where the sandbox blocks arc's own
#                      credentialed git-https, pre-fetch it with authenticated
#                      `gh repo clone` and pass a `file://<path>` here — the XDG
#                      placement behavior is identical regardless of fetch path.
#
# Checks (spec §3.2 — substrate homes like ~/.claude are EXEMPT):
#   1. clone lands under $XDG_DATA_HOME/metafactory/arc/repos/<repo>
#   2. any CLI shim lands in ~/.local/bin (never ~/bin)
#   3. nothing written to ~/bin
#   4. nothing written to the legacy ~/.config/metafactory/pkg
#   5. no dot-prefixed STATE files arc writes into the XDG dirs (the cloned repo
#      subtree is pruned — its own .gitignore/.github are committed repo content,
#      not arc state; arc-bootstrap .gitkeep placeholders are counted separately)
set -u
REPO="$1"
ARC_CLI="${2:-$(cd "$(dirname "$0")/.." && pwd)/src/cli.ts}"
SRC="${3:-https://github.com/the-metafactory/$REPO}"

ROOT="$(mktemp -d)/xdg-sweep-$REPO"
export HOME="$ROOT/home"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_STATE_HOME="$HOME/.local/state"
export XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"
ARC="bun run $ARC_CLI"

INSTALL_OUT=$($ARC install "$SRC" -y 2>&1)
INSTALL_RC=$?

CLONE_DIR="$XDG_DATA_HOME/metafactory/arc/repos/$REPO"
[ -d "$CLONE_DIR" ] && C_CLONE="PASS" || C_CLONE="FAIL"

SHIMS_LOCAL=$(ls "$HOME/.local/bin" 2>/dev/null | grep -v '^\.' | tr '\n' ' ')
[ -n "$SHIMS_LOCAL" ] && C_SHIMS="shims: $SHIMS_LOCAL" || C_SHIMS="no shims"

HOMEBIN=$(ls -A "$HOME/bin" 2>/dev/null | tr '\n' ' ')
[ -z "$HOMEBIN" ] && C_HOMEBIN="PASS" || C_HOMEBIN="FAIL ($HOMEBIN)"

if [ -e "$XDG_CONFIG_HOME/metafactory/pkg" ]; then C_PKG="FAIL"; else C_PKG="PASS"; fi

DOTFILES=$(find "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \
  -path '*/repos/*' -prune -o \
  -type f -name '.*' ! -name '.gitkeep' -print 2>/dev/null | sed "s|$HOME|~|" | tr '\n' ' ')
GITKEEPS=$(find "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" \
  -path '*/repos/*' -prune -o \
  -type f -name '.gitkeep' -print 2>/dev/null | wc -l | tr -d ' ')
[ -z "$DOTFILES" ] && C_DOT="PASS" || C_DOT="FAIL ($DOTFILES)"

echo "REPO=$REPO"
echo "  install_rc=$INSTALL_RC  ($(echo "$INSTALL_OUT" | grep -iE 'Installed|Error|not found|Unsupported' | head -1))"
echo "  clone_under_data_dir=$C_CLONE"
echo "  cli_shim=$C_SHIMS"
echo "  no_home_bin=$C_HOMEBIN"
echo "  no_legacy_pkg=$C_PKG"
echo "  no_dotfiles=$C_DOT  (arc-bootstrap .gitkeep count=$GITKEEPS)"

rm -rf "$ROOT"
