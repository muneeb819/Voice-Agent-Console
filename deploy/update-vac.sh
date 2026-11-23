#!/usr/bin/env bash
# Voice Agent Console: get the latest code from GitHub and deploy it.
# Usage on the EC2 server:  bash ~/Voice-Agent-Console/deploy/update-vac.sh
set -euo pipefail

# This file lives in the repo it updates, so run from a temporary copy:
# bash must not read a script that git is rewriting.
if [ -z "${VAC_UPDATE_COPY:-}" ]; then
  TMP=$(mktemp /tmp/update-vac.XXXXXX.sh)
  cp "$0" "$TMP"
  VAC_UPDATE_COPY=1 exec bash "$TMP" "$@"
fi

REPO_DIR="$HOME/Voice-Agent-Console"
REPO="muneeb819/Voice-Agent-Console"
INSTALL_DIR="/opt/voice-agent-console"
PUBLIC_IP="54.79.152.235"
KEY="$HOME/.ssh/vac_deploy"

say() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }

# ---------- 1. GitHub access (read-only deploy key) ----------
say "1/6 Checking GitHub access"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "ec2-deploy" >/dev/null
  echo "A deploy key was created. Add it to GitHub ONCE:"
  echo "  github.com/$REPO -> Settings -> Deploy keys -> Add deploy key"
  echo "  Title: EC2 server   (leave 'Allow write access' unticked)"
  echo "  Key (copy this whole line):"
  echo
  cat "$KEY.pub"
  echo
  echo "Then run this script again:  bash ~/Voice-Agent-Console/deploy/update-vac.sh"
  exit 0
fi
if ! grep -q "^Host github-vac" "$HOME/.ssh/config" 2>/dev/null; then
  cat >> "$HOME/.ssh/config" <<EOF
Host github-vac
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
  chmod 600 "$HOME/.ssh/config"
fi
if ! ssh -o BatchMode=yes -T github-vac 2>&1 | grep -q "successfully authenticated"; then
  echo "GitHub did not accept the deploy key. Add this key in"
  echo "github.com/$REPO -> Settings -> Deploy keys, then run again:"
  echo
  cat "$KEY.pub"
  exit 1
fi
echo "GitHub access: OK"

# ---------- 2. Get the code ----------
say "2/6 Getting the latest code"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone "git@github-vac:$REPO.git" "$REPO_DIR"
fi
cd "$REPO_DIR"
git remote set-url origin "git@github-vac:$REPO.git"
if [ -n "$(git status --porcelain)" ]; then
  echo "Local changes found in $REPO_DIR; saving them aside (git stash)."
  git stash push -u -m "auto-stash before update $(date +%F-%H%M)" >/dev/null
fi
BEFORE=$(git rev-parse --short HEAD)
git fetch origin
git checkout -q main
git reset -q --hard origin/main
AFTER=$(git rev-parse --short HEAD)
echo "Version: $BEFORE -> $AFTER"
git log --oneline -5

# ---------- 3. Backup ----------
say "3/6 Backing up data and settings"
BACKUP="$HOME/vac-backup-$(date +%Y%m%d-%H%M).tgz"
if sudo test -d "$INSTALL_DIR"; then
  sudo tar czf "$BACKUP" -C "$INSTALL_DIR" --ignore-failed-read data .env 2>/dev/null || true
  sudo chown "$(id -u):$(id -g)" "$BACKUP" 2>/dev/null || true
  echo "Backup: $BACKUP"
  ls -1t "$HOME"/vac-backup-*.tgz 2>/dev/null | tail -n +6 | xargs -r rm -f   # keep the last 5
else
  echo "No existing install to back up."
fi

# ---------- 4. Deploy ----------
say "4/6 Deploying"
sudo bash deploy/linux-deploy.sh --ip "$PUBLIC_IP"

# ---------- 5. Health check ----------
say "5/6 Health check"
OK=1
for i in $(seq 1 20); do
  curl -fsS --max-time 3 http://127.0.0.1:534/api/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --max-time 5 http://127.0.0.1:534/api/health >/dev/null && echo "App (534):    OK" || { echo "App (534):    FAILED"; OK=0; }
curl -fsSk --max-time 5 https://127.0.0.1:533/api/health >/dev/null && echo "HTTPS (533):  OK" || { echo "HTTPS (533):  FAILED"; OK=0; }
echo "Service:      $(sudo systemctl is-active voice-agent-console.service)"
echo "Node.js:      $(node -v)"

# ---------- 6. Result ----------
say "6/6 Done"
if [ "$OK" = 1 ]; then
  echo "Deployed $AFTER. Open https://$PUBLIC_IP:533"
else
  echo "Something failed. Last log lines:"
  sudo journalctl -u voice-agent-console.service -n 40 --no-pager
  echo "Restore the backup if needed:  sudo tar xzf $BACKUP -C $INSTALL_DIR && sudo systemctl restart voice-agent-console"
  exit 1
fi
