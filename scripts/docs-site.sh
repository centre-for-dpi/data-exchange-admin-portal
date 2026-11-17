#!/usr/bin/env bash
# Builds the GitHub Pages site of the HTML guides into a directory (default: _site).
#
# The guides are authored as page fragments (no doctype, no <html>), so this wraps each one in a
# standards-mode document with its language; links between the English and Spanish versions are
# relative and keep working because the site mirrors docs/guides and docs/es/guides.
set -euo pipefail

cd "$(dirname "$0")/.."
out=${1:-_site}
rm -rf "$out"
mkdir -p "$out/guides" "$out/es/guides"

wrap() { # wrap <lang> <source> <target>
  { printf '<!doctype html>\n<html lang="%s">\n' "$1"; cat "$2"; printf '\n</html>\n'; } >"$3"
}

for f in docs/guides/*.html; do wrap en "$f" "$out/guides/$(basename "$f")"; done
for f in docs/es/guides/*.html; do wrap es "$f" "$out/es/guides/$(basename "$f")"; done
cp docs/site/index.html "$out/index.html"
touch "$out/.nojekyll"

find "$out" -type f | sort
