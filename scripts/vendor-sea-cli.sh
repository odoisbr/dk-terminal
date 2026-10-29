#!/usr/bin/env bash
#
# Embute o `sea` CLI (gem sea-cli) com um Ruby portátil em vendor/sea-cli, para
# ser copiado ao pacote do SEA Dock como Resources/sea-cli. O macOS traz Ruby 2.6
# e a gem exige 3.2 ou mais recente, por isso o Ruby vai junto.
#
#   bash scripts/vendor-sea-cli.sh
#
# Variáveis:
#   SEA_CLI_VERSION       versão da gem (padrão: 0.29.2)
#   SEA_CLI_GEM           caminho de um sea-cli-<versão>.gem já baixado; sem ele,
#                         o script usa o cache do RubyGems local
#                         (~/.gem ou o gem dir do Ruby ativo) ou baixa do gem
#                         source do Dashboard quando SEA_DASHBOARD_TOKEN existir.
#   SEA_DASHBOARD_TOKEN   PAT do Dashboard, só para baixar a gem (nunca gravado).
#   PORTABLE_RUBY_URL     origem do tarball (padrão: release do Homebrew).
#
# Saída: vendor/sea-cli/{ruby,gems,bin/sea,manifest.json}. A pasta vendor/ não é
# versionada; rode de novo para atualizar a versão.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/vendor/sea-cli"
SEA_CLI_VERSION="${SEA_CLI_VERSION:-0.29.2}"
RUBY_VERSION="3.4.5"
RUBY_ABI="3.4.0"
PORTABLE_RUBY_URL="${PORTABLE_RUBY_URL:-https://github.com/Homebrew/homebrew-portable-ruby/releases/download/${RUBY_VERSION}/portable-ruby-${RUBY_VERSION}.arm64_big_sur.bottle.tar.gz}"
PORTABLE_RUBY_SHA256="20fa657858e44a4b39171d6e4111f8a9716eb62a78ebbd1491d94f90bb7b830a"

die() { printf '\n[sea-cli] %s\n' "$*" >&2; exit 1; }
log() { printf '[sea-cli] %s\n' "$*"; }

[ "$(uname -s)" = Darwin ] || die "este script gera o pacote do macOS (Apple Silicon)."
[ "$(uname -m)" = arm64 ] || die "o Ruby portátil embutido é arm64; esta máquina é $(uname -m)."
command -v curl >/dev/null || die "curl é necessário."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. Ruby portátil, com verificação de integridade antes de qualquer execução.
log "baixando Ruby portátil ${RUBY_VERSION}"
curl -fsSL -o "$work/ruby.tar.gz" "$PORTABLE_RUBY_URL"
got="$(shasum -a 256 "$work/ruby.tar.gz" | cut -d' ' -f1)"
[ "$got" = "$PORTABLE_RUBY_SHA256" ] || die "sha256 do Ruby portátil não confere: $got"
mkdir -p "$work/ruby"
tar -xzf "$work/ruby.tar.gz" -C "$work/ruby"
ruby_home="$work/ruby/portable-ruby/${RUBY_VERSION}"
[ -x "$ruby_home/bin/ruby" ] || die "layout inesperado do tarball do Ruby."

# 2. A gem sea-cli: arquivo informado, cache local ou gem source do Dashboard.
gem_file=""
if [ -n "${SEA_CLI_GEM:-}" ]; then
  gem_file="$SEA_CLI_GEM"
elif [ -n "${SEA_DASHBOARD_TOKEN:-}" ]; then
  log "baixando sea-cli ${SEA_CLI_VERSION} do gem source do Dashboard"
  ( cd "$work" && "$ruby_home/bin/gem" fetch sea-cli -v "$SEA_CLI_VERSION" \
      --source "https://x:${SEA_DASHBOARD_TOKEN}@dashboard.seatecnologia.com.br/gems/" >/dev/null )
  gem_file="$work/sea-cli-${SEA_CLI_VERSION}.gem"
