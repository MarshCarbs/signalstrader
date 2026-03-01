#!/usr/bin/env bash
set -euo pipefail

ENV_FILE=".env"
PROMPT_RESULT=""
DEFAULT_REDIS_HOST="52.50.149.8"
DEFAULT_REDIS_PORT="6379"
DEFAULT_REDIS_CHANNEL="ODDS_FOR_COMMUNITY"

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

confirm_yes() {
  local prompt="$1"
  local answer
  while true; do
    read -r -p "$prompt [y/N]: " answer
    answer="$(trim "$answer")"
    case "$answer" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO|"") return 1 ;;
      *) echo "Please type y or n." ;;
    esac
  done
}

prompt_value() {
  local label="$1"
  local where="$2"
  local default_value="${3:-}"
  local sensitive="${4:-0}"
  local value

  while true; do
    echo
    echo "$label"
    echo "Where to find it: $where"
    if [[ "$sensitive" == "1" ]]; then
      read -r -s -p "> " value
      echo
    else
      if [[ -n "$default_value" ]]; then
        read -r -p "> [$default_value] " value
        value="$(trim "$value")"
        value="${value:-$default_value}"
      else
        read -r -p "> " value
        value="$(trim "$value")"
      fi
    fi

    if [[ -n "$value" ]]; then
      PROMPT_RESULT="$value"
      return 0
    fi

    echo "Value cannot be empty."
  done
}

is_hex_address() {
  [[ "$1" =~ ^0x[a-fA-F0-9]{40}$ ]]
}

is_hex_private_key() {
  [[ "$1" =~ ^0x[a-fA-F0-9]{64}$ ]]
}

is_integer_ge() {
  local value="$1"
  local min="$2"
  [[ "$value" =~ ^-?[0-9]+$ ]] || return 1
  (( value >= min ))
}

is_positive_number() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || return 1
  awk "BEGIN {exit !($value > 0)}"
}

echo "======================================"
echo "Signalstrader .env Setup Wizard"
echo "======================================"
echo "This wizard asks for your values and writes them to .env."
echo

if [[ -f "$ENV_FILE" ]]; then
  if ! confirm_yes "A .env file already exists. Overwrite it"; then
    echo "Aborted. Existing .env was not changed."
    exit 0
  fi
fi

prompt_value \
  "WALLET_ADDRESS (required)" \
  "Polymarket profile -> wallet address (Safe/Proxy wallet address)."
wallet_address="$PROMPT_RESULT"
if ! is_hex_address "$wallet_address"; then
  if ! confirm_yes "WALLET_ADDRESS does not look like a valid 0x address. Keep it anyway"; then
    echo "Aborted. Please rerun the wizard."
    exit 1
  fi
fi

prompt_value \
  "PRIVATE_KEY (required)" \
  "Rabby Wallet -> signer account (not the Safe itself) -> export private key. Input is visible." \
  ""
private_key="$PROMPT_RESULT"
if ! is_hex_private_key "$private_key"; then
  if ! confirm_yes "PRIVATE_KEY does not look like a valid 0x private key. Keep it anyway"; then
    echo "Aborted. Please rerun the wizard."
    exit 1
  fi
fi

prompt_value \
  "CLAIM_WALLET_ADDRESS (required, EOA signer wallet)" \
  "Rabby Wallet -> signer account address (EOA). This should match the account of PRIVATE_KEY." \
  ""
claim_wallet_address="$PROMPT_RESULT"
if ! is_hex_address "$claim_wallet_address"; then
  if ! confirm_yes "CLAIM_WALLET_ADDRESS does not look like a valid 0x address. Keep it anyway"; then
    echo "Aborted. Please rerun the wizard."
    exit 1
  fi
fi

claim_safe_address="$wallet_address"
echo
echo "CLAIM_SAFE_ADDRESS is auto-set to WALLET_ADDRESS: $claim_safe_address"

redis_host="$DEFAULT_REDIS_HOST"
redis_port="$DEFAULT_REDIS_PORT"
redis_channel="$DEFAULT_REDIS_CHANNEL"

echo
echo "Redis defaults are preconfigured:"
echo "  REDIS_HOST=${redis_host}"
echo "  REDIS_PORT=${redis_port}"
echo "  REDIS_CHANNEL=${redis_channel}"

prompt_value \
  "REDIS_PASSWORD (required)" \
  "Read this password as a human from the Telegram group message and paste it here. Input is visible in terminal."
redis_password="$PROMPT_RESULT"

if command -v nc >/dev/null 2>&1; then
  echo
  echo "Testing Redis TCP reachability: ${redis_host}:${redis_port} ..."
  if nc -z -w 3 "$redis_host" "$redis_port" >/dev/null 2>&1; then
    echo "TCP check successful."
  else
    echo "WARNING: TCP check failed for ${redis_host}:${redis_port}."
    echo "Check VM outbound network/firewall rules and try again."
  fi
else
  echo
  echo "Note: 'nc' is not installed, skipping Redis TCP check."
fi

prompt_value \
  "SHARES_PER_TRADE (required)" \
  "How many shares the bot should use per trade. Recommendation: about 10% of your current trading capital (example: 10)." \
  "10"
shares_per_trade="$PROMPT_RESULT"
if ! is_positive_number "$shares_per_trade"; then
  echo "SHARES_PER_TRADE must be a positive number."
  exit 1
fi

prompt_value \
  "CLAIM_INTERVAL_MINUTES" \
  "How often claims should run. 15 is the default recommendation." \
  "15"
claim_interval_minutes="$PROMPT_RESULT"
if ! is_integer_ge "$claim_interval_minutes" 0; then
  echo "CLAIM_INTERVAL_MINUTES must be an integer >= 0."
  exit 1
fi

cat > "$ENV_FILE" <<EOF
WALLET_ADDRESS=$wallet_address
PRIVATE_KEY=$private_key
CHAIN_ID=137
RPC_URL=https://polygon-rpc.com

CLOB_HTTP_URL=https://clob.polymarket.com
CLOB_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
GAMMA_EVENTS_URL=https://gamma-api.polymarket.com/events

REDIS_HOST=$redis_host
REDIS_PORT=$redis_port
REDIS_CHANNEL=$redis_channel
REDIS_PASSWORD=$redis_password

SHARES_PER_TRADE=$shares_per_trade

CLAIM_INTERVAL_MINUTES=$claim_interval_minutes
CLAIM_WALLET_ADDRESS=$claim_wallet_address
CLAIM_SAFE_ADDRESS=$claim_safe_address
EOF

echo
echo "Done. Wrote $ENV_FILE successfully."
echo "Start the bot with: npm run vm:start"
