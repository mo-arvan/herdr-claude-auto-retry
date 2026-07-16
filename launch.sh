#!/bin/sh

PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${HOME}/.local/bin:${PATH}"

sub="$1"
[ -n "$sub" ] || { echo "launch.sh: missing subcommand" >&2; exit 2; }
shift

dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

newest_node() {
  base="$1"; rel="$2"
  [ -d "$base" ] || return 1
  best=""; bestv=""
  for d in "$base"/*; do
    [ -x "$d/$rel" ] || continue
    v="$(basename "$d")"
    if [ -z "$bestv" ] || [ "$(printf '%s\n%s\n' "$bestv" "$v" | sort -V | tail -n1)" = "$v" ]; then
      bestv="$v"; best="$d/$rel"
    fi
  done
  [ -n "$best" ] && printf '%s\n' "$best"
}

resolve_node() {
  [ -n "$HERDR_NODE" ] && [ -x "$HERDR_NODE" ] && { printf '%s\n' "$HERDR_NODE"; return 0; }
  n="$(command -v node 2>/dev/null)"; [ -n "$n" ] && { printf '%s\n' "$n"; return 0; }

  for f in "${FNM_DIR:-}" "${HOME}/.local/share/fnm" "${HOME}/.fnm" "${HOME}/Library/Application Support/fnm"; do
    [ -n "$f" ] || continue
    [ -x "$f/aliases/default/installation/bin/node" ] && { printf '%s\n' "$f/aliases/default/installation/bin/node"; return 0; }
    n="$(newest_node "$f/node-versions" "installation/bin/node")"; [ -n "$n" ] && { printf '%s\n' "$n"; return 0; }
  done

  n="$(newest_node "${HOME}/.nvm/versions/node" "bin/node")"; [ -n "$n" ] && { printf '%s\n' "$n"; return 0; }

  for c in "${HOME}/.local/share/mise/shims/node" "${HOME}/.asdf/shims/node" "${HOME}/.volta/bin/node"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  n="$(newest_node "${HOME}/.local/share/mise/installs/node" "bin/node")"; [ -n "$n" ] && { printf '%s\n' "$n"; return 0; }
  n="$(newest_node "${HOME}/.asdf/installs/nodejs" "bin/node")"; [ -n "$n" ] && { printf '%s\n' "$n"; return 0; }

  return 1
}

NODE="$(resolve_node)"
if [ -z "$NODE" ]; then
  echo "claude-auto-retry: could not find a node binary. Install Node >= 18, or set HERDR_NODE to its absolute path." >&2
  exit 127
fi

exec "$NODE" "${dir}/bin/main.js" "$sub" "$@"
