#!/usr/bin/env bash
# Backwards-compatible AWS entry point.
#
# The implementation lives in deploy/linux-deploy.sh and supports any systemd
# Linux host (Debian/Ubuntu, RHEL family and Amazon Linux 2023). Existing AWS
# runbooks keep working; new deployments should call linux-deploy.sh directly.
set -euo pipefail
exec bash "$(dirname "${BASH_SOURCE[0]}")/linux-deploy.sh" "$@"
