#!/usr/bin/env bash
# Read-only inspection of the dialer before enabling MMA call screening.
# Changes nothing. Run on the VICIdial/Asterisk server as root:
#   sudo bash inspect-amd.sh [context]
# Output is also saved to /tmp/mma-amd-inspect-<time>.txt to send to the console team.
set -u
CTX="${1:-default}"
OUT="/tmp/mma-amd-inspect-$(date +%Y%m%d-%H%M%S).txt"
exec > >(tee "$OUT") 2>&1

section() { printf '\n==== %s ====\n' "$1"; }
ast() { asterisk -rx "$1" 2>&1; }

section "Asterisk"
ast "core show version"
ast "core show application AMD" | head -n 20
ast "module show like app_amd"
ast "module show like func_curl"
ast "module show like func_sha1"
ast "module show like chan_sip"
ast "module show like chan_pjsip"
ast "module show like audiosocket"

section "AMD defaults (/etc/asterisk/amd.conf)"
if [ -f /etc/asterisk/amd.conf ]; then grep -vE '^\s*(;|$)' /etc/asterisk/amd.conf; else echo "amd.conf not found (AMD() uses built-in defaults)"; fi

section "Stock VICIdial AMD extension 8369@${CTX}"
ast "dialplan show 8369@${CTX}"

section "MMA AMD extension 8370@${CTX} (installed by install-mma-amd.sh)"
ast "dialplan show 8370@${CTX}"

section "VD_amd.agi"
AGI=""
for p in /var/lib/asterisk/agi-bin/VD_amd.agi /usr/share/astguiclient/agi-bin/VD_amd.agi; do [ -f "$p" ] && AGI="$p"; done
if [ -n "$AGI" ]; then
  echo "Path: $AGI"
  md5sum "$AGI"
  grep -m1 -E 'VERSION|version' "$AGI" || true
  echo "--- How it treats AMD results (MACHINE / NOTSURE / HUMAN):"
  grep -nE 'MACHINE|NOTSURE|HUMAN|AMDSTATUS|AMDCAUSE' "$AGI" | head -n 40
else
  echo "VD_amd.agi not found in the usual agi-bin folders"
fi

section "AI bridge extensions (relay of the AMD result)"
grep -rnE 'MMA_AMD|X-MMA-AMD|ai-bridge|register-call' /etc/asterisk/extensions*.conf 2>/dev/null | head -n 30

section "Campaigns (read-only database query)"
if [ -f /etc/astguiclient.conf ]; then
  DBU=$(awk -F'=> *' '/^VARDB_user/{print $2}' /etc/astguiclient.conf)
  DBP=$(awk -F'=> *' '/^VARDB_pass/{print $2}' /etc/astguiclient.conf)
  DBN=$(awk -F'=> *' '/^VARDB_database/{print $2}' /etc/astguiclient.conf)
  DBH=$(awk -F'=> *' '/^VARDB_server/{print $2}' /etc/astguiclient.conf)
  MYSQL=(mysql -h "${DBH:-localhost}" -u "$DBU" "-p$DBP" "$DBN" --batch)
  "${MYSQL[@]}" -e "SHOW COLUMNS FROM vicidial_campaigns WHERE Field LIKE '%amd%' OR Field IN ('campaign_vdad_exten','dial_method');" 2>&1
  "${MYSQL[@]}" -e "SELECT campaign_id, active, dial_method, campaign_vdad_exten FROM vicidial_campaigns WHERE active='Y';" 2>&1
  "${MYSQL[@]}" -e "SELECT status, status_name FROM vicidial_statuses WHERE status IN ('AA','AM','AL','AFAX','NA','N','AB');" 2>&1
else
  echo "/etc/astguiclient.conf not found; skip campaign query"
fi

section "Summary"
echo "Saved to $OUT"
echo "A campaign uses native AMD when its Routing Extension (campaign_vdad_exten) is 8369 (stock) or 8370 (MMA)."