else
  for dir in $(command -v gem >/dev/null && gem env gemdir 2>/dev/null) "$HOME/.gem/ruby"/*; do
    [ -f "$dir/cache/sea-cli-${SEA_CLI_VERSION}.gem" ] && { gem_file="$dir/cache/sea-cli-${SEA_CLI_VERSION}.gem"; break; }
  done
fi
[ -n "$gem_file" ] && [ -f "$gem_file" ] || die "sea-cli ${SEA_CLI_VERSION} não encontrada. Informe SEA_CLI_GEM=<arquivo.gem> ou SEA_DASHBOARD_TOKEN."
log "usando $gem_file"

# 3. Instala a gem e dependências num GEM_HOME próprio, com o Ruby portátil.
rm -rf "$OUT"
mkdir -p "$OUT/gems" "$OUT/bin"
cp -R "$ruby_home" "$OUT/ruby"
log "instalando gems"
( cd "$work" && env -i HOME="$work" PATH="$OUT/ruby/bin:/usr/bin:/bin" GEM_HOME="$OUT/gems" GEM_PATH="$OUT/gems" \
    "$OUT/ruby/bin/gem" install --no-document --install-dir "$OUT/gems" --bindir "$OUT/gems/bin" "$gem_file" >/dev/null )

# 4. Poda o que o CLI não usa: cabeçalhos, objetos de compilação, símbolos,
#    documentação, gems de desenvolvimento e o cache de .gem.
rm -rf "$OUT/ruby/include" "$OUT/ruby/share" "$OUT/ruby/.brew" "$OUT/ruby/ChangeLog" "$OUT/ruby/NEWS.md" "$OUT/ruby/sbom.spdx.json" "$OUT/ruby/INSTALL_RECEIPT.json"
rm -rf "$OUT/gems/cache" "$OUT/gems/doc" "$OUT/gems/build_info"
find "$OUT" \( -name '*.o' -o -name '*.dSYM' -o -name '*.a' \) -prune -exec rm -rf {} +
for extra in bootsnap debug irb rdoc syntax_suggest msgpack; do
  rm -rf "$OUT/ruby/lib/ruby/gems/${RUBY_ABI}/gems/${extra}"-* "$OUT/ruby/lib/ruby/gems/${RUBY_ABI}/specifications/${extra}"-*.gemspec \
         "$OUT/ruby/lib/ruby/gems/${RUBY_ABI}/extensions"/*/*/"${extra}"-*
done
find "$OUT/ruby/bin" -type f ! -name ruby -delete

# 5. Lançador: fixa GEM_HOME no pacote e ignora variáveis de Ruby do usuário.
cat > "$OUT/bin/sea" <<'SH'
#!/bin/sh
here=$(cd "$(dirname "$0")/.." && pwd)
unset RUBYOPT RUBYLIB GEM_SPEC_CACHE BUNDLE_GEMFILE BUNDLER_SETUP
export GEM_HOME="$here/gems" GEM_PATH="$here/gems"
exec "$here/ruby/bin/ruby" "$here/gems/bin/sea" "$@"
SH
chmod 755 "$OUT/bin/sea"

# 6. Prova: o lançador responde com a versão pedida.
got="$("$OUT/bin/sea" version 2>&1)" || die "o sea embutido não executa: $got"
[ "$got" = "$SEA_CLI_VERSION" ] || die "o sea embutido respondeu '$got', esperava $SEA_CLI_VERSION"

cat > "$OUT/manifest.json" <<JSON
{ "sea_cli": "$SEA_CLI_VERSION", "ruby": "$RUBY_VERSION", "ruby_sha256": "$PORTABLE_RUBY_SHA256", "generated": "$(date -u +%Y-%m-%dT%H:%M:%SZ)" }
JSON
log "pronto: $OUT ($(du -sh "$OUT" | cut -f1)), sea $got"
