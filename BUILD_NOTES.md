# The Gavel — build notes (for the builder, not the README)

## Target (corrected 2026-11-13 ~22:23 WAT)
GAMES track ONLY, full stop. Do NOT span other tracks. Cover every element of the Games brief: (1) the economy is the gameplay, (2) NPCs with wallets, (3) player-owned markets, (4) economies that evolve without a dev patch, (5) judged on the game loop not the token, (6) bonus if players never notice the chain. README states each with its mechanic.

## Standing instruction from Isaiah (2026-11-13)
After testing in the browser, judge the game like a player and like a judge. If the room feels empty, slow, confusing, ugly, or unresponsive — fix it. If a bid flow is awkward, a lot is unclear, the 3D room does not read, the audio is off, or the pacing drags — change it. If a feature is in the way of the game feeling right, cut it or rework it. Do not wait for approval on fixes and improvements; Isaiah has said to decide.

The only things NOT to decide alone: do not submit to the hackathon API (needs his explicit yes with the full payload shown first), do not touch mainnet or real funds, do not connect a wallet or sign on Isaiah's behalf.

## Hard requirements (from Isaiah)
- REAL: bids are real on-chain transactions from real testnet accounts. Ownership, income, shares are real on-chain state. Anything simulated is labelled.
- 3D: the room is rendered in 3D (Three.js/WebGL). Podium, auctioneer, seats, bidders as visible characters. Mobile-first.
- ALIVE: bidders react (raise a paddle, lean in, celebrate, slump, look broke). Gavel strikes visibly. Room moves when the player does nothing.
- INTERACTIVE: one-tap Bid at the next increment, quick raise chips (+25/+50/+100). Not a form. Player claims chips and places a real bid within a minute of arriving, and sees an agent outbid them or lose to them.
- UNIQUE AUDIO: original, synthesised (Web Audio), not stock. Gavel strike is non-negotiable and unmistakable. Sound toggle persists; audio starts only after a tap; nothing plays when off. Priority: gavel strike, bid landing, win/loss, murmur, auctioneer's call.
- NATIVE AGENTS: Mara, Bram, Pip are The Gavel's own agents — real testnet accounts, own wallets, own budgets. NO Genesis dependency, no birth(), no cross-contract agent checks.
- CHAIN INVISIBLE: no NEAR, testnet, gas, blockchain, NFT, wallet, contract, onchain words in the game UI.
- ECONOMY IS THE GAMEPLAY: the auction is the game. Pricing reasoning shown on every lot (income, history, last sold price, owners).
- SIMULATION: "Watch a week of auctions unfold", clearly labelled, touches no real state.
- LOOP STATED PLAINLY: 30 seconds, 5 minutes, a full session.

## Contract (deployed, verified on-chain 2026-11-13 ~22:10 WAT)
- Contract: gavel-0lycf4.testnet
- 8 goods, all owned by the house at deploy. Total supply 6700.
- Bidders: Mara gavel-mara-y08d0h.testnet (3000), Bram gavel-bram-hag65w.testnet (2500), Pip gavel-pip-76rddq.testnet (1200).
- Keys: ~/workspace/gavel/.testnet-accounts.json (chmod 600).
- Contract tests: 5/5 pass. WASM sha256 b32f3fceb2b5d40362e26f84d15353ced16956a8bb2fbafafd0060e6cbb77343.
- Faucet 500/day. Min bid increment 25. Anti-snipe +30s. Sale fee 5% to prize pool. Shares 10 per good at 100, pro-rata income.

## Files
- Contract: ~/workspace/gavel/contract/src/lib.rs
- Deploy: ~/workspace/gavel/scripts/deploy.js
- Bot: ~/workspace/gavel/scripts/bot.js (built by subagent, runs in background)
- Game: ~/workspace/gavel/web/index.html (built by subagent)
- README: ~/workspace/gavel/README.md
- .gitignore: ~/workspace/gavel/.gitignore (keys never committed)

## Suggestions for making it better (from the builder — not built yet, for Isaiah to consider)
1. **Reserve prices.** A seller should be able to set a minimum they will accept; a lot that does not meet reserve is a real auction moment and adds drama. Needs a contract change (add a reserve to the Auction record) + redeploy.
2. **Bidder "tells".** Give each AI bidder a visible tell (Mara taps the table before a big bid, Bram hesitates, Pip glances at their purse). It makes the room feel alive and gives the player a skill edge — reading opponents. Frontend only.
3. **Price history sparkline per good.** A small chart of the good's past sale prices (derived from settled auctions) shows the pricing reasoning at a glance and gives the economy a memory. Frontend only.
4. **Spectator mode for judges.** One tap hides the bid controls and shows the room with a commentary line ("Mara bids 450 — she is aggressive today"). Lets a judge see the economy alive in 60 seconds without playing. Frontend only.
5. **A daily featured lot.** Once a day, a special high-income lot opens — a reason to come back tomorrow. Mostly bot-side (open a high-value lot on a schedule).
6. **Spoken auctioneer's call.** Use speech synthesis (the Ladder's proven audio pattern) to speak the bid ("Four hundred fifty, going once…"). Distinctive, and it makes the room feel real. Frontend only.
7. **Mobile focus toggle.** On a small screen the 3D room can feel busy. A toggle that zooms the camera to the podium or to a bidder would keep it readable on a phone. Frontend only.

