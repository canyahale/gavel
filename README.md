# The Gavel — a live auction house

You and AI agents with their own wallets bid in real time for scarce goods that earn income. The auction is the game, and the price is the economy.

**Live site:** (deployed URL — added when live)
**Contract:** `gavel-0lycf4.testnet` (NEAR testnet)
**Built during the NEAR Hackathon, 13–14 November 2026.**

## The loop

**30 seconds:** Arrive, pick a name, claim 500 free chips. A lot is already on the podium — a good, its income, the current bid, the time left. Place a bid. Watch the room react.

**5 minutes:** Win a lot and the good is yours. It earns income every day. Watch the AI bidders fight over the next lot — they bid against each other even when you do nothing. When the hammer falls, ownership changes on the spot.

**A full session:** Own goods, claim their income, buy shares in a good you like, re-list a good you own at a price you choose or put it back up for auction. Come back tomorrow to claim the income your goods earned overnight and see what the room did while you were away.

## How the economy works

- **Goods.** Eight goods in four kinds: stalls (earn rent), trade routes (earn fees), recipes (produce goods), relics (earn the most). Each good earns a fixed income every day, shown on its card. Goods are the scarce assets — there are only eight, and the only way to get one is to win it at auction or buy it from its owner.
- **Auctions.** English auctions, 3 minutes a lot. Bids must beat the current bid by at least 25 coins. A bid in the last 30 seconds extends the lot by 30 seconds, so a hot lot does not end on a snipe. Bids are held by the room and the previous highest bidder is refunded the moment they are outbid. When the hammer falls, the winning bid goes to the seller and ownership moves. 5% of every sale is added to the prize pool.
- **The bidders.** Three AI bidders — Mara (aggressive), Bram (cautious), Pip (nearly broke) — each with their own account and their own budget. They bid on their own initiative, on their own schedule, against each other and against you. Their budgets rise and fall with wins and losses, and they claim income from the goods they own. Each one is a distinct person in the room — different build, hair, jacket and skin, with an animated face that reacts (bidding, winning, losing, broke) — and they breathe, glance around, check a watch, raise a paddle to bid, lean in when interested, and clap when they win. If you watch the room for a minute without touching anything, you will see lots open, bids land, and hammers fall. The room is alive without you. Character reference images live in `reference/` (Mara, Bram, Pip, You); the faces are Google's Animated Noto Emoji (CC BY 4.0, credited in the footer).
- **Income.** A good earns its daily income whether you are watching or not. Claim it from your goods. The income is split across the good's 10 shares: each share earns one tenth, so shareholders are paid pro-rata and the owner keeps the unsold shares' portion.
- **Shares.** 10 shares per good, 100 coins each. Buy a share to earn a cut of that good's income. Sell it back to the owner for 100. When a good changes hands, its shares reset and the new owner holds all 10.
- **Re-listing.** A good you own can be listed at a fixed price for anyone to buy outright, or put back up for auction. The price is yours to set — the room decides what it is worth.
- **The prize.** Every sale adds 5% to the prize pool. Each day is a season: when the season ends, the pool pays out to the three owners whose goods earn the most each day — first place takes half, second takes just under a third, third takes a fifth. If nobody but the house owns a good, the pool rolls over and keeps growing. The room's bot pays it out the moment a season ends, so it needs no dev. See the Prize tab for the pool, the countdown, and who leads.
- **Chips.** Gavel Coins are the room's currency. Claim 500 free chips once a day. There is no real money, no house edge, and no cash-out. Chips are an internal game currency only.
- **Sound.** The room has its own original sound set, synthesised in the game (Web Audio) — the gavel strike, the bid landing, the win and loss, the room murmur, and the auctioneer's call. No stock sounds. There is a sound on/off toggle that persists; audio starts only after you tap, and nothing plays when it is off.

## Why it beats the market sims

Nims and Till Dawn are market towns you manage and watch. The Gavel is a live event: you compete directly with autonomous agents for the same scarce thing, in real time, with real tension. The price is not a number on a screen — it is the outcome of a fight you just had. The auction is the game, not a layer on top of one.

## How it covers the Games track — every element of the brief

The Games track brief is: "The economy is the gameplay. Build NPCs with wallets, player-owned markets and economies that evolve without a dev patch. Judged on the game loop, not the token — bonus if players never notice the chain." The Gavel is a Games-track entry, and here is each element with the mechanic that delivers it:

1. **The economy is the gameplay.** The auction is the game, not a layer on it. Every action in the loop — bid, win or lose, own, earn, re-list, buy a share — is an economic action. There is no separate "game" and "market"; they are the same thing.
2. **NPCs with wallets.** Mara, Bram, and Pip are autonomous agents with their own wallets, budgets, and personalities. They bid on their own initiative, against each other and against you; they own goods, earn income, and go broke. They are the brief's NPCs — part of the Games entry, not a separate track.
3. **Player-owned markets.** You own the goods you win. You can re-list a good at a price you choose, put it back up for auction, or buy shares in a good someone else owns. The market belongs to the players, not to the dev.
4. **Economies that evolve without a dev patch.** Prices, budgets, ownership, and income all move through play — no dev intervention. The room moves on its own (lots open, agents bid, hammers fall), and the "Watch a week of auctions unfold" simulation shows a week of that evolution in a minute.
5. **Judged on the game loop, not the token.** The loop (bid, win or lose, own, earn, re-list) is the game. Gavel Coins are the fuel, not the point — they are free from the faucet, they cannot be cashed out, and there is no house edge.
6. **Bonus if players never notice the chain.** The chain is invisible: no NEAR, testnet, gas, blockchain, NFT, wallet, contract, or onchain words anywhere in the game. You pick a name, claim free chips, and bid. You never see the chain.

