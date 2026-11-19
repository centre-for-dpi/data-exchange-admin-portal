#!/bin/sh
# Starts Alertmanager with alertmanager.yml and the operator's mail settings (M-28): where alerts
# go (DEN_ALERT_EMAIL_TO) and through which SMTP server (DEN_ALERT_SMTP_*). Without them, the
# file's: Mailpit and a placeholder address, as in development. The configuration is written to
# /tmp and checked with amtool before Alertmanager starts; the password goes to a file of its own.
# Values cannot contain a single quote.
set -eu
umask 077
dir=/tmp/den
mkdir -p "$dir"
config="$dir/alertmanager.yml"
for value in "${DEN_ALERT_SMTP_SMARTHOST:-}" "${DEN_ALERT_SMTP_FROM:-}" "${DEN_ALERT_EMAIL_TO:-}" \
  "${DEN_ALERT_SMTP_USER:-}"; do
  case $value in *\'*) echo "DEN_ALERT_*: a value contains a single quote" >&2; exit 1 ;; esac
done
{
  echo 'global:'
  echo "  smtp_smarthost: '${DEN_ALERT_SMTP_SMARTHOST:-mailpit:1025}'"
  echo "  smtp_from: '${DEN_ALERT_SMTP_FROM:-alertas@den.example}'"
  echo "  smtp_require_tls: ${DEN_ALERT_SMTP_REQUIRE_TLS:-false}"
  if [ -n "${DEN_ALERT_SMTP_USER:-}" ]; then
    printf '%s' "${DEN_ALERT_SMTP_PASSWORD:-}" >"$dir/smtp-password"
    echo "  smtp_auth_username: '${DEN_ALERT_SMTP_USER}'"
    echo "  smtp_auth_password_file: $dir/smtp-password"
  fi
  # The rest of the file (routes, receivers), with the operator's address.
  sed -n '/^route:/,$p' /etc/alertmanager/alertmanager.yml |
    sed "s|'operaciones@den.example'|'${DEN_ALERT_EMAIL_TO:-operaciones@den.example}'|"
} >"$config"
amtool check-config "$config" >/dev/null
exec /bin/alertmanager --config.file="$config" --storage.path=/alertmanager "$@"
