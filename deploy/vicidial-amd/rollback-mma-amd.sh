#!/usr/bin/env bash
# Removes MMA AMD extension 8370. Stock 8369 and VD_amd.agi were never changed.
# First set every campaign's Routing Extension back from 8370 (VICIdial admin),
# then run:  sudo bash rollback-mma-amd.sh [context]
set -euo pipefail
CTX="${1:-default}"
[[ "$CTX" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Bad context name"; exit 2; }

if [ -f /etc/astguiclient.conf ]; then
  DBU=$(awk -F'=> *' '/^VARDB_user/{print $2}' /etc/astguiclient.conf)
  DBP=$(awk -F'=> *' '/^VARDB_pass/{print $2}' /etc/astguiclient.conf)
  DBN=$(awk -F'=> *' '/^VARDB_database/{print $2}' /etc/astguiclient.conf)
  DBH=$(awk -F'=> *' '/^VARDB_server/{print $2}' /etc/astguiclient.conf)
  STILL=$(mysql -h "${DBH:-localhost}" -u "$DBU" "-p$DBP" "$DBN" -N -e "SELECT GROUP_CONCAT(campaign_id) FROM vicidial_campaigns WHERE campaign_vdad_exten='8370';" 2>/dev/null || true)
  if [ -n "$STILL" ] && [ "$STILL" != "NULL" ]; then
    echo "These campaigns still route to 8370: $STILL"
    echo "Set their Routing Extension back (e.g. 8369) in VICIdial admin first, then rerun."
    exit 1
  fi
fi

TS=$(date +%Y%m%d-%H%M%S)
cp -a /etc/asterisk/extensions.conf "/etc/asterisk/extensions.conf.mma-rollback-$TS"
sed -i '/^#include extensions-mma-amd.conf$/d' /etc/asterisk/extensions.conf
rm -f /etc/asterisk/extensions-mma-amd.conf /etc/cron.d/mma-amd-cleanup
asterisk -rx "dialplan reload" >/dev/null
asterisk -rx "database deltree MMA_AMD" >/dev/null 2>&1 || true
if asterisk -rx "dialplan show 8370@${CTX}" | grep -q "MMA_AMD"; then
  echo "✗ 8370 is still loaded; check /etc/asterisk for another include"; exit 1
fi
echo "✓ MMA AMD removed. Stock 8369 untouched. Backup: /etc/asterisk/extensions.conf.mma-rollback-$TS"
echo "  The relay lines in the AI-extension dialplan are harmless without 8370 (they read an empty value)."