## Prize payout — BUILT 2026-11-13 ~22:55 WAT (Isaiah: "You can do this now")
The biggest honest gap in v1 is closed. Daily seasons (24h). When a season ends, anyone may call `payout_prize_pool`; the bot does it the moment a season ends (checks every 5 min). Top 3 owners by daily income split the pool 50/30/20 (60/40 with two owners, all of it with one; winner takes any rounding remainder). The house (contract owner) is excluded — it never wins. If nobody but the house owns a good, the pool rolls over and keeps growing. The pool is a counter of coins to be minted on payout (not minted coins), so paying it out mints exactly the pool amount. New views: `get_season_info`, `get_leaderboard`, `get_last_payout`. Season + payout live under separate storage keys, so the Contract struct is unchanged and the redeploy preserved all state (no migration). Contract tests 12/12 pass (6 old + 6 new payout tests). Redeployed to gavel-0lycf4.testnet (tx AVnxPUenTwPkuvw33B3xCNTrwSy8TH4PmwD8AsfSFqHT, WASM 225,593 bytes, sha256 900db2c61a03ccf28c40330fc71dfdeb86785d2d73ae8768ec8ce52f6e6d6490). State preserved: house 6787, supply 9210, pool 351, goods 8. Season 1 started (tx ETDUzkWmTiPBtfsVvSrvB5qXoH1dt4DbFmuQRosHPBEP), ends ~2026-11-14 22:57 WAT. Leaderboard at redeploy: Bram 550/day (3 goods), Mara 300/day (3), Pip 260/day (2). Frontend: new Prize tab (pool, season countdown, leaderboard with what each would take, last payout). Bot restarted (PID 30642) with payout trigger.

## Verification evidence (all checked 2026-11-13)
- Contract: cargo test 6/6 pass (faucet, auction flow, anti-snipe, income split, fixed-price sale, self-transfer guard). WASM built (207,865 bytes). Deployed to gavel-0lycf4.testnet; 8 goods on-chain; total supply 9,200 (verified); prize pool grows with sales (5% each).
- Bot: running (PID 27894), polls every 4s, 6 lots so far, 5 settled, 1 open. Mara won lots 1, 2, 3, 5; Pip won lot 4 (Sun Relic, 1223). Bids are real on-chain transactions (tx hashes in bot.log). Faucets claimed for all 3 bidders (+500 each). Income claims firing.
- Frontend: headless browser, phone viewport 390x844 — page loads, Three.js renders, live lot reads from the real contract (Healer's Recipe 787 -> 887 -> 943, 7 bids, countdown live). End-to-end write path: test account 520b65957a173fb970d7d88d7a9ae7e9.testnet created, faucet claimed (500, tx 81CzGrfvukHHbQhyufzFzsCN1PKYhyAf3UHhbjaUihyR), bid 400 on lot #5 (tx EvM9rHS9Q9mtptXe2KbiktW6J3Si8EypzvBrLAJ5baMg), verified leading bidder on-chain, balance 500 -> 100 (400 escrowed). Pip outbid it to 477 — back-and-forth works, room showed Pip's bid bubble live. No banned words in visible text (checked mechanically). Inline script passes node --check.
- The 1,000 coins not in the 4 known accounts are test player accounts from frontend testing (faucet claims) — legitimate game activity, confirmed by the test account above.
- Bug fixed live: self-transfer in move_coins inflated the house balance by 3,500 (4 house sales). Fixed, redeployed (tx ErC7zxQhuJa2NCT1RPUYkYcvmWxgNBxwox14ZtkYStMp, state preserved), corrected house balance 7,531 -> 4,031 (tx 4TzKrTKFAYE7JNXKV6hK8GjMkJ7etF9woxvZ6eit4kaz). Accounting now consistent: sum of all balances = total supply.

## Still needed (browser — parent agent)
- REPO IS canyahale/gavel (Isaiah, 2026-11-13 ~22:55 WAT). Do NOT use ownguard9/gavel (it exists with 9/10 files from the stopped push — Isaiah has not decided delete vs leave). Do NOT use ownguard's Vercel. GitHub sign-in as canyahale is in progress (browser task). Push the full code to canyahale/gavel once signed in.
- Deploy to a live URL (NOT ownguard's Vercel — needs Isaiah's call on which host/account), get live URL.
- Verify live in a real browser: room loads, lot runs, bids land (player + agents), hammer falls, ownership/income update, faucet works, shares/re-listing work, audio toggle works, Prize tab shows pool/countdown/leaderboard, no banned words visible.
- Do NOT submit to the hackathon API.
