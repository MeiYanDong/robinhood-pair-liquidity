#!/usr/bin/env bash
set -euo pipefail
umask 022

if [[ ${EUID} -ne 0 ]]; then
  echo "install-release.sh must run as root" >&2
  exit 1
fi

release_source=${1:-}
if [[ -z ${release_source} || ! -d ${release_source}/dashboard ]]; then
  echo "usage: install-release.sh <unpacked-release-directory>" >&2
  exit 1
fi
if [[ ! -s /etc/pair-liquidity-dashboard.env ]]; then
  echo "/etc/pair-liquidity-dashboard.env is missing" >&2
  exit 1
fi
if [[ ! -s ${release_source}/GIT_COMMIT ]]; then
  echo "${release_source}/GIT_COMMIT is missing" >&2
  exit 1
fi
release_commit=$(tr -d '\n' < "${release_source}/GIT_COMMIT")
if [[ ! ${release_commit} =~ ^[0-9a-f]{40}$ ]]; then
  echo "GIT_COMMIT must contain one lowercase 40-character Git SHA" >&2
  exit 1
fi

release_id=$(date -u +%Y%m%dT%H%M%SZ)
release_dir=/opt/pair-liquidity-dashboard/releases/${release_id}

id pairdash >/dev/null 2>&1 || useradd --system --home /var/lib/pair-liquidity-dashboard --shell /usr/sbin/nologin pairdash
install -d -o root -g root -m 0755 /opt/pair-liquidity-dashboard/releases
install -d -o pairdash -g pairdash -m 0750 /var/lib/pair-liquidity-dashboard
install -d -o root -g root -m 0755 "${release_dir}"

cp -a "${release_source}/dashboard" "${release_dir}/dashboard"
install -o root -g root -m 0644 "${release_source}/GIT_COMMIT" "${release_dir}/GIT_COMMIT"
cd "${release_dir}/dashboard"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:root "${release_dir}"
ln -sfn "${release_dir}" /opt/pair-liquidity-dashboard/current

install -o root -g root -m 0644 "${release_dir}/dashboard/deploy/pair-liquidity-dashboard.service" /etc/systemd/system/pair-liquidity-dashboard.service
install -o root -g root -m 0644 "${release_dir}/dashboard/deploy/nginx.conf" /etc/nginx/sites-available/pair-liquidity-dashboard
ln -sfn /etc/nginx/sites-available/pair-liquidity-dashboard /etc/nginx/sites-enabled/pair-liquidity-dashboard
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl daemon-reload
systemctl enable --now nginx pair-liquidity-dashboard
systemctl reload nginx
systemctl restart pair-liquidity-dashboard

# Allow one failed initial refresh plus the next one-minute scheduled cycle.
for _ in $(seq 1 75); do
  if curl --fail --silent --show-error http://127.0.0.1:8080/readyz >/dev/null; then
    echo "pair-liquidity-dashboard installed: ${release_id}"
    exit 0
  fi
  sleep 2
done

systemctl --no-pager --full status pair-liquidity-dashboard >&2 || true
journalctl -u pair-liquidity-dashboard -n 80 --no-pager >&2 || true
exit 1
