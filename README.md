# Polymarket Signal Trader (FOK Only)

> **Beginner Note:** No coding experience is required.  
> Setup time is usually about **30 minutes**.  
> If you can use a browser and copy/paste terminal commands, you can complete this setup.

## Legal Disclaimer

- This project is provided for **educational purposes only**.
- It is **not** financial, investment, tax, legal, or other professional advice.
- Nothing in this repository is a recommendation or solicitation to buy/sell any asset.
- The operator/developer does **not** manage client funds and does **not** provide custody services.
- You keep full control of your wallet, private keys, and all trading decisions.
- Trading involves risk, including total loss of capital.
- Use is at your own risk. No liability is assumed for losses or damages, to the extent permitted by applicable law.
- If you are unsure about regulatory obligations (including in Germany/EEA, e.g. BaFin scope), get advice from a qualified lawyer.

Minimal TypeScript bot that:

1. reads market updates and signals from a Redis channel,
2. connects to Polymarket WebSocket for that market,
3. places **FOK-only** orders (`BUY` / `SELL`, `UP` / `DOWN`),
4. claims rewards on a fixed interval.

## 1) Create an AWS VM in Ireland (Beginner Friendly)

Use AWS Console only, no SSH key pair needed.

1. Open AWS Console and set region to **Europe (Ireland) - `eu-west-1`**.
2. Go to **EC2 -> Instances -> Launch instances**.
3. Name: `signalstrader-vm`.
4. AMI: **Ubuntu Server 22.04 LTS**.
5. Instance type: `t3.micro` (or bigger if needed).
6. Key pair: select **Proceed without a key pair**.
7. Network settings:
   - create a new security group,
   - allow SSH from your IP (or temporary open while setting up).
8. Storage: **8 GB** is enough for this bot.
9. Click **Launch instance**.
10. Wait about **3 minutes** before connecting in browser console (instance needs time to become ready).

### AWS Cost Note (t3.micro + 8 GB)

This setup can be **$0/month temporarily** if your AWS account is eligible for Free Tier benefits.

