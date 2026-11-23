#!/usr/bin/env bash
# Installs MMA AMD extension 8370 next to the stock VICIdial 8369. Nothing stock
# is edited: 8370 is generated from the live 8369 dialplan, with two additions
# right after AMD():
#   - the AMD result (STATUS/CAUSE/signature) is stored in AstDB under the
#     call's VICIdial caller code, for HUMAN and NOTSURE results only
#     (MACHINE calls are hung up with AA by the stock VD_amd.agi);
#   - NOTSURE is passed on to the bot so the AI screening can decide
#     (stock VD_amd.agi already treats anything but MACHINE as a person).
# The console's AI-extension dialplan reads and deletes that AstDB key and
# relays it to the bridge (SIP header or pre-call hook).
#
# Usage (as root on the dialer):
#   sudo bash install-mma-amd.sh                       # dry run: prints the generated file
#   sudo bash install-mma-amd.sh --apply --secret 'long-random-value'
# Options:
#   --context NAME   dialplan context of 8369 (default: default)
#   --secret VALUE   same value as SCREENING_EVENT_SECRET in the console .env (recommended)
#   --tuned          replace AMD() arguments with the tuned set below
#   --apply          write /etc/asterisk/extensions-mma-amd.conf, include it, reload dialplan
set -euo pipefail

CTX="default"; SECRET=""; APPLY=0; TUNED=0
while [ $# -gt 0 ]; do
  case "$1" in
    --context) CTX="$2"; shift 2;;
    --secret) SECRET="$2"; shift 2;;
    --tuned) TUNED=1; shift;;
    --apply) APPLY=1; shift;;
    *) echo "Unknown option $1"; exit 2;;
  esac
done
[[ "$CTX" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Bad context name"; exit 2; }
[[ -z "$SECRET" || "$SECRET" =~ ^[A-Za-z0-9._~+-]{16,128}$ ]] || { echo "Secret must be 16-128 characters of letters, digits or . _ ~ + -"; exit 2; }

# Tuned for a second-stage AI check: native AMD only needs to catch obvious
# machines quickly; anything borderline is left to the AI screening.
# initialSilence,greeting,afterGreetingSilence,totalAnalysisTime,minWordLength,betweenWordsSilence,maximumNumberOfWords,silenceThreshold,maximumWordLength
TUNED_ARGS="2500,1500,800,5000,120,50,3,256,5000"

DUMP=$(asterisk -rx "dialplan show 8369@${CTX}")
echo "$DUMP" | grep -q "AMD(" || { echo "8369@${CTX} has no AMD() step. Run inspect-amd.sh and check the context."; exit 1; }

# Lines look like:  '8369' =>   1. AGI(agi://127.0.0.1:4577/call_log)   [pbx_config]
#                                 2. AMD(2000,2000,1000,5000,120,50,4,256)   [pbx_config]
STEPS=$(echo "$DUMP" | sed -nE 's/^.*[[:space:]][0-9]+\.[[:space:]]+(.+[)])[[:space:]]+\[[^]]*\][[:space:]]*$/\1/p')
[ -n "$STEPS" ] || { echo "Could not read the 8369 steps"; exit 1; }

SIG_EXPR=""
if [ -n "$SECRET" ]; then SIG_EXPR="/\${SHA1(${SECRET}\${AMDSTATUS}\${CALLERID(name)})}"; fi

GEN=$(mktemp)
{
  echo "; MMA call screening: AMD extension 8370 (generated $(date -u +%FT%TZ) from 8369@${CTX})."
  echo "; Do not edit by hand: rerun install-mma-amd.sh. Remove with rollback-mma-amd.sh."
  echo "[${CTX}]"
  first=1
  while IFS= read -r step; do
    if [ $TUNED -eq 1 ] && [[ "$step" =~ ^AMD\( ]]; then step="AMD(${TUNED_ARGS})"; fi
    # Keep stock behaviour exactly: VICIdial scripts see the original 8369.
    step="${step//\$\{EXTEN\}/8369}"
    if [ $first -eq 1 ]; then echo "exten => 8370,1,${step}"; first=0; else echo " same => n,${step}"; fi
    if [[ "$step" =~ ^AMD\( ]]; then
      echo " same => n,NoOp(MMA AMD: \${AMDSTATUS} \${AMDCAUSE} for \${CALLERID(name)})"
      echo " same => n,ExecIf(\$[\"\${AMDSTATUS}\" != \"MACHINE\" & \"\${CALLERID(name)}\" != \"\"]?Set(DB(MMA_AMD/\${CALLERID(name)})=\${AMDSTATUS}/\${AMDCAUSE}${SIG_EXPR}))"
    fi
  done <<< "$STEPS"
} > "$GEN"

echo "----- generated extensions-mma-amd.conf -----"
if [ -n "$SECRET" ]; then sed "s/${SECRET}/<secret>/g" "$GEN"; else cat "$GEN"; fi
echo "---------------------------------------------"

if [ $APPLY -ne 1 ]; then
  echo "Dry run only. Review the lines above, then rerun with --apply."
  rm -f "$GEN"; exit 0
fi

TS=$(date +%Y%m%d-%H%M%S)
cp -a /etc/asterisk/extensions.conf "/etc/asterisk/extensions.conf.mma-backup-$TS"
install -m 0640 -o root -g "$(stat -c %G /etc/asterisk/extensions.conf)" "$GEN" /etc/asterisk/extensions-mma-amd.conf
rm -f "$GEN"
grep -q '^#include extensions-mma-amd.conf' /etc/asterisk/extensions.conf || printf '\n#include extensions-mma-amd.conf\n' >> /etc/asterisk/extensions.conf
asterisk -rx "dialplan reload" >/dev/null
if asterisk -rx "dialplan show 8370@${CTX}" | grep -q "MMA_AMD"; then
  echo "✓ 8370@${CTX} installed. Backup: /etc/asterisk/extensions.conf.mma-backup-$TS"
else
  echo "✗ 8370 not visible after reload; restoring the backup"
  cp -a "/etc/asterisk/extensions.conf.mma-backup-$TS" /etc/asterisk/extensions.conf
  rm -f /etc/asterisk/extensions-mma-amd.conf
  asterisk -rx "dialplan reload" >/dev/null
  exit 1
fi

# Keys left by calls that never reached the bot (caller hung up during routing).
CRON=/etc/cron.d/mma-amd-cleanup
if [ ! -f "$CRON" ]; then
  echo '15 3 * * * root /usr/sbin/asterisk -rx "database deltree MMA_AMD" >/dev/null 2>&1' > "$CRON"
  echo "✓ Nightly AstDB cleanup added ($CRON, 03:15)"
fi

cat <<EOF

Next steps (VICIdial admin, one campaign at a time):
  1. Campaigns -> <campaign> -> Detail: set "AMD Type" to AMD (2.14) if present.
  2. Set "Routing Extension" (campaign_vdad_exten) from 8369/8368 to 8370.
  3. Update the AI-extension dialplan in Asterisk from the console (Vici Bridge -> generated dialplan):
     it now relays MMA_AMD to the bridge.
  4. In the console: Vici Bridge -> Call screening -> 1. Turn on, then 2. Run testing & verification.
Rollback: set the Routing Extension back to the previous value, then run rollback-mma-amd.sh.
EOF