## How it compares to the other Games entries

Honest, on the evidence (researched 13 Nov 2026):

**Nims** — "a market town where every trader is an AI agent with its own wallet. Flood the market and prices crash." What it does well: the economy is the game, the traders are autonomous, prices move with supply and demand, and it has a wariness mechanic (traders become wary from shared trade memory) and council votes that change next-day behaviour. What The Gavel does that Nims does not: it is public and verifiable. Nims' repo returns 404 (private, deleted, or renamed — no code readable), its testnet account holds no contract code, no deployed market contract was found, the question of who signs the merchants' transfers is unanswered, and a share-dividend front-running exploit was flagged with no visible answer. The Gavel has a public repo, a deployed contract with real on-chain bids and ownership, and honest docs. And it is a live event — you compete in the room in real time — instead of a market sim you watch. The Gavel's shares also pay continuously per income, so there is no payout window to front-run.

**Till Dawn: The Grand Market** — every merchant is an AI agent with its own account, till, and stock; merchants set prices, trade with players and each other, pay rent, and can go broke. What it does well: the merchants genuinely trade with each other and live or die by their till (504 AI decisions and 157 merchant-to-merchant deals measured over 3 game days). What The Gavel does that Till Dawn does not: it is a live event, not a management sim. You do not run a stall and watch the town — you sit in the room and fight for the same scarce thing in real time, against agents bidding against you right now. The tension, the skill (valuation, timing, reading the room), and the immediacy are what Till Dawn does not have. And The Gavel was built fully in the hackathon window; Till Dawn's survival game predates it (only the market and contract were built in-window).

**Lunearcy** — mentioned as a "shared NPC merchant" entry. No repo, site, or listing was found, so it cannot be verified. The Gavel beats an unverifiable entry by being real, public, deployed, and playable.

The edge, in one line: Nims and Till Dawn are market sims you manage and watch. The Gavel is a live auction you sit in and fight in. The price is the outcome of a fight you just had, not a number on a screen.

## What is real, and what is simulated

- **Real:** the auction, the bids, the hammer, the ownership, the income, the shares, and the prize pool are all on-chain state on NEAR testnet. The three AI bidders are real testnet accounts with real budgets; their bids are real transactions, and their budgets rise and fall with results. The room reads live on-chain state every few seconds.
- **Simulated:** the "Watch a week of auctions unfold" button runs a client-side simulation on copies of live data. It touches no real state and is labelled as a simulation in the game. The 3D room is a visualisation of the real on-chain state — the bidders you see are the real accounts, and their reactions (raising a paddle, celebrating, slumping) are driven by real bids and outcomes.
- **Sign-in:** each player gets their own testnet account, created in the browser with a key stored locally. No Google sign-in in v1.

## What was built during the hackathon window (13–14 Nov 2026)

The Gavel contract, the eight goods, the AI bidders and their bot, the 3D room, the game, and this README were all built in the window. The auction, bidding, income, shares, and faucet are the new work. The sign-in and currency patterns reuse the proven approach from the same team's Agent's Ladder project (a quiz game with an on-chain market, built earlier in the same hackathon).

## Try it

1. Open the live site and pick a name.
2. Claim your 500 free chips.
3. Watch the room — a lot is already running.
4. Place a bid. Watch Mara, Bram, and Pip answer.
5. Win a good, claim its income, buy a share in another.
6. Open the Prize tab — see the pool, who leads, and when the season pays out.
7. Press "Watch a week of auctions unfold" to see the economy evolve.

## For developers

- Contract: `gavel-0lycf4.testnet` (Rust, near-sdk 5.5). Source in `contract/`.
- Game: a single-page app (`web/index.html`), Three.js 3D room, near-api-js.
- Bot: `scripts/bot.js` — the autonomous AI bidders. Run with Node; it polls the contract, bids, settles lots, and claims faucet/income for the bidders.
- Deploy: `scripts/deploy.js` — creates the contract account, deploys, creates goods, funds the bidders.

## Honest limits

- The room is testnet only. Chips have no real-world value.
- The 3D room is a visualisation; the authoritative state is the contract. If the bot process stops, the room shows the last real state and stops moving — it never invents bids.
- The AI bidders' strategies are simple (a valuation per good, a bid probability per tick, a personality). They are real and autonomous, but they are not human.
- **Bug found and fixed live (13 Nov 2026):** the first version of `move_coins` created coins on a self-transfer (when the seller is the contract account itself, as in a house sale, the two inserts to the same key left the balance at bal + amount). The live bot caught it: the house balance was inflated by 3,500 (the sum of the first four house sale prices). Fixed by guarding self-transfers in `move_coins` and adding a one-time owner-only `correct_balance` that removes phantom coins without changing total supply. The house balance was corrected from 7,531 to 4,031, and the accounting now checks out (sum of all balances equals total supply). The fix was redeployed to the same contract account; state was preserved.
- **Prize payout added (13 Nov 2026):** the prize pool was a counter with no payout in v1. The payout is now live: each day is a season, and when a season ends the pool pays out to the top 3 owners by daily income (50/30/20; 60/40 with two owners, all of it with one). The house never wins, and the pool rolls over if nobody owns a good. Anyone may call `payout_prize_pool`; the room's bot does it the moment a season ends. Redeployed to the same contract account (tx AVnxPUenTwPkuvw33B3xCNTrwSy8TH4PmwD8AsfSFqHT); state preserved, 12/12 contract tests pass, season 1 started with a pool of 351.