- Accounts created **before July 15, 2025**: legacy Free Tier model (12 months, usage limits apply).
- Accounts created **on/after July 15, 2025**: up to **$200 Free Tier credits** (free plan for 6 months; credits valid for 12 months).
- After Free Tier limits / credits are exhausted, this setup is **not free** and runs on normal pay-as-you-go EC2 + EBS pricing.
- Official sources:
  - AWS Docs: [EC2 free tier details](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-free-tier-usage.html)
  - AWS Free Tier page: [Free plan and credits overview](https://aws.amazon.com/free/)

Notes:

- Data transfer, snapshots, and other optional AWS services are not included.
- AWS pricing/rules can change over time; verify current costs in AWS Pricing Calculator before launch.

## 2) Connect to the VM from AWS Browser Terminal

1. In EC2 -> Instances, select your instance.
2. Click **Connect**.
3. Choose **EC2 Instance Connect**.
4. Click **Connect** to open the browser terminal.

This is AWS terminal access and avoids local SSH key management.

## 3) Install Dependencies on the VM

Run:

```bash
sudo apt-get update
sudo apt-get install -y git curl screen
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
npm -v
```

## 4) Clone and Install the Bot

No login needed for a public repository. Clone and install:

```bash
git clone https://github.com/MarshCarbs/signalstrader.git
cd signalstrader
npm ci
```

## 5) Get Redis Password from Telegram Group

This setup does not require a customer Telegram bot for runtime data.

Required:

1. Open your signal Telegram group.
2. Read the Redis password posted by admin/MainTrader.
3. Keep it ready for the `.env` setup wizard.

Technical runtime (`market_slug` updates + signals) comes from Redis only.


## 6) Configure `.env`

Run the setup wizard (recommended for beginners):

```bash
chmod +x scripts/setup_env.sh
npm run setup:env
```

The wizard asks for all required values and writes `.env` automatically.
For each value, it also explains where to find it.

Values requested by the wizard:

- `WALLET_ADDRESS`
- `PRIVATE_KEY`
- `CLAIM_WALLET_ADDRESS` (EOA signer wallet, required)
- `REDIS_PASSWORD` (copy from Telegram group as human)
- `SHARES_PER_TRADE`
- `CLAIM_INTERVAL_MINUTES`

Recommendation:

- Set `SHARES_PER_TRADE` to about **10% of your current trading capital**.

### Where to find these values

1. `WALLET_ADDRESS`: open your Polymarket account profile and copy the wallet address shown there (for your setup, this is the Safe/Proxy address).
2. `PRIVATE_KEY`: in Rabby Wallet, select the signer account that controls your Safe (not the Safe itself), open account details, and export the private key.
3. `CLAIM_WALLET_ADDRESS`: enter the EOA signer account address from Rabby (the same account as `PRIVATE_KEY`).
4. Never share your private key.

Important:

- Order mode is hardcoded to **FOK only**.
- You can set `RPC_URL` to one endpoint or a comma-separated list of endpoints for failover.
- Signal max age is hardcoded to `1000ms`.
- Status heartbeat interval is hardcoded to `20s`.
- `CLAIM_INTERVAL_MINUTES` defaults to `15` if not set.
- Claim scheduler behavior: one claim run starts immediately on bot startup, then every `CLAIM_INTERVAL_MINUTES`.
- `REDIS_PASSWORD` is entered manually in `.env` (human copy from Telegram group).
- The wizard writes fixed Redis values to `.env`:
  - `REDIS_HOST=52.50.149.8`
  - `REDIS_PORT=6379`
  - `REDIS_CHANNEL=ODDS_FOR_COMMUNITY`
- If `nc` is available on the VM, the wizard runs a quick TCP reachability check for `REDIS_HOST:REDIS_PORT`.
- Runtime market changes are consumed from Redis messages (`market_slug` updates and signal payloads).
- `CLAIM_WALLET_ADDRESS` is required and must be your EOA signer wallet address (the wallet behind `PRIVATE_KEY`), otherwise claiming can fail.
- Wizard behavior: `CLAIM_SAFE_ADDRESS` is automatically copied from `WALLET_ADDRESS` (no extra prompt).
- Claiming: the bot checks redeemable positions for `CLAIM_WALLET_ADDRESS` and signer wallet; if `CLAIM_SAFE_ADDRESS` is set, Safe claim path is used for that address.
- Keep some `POL` (Polygon gas token) in your wallet. Claims need gas and will fail with only USDC balance.

### Redis message format (customer side)

- Market update message example:

```json
{"type":"MARKET_CONFIG","market_slug":"btc-updown-15m-1700000000","ts":1700000000000}
```

- Signal message example:

```json
{"direction":"BUY","token":"UP","limitPrice":0.47,"probability":0.49,"market_slug":"btc-updown-15m-1700000000","ts":1700000000000}
```

- `market_slug` must be present on signals.

## 7) Start Bot in Auto-Created `screen` Session

Make scripts executable once:

```bash
chmod +x scripts/start_in_screen.sh scripts/stop_in_screen.sh scripts/update_repo.sh
```

Start (auto creates detached `screen` session and runs bot inside):

```bash
npm run vm:start
```

Then run:

```bash
screen -ls
```

You should see the `signalstrader` screen session if the bot is running.

If `screen -ls` shows no session after start, the bot exited on startup.
Run `npm run vm:start` again and read the printed startup log path (for example `logs/screen_signalstrader.log`).

Useful commands:

```bash
npm run vm:update
npm run vm:set-shares
screen -ls
screen -r signalstrader
Ctrl+A then D   # detach and keep bot running
npm run vm:stop
```

## 8) What You See in Terminal

The bot prints clear status lines:

- startup info (wallet, market, Redis channel, FOK mode),
- WS state (connected/disconnected + last tick),
- Redis state (signals received/processed/stale/failed),
- trade state (successful/failed orders, last order id),
- claim state (enabled/runs/groups/errors),
- periodic `STATUS` heartbeat.
- Claim failures are printed as `CLAIM ERROR | ...` directly in console.  
  If customer support needs live debugging, attach with `screen -r signalstrader`.

## 9) Setup Help / Consulting

If you have setup issues and want direct help, contact on Telegram:

- `@marcel_95`

## 10) Bot Management Commands (From Any Directory)

All commands below work no matter where you are currently in the terminal.

Set this once in your shell session:

```bash
BOT_DIR="$HOME/signalstrader"
```

Start bot:

```bash
npm --prefix "$BOT_DIR" run vm:start
```

Stop bot:

```bash
npm --prefix "$BOT_DIR" run vm:stop
```

Update bot code (admin notice only):

```bash
npm --prefix "$BOT_DIR" run vm:update
```

Restart bot:

```bash
npm --prefix "$BOT_DIR" run vm:stop
npm --prefix "$BOT_DIR" run vm:start
```

Update `SHARES_PER_TRADE` interactively and restart bot:

```bash
npm --prefix "$BOT_DIR" run vm:set-shares
```

Then enter the value when prompted (for example: `12`).
Recommendation: keep `SHARES_PER_TRADE` around **10% of your current trading capital**.

Check running session:

```bash
screen -ls
```

Attach to bot console:

```bash
screen -r signalstrader
```

Detach again without stopping bot:

```bash
Ctrl+A then D
```
