#!/bin/bash
# Sets up "known Wi-Fi, else hotspot" networking for Scion-DB on a Raspberry
# Pi running NetworkManager (default on Raspberry Pi OS since Bookworm).
#
# Usage:
#   cp network.env.example network.env   # then edit network.env
#   sudo bash pi-network-setup.sh
#
# Safe to re-run — connection profiles are created or updated in place.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/network.env"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run this with sudo: sudo bash $(basename "$0")" >&2
  exit 1
fi

if ! command -v nmcli >/dev/null 2>&1; then
  echo "nmcli not found. This script requires NetworkManager (Raspberry Pi OS Bookworm/Trixie default)." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy network.env.example to network.env and fill in your values first." >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

: "${HOME_WIFI_SSID:?set in network.env}"
: "${HOME_WIFI_PASSWORD:?set in network.env}"
: "${HOTSPOT_SSID:?set in network.env}"
: "${HOTSPOT_PASSWORD:?set in network.env}"
IFACE="${WIFI_IFACE:-wlan0}"

if [[ "${#HOTSPOT_PASSWORD}" -lt 8 ]]; then
  echo "HOTSPOT_PASSWORD must be at least 8 characters (WPA2-PSK requirement)." >&2
  exit 1
fi

echo "==> Configuring '$IFACE' connection profiles"

if nmcli -t -f NAME connection show | grep -qx "scion-home"; then
  nmcli connection modify scion-home \
    wifi.ssid "$HOME_WIFI_SSID" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$HOME_WIFI_PASSWORD" \
    connection.autoconnect yes \
    connection.autoconnect-priority 10
else
  nmcli connection add type wifi con-name scion-home ifname "$IFACE" ssid "$HOME_WIFI_SSID" -- \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$HOME_WIFI_PASSWORD" \
    connection.autoconnect yes \
    connection.autoconnect-priority 10
fi
echo "    scion-home       -> SSID '$HOME_WIFI_SSID' (priority 10)"

if nmcli -t -f NAME connection show | grep -qx "scion-hotspot"; then
  nmcli connection modify scion-hotspot \
    wifi.ssid "$HOTSPOT_SSID" \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$HOTSPOT_PASSWORD" \
    connection.autoconnect yes \
    connection.autoconnect-priority -10
else
  nmcli connection add type wifi con-name scion-hotspot ifname "$IFACE" ssid "$HOTSPOT_SSID" mode ap -- \
    802-11-wireless.band bg \
    ipv4.method shared \
    wifi-sec.key-mgmt wpa-psk \
    wifi-sec.psk "$HOTSPOT_PASSWORD" \
    connection.autoconnect yes \
    connection.autoconnect-priority -10
fi
echo "    scion-hotspot    -> SSID '$HOTSPOT_SSID' (priority -10, AP mode, shared IPv4)"

echo "==> Installing boot-time fallback check"
install -d -m 700 /etc/scion
install -m 600 "$ENV_FILE" /etc/scion/network.env
install -m 755 "$SCRIPT_DIR/scion-netcheck.sh" /usr/local/sbin/scion-netcheck.sh
install -m 644 "$SCRIPT_DIR/scion-netcheck.service" /etc/systemd/system/scion-netcheck.service

systemctl daemon-reload
systemctl enable scion-netcheck.service

cat <<EOF

Done.

    scion-home        — joins '$HOME_WIFI_SSID' automatically when in range
    scion-hotspot      — falls back to broadcasting '$HOTSPOT_SSID' after
                          ${FALLBACK_TIMEOUT:-25}s if the home network isn't found
    scion-netcheck.service — runs once at boot to decide between the two

Reboot to test rather than starting the service now — if you're connected
over the home Wi-Fi via SSH, an immediate hotspot switch could drop you.

  sudo reboot

After reboot, check what happened with:
  nmcli connection show --active
  journalctl -u scion-netcheck
EOF
