#!/bin/bash
# Boot-time Wi-Fi fallback check.
#
# Waits up to FALLBACK_TIMEOUT seconds for WIFI_IFACE to reach a connected
# state on any profile other than the hotspot. If the timeout elapses with
# nothing connected, brings up the hotspot connection instead. Runs once per
# boot (via scion-netcheck.service) — does not switch back automatically if
# the home network reappears later; a reboot or service restart re-checks.
set -euo pipefail

IFACE="${WIFI_IFACE:-wlan0}"
TIMEOUT="${FALLBACK_TIMEOUT:-25}"
HOTSPOT_CON="scion-hotspot"

elapsed=0
while (( elapsed < TIMEOUT )); do
  line=$(nmcli -t -f DEVICE,STATE,CONNECTION dev status | awk -F: -v i="$IFACE" '$1==i')
  state="${line#*:}"; state="${state%%:*}"
  conn="${line##*:}"

  if [[ "$state" == "connected" && "$conn" != "$HOTSPOT_CON" ]]; then
    logger -t scion-netcheck "Connected to '$conn' on $IFACE — hotspot not needed"
    exit 0
  fi

  sleep 1
  ((elapsed++))
done

logger -t scion-netcheck "No known Wi-Fi found on $IFACE after ${TIMEOUT}s — starting hotspot"
nmcli connection up "$HOTSPOT_CON"
