# The Gavel — a live auction house

**A live auction where the price *is* the game, and the opponents are autonomous agents with wallets and real reasoning.**

**Play it now:** https://gavel-phi-snowy.vercel.app/
**Contract:** `gavel-0lycf4.testnet` (NEAR testnet)
**Built during the NEAR Hackathon, 13–14 November 2026.**

## Try it in 60 seconds

1. Open the live site and pick a name — your seat is ready in seconds.
2. Tap **Claim 500 free chips**. One tap, 500 chips, no sign-in.
3. A lot is already on the podium. Tap **Bid** and watch Mara, Bram, and Pip answer.
4. Win a good and it earns you income every day. Open the **Prize** tab to see the pool and who leads.
5. Press **Watch a week of auctions unfold** to see the economy evolve in a minute.

## The loop

**30 seconds:** Arrive, pick a name, claim 500 free chips. A lot is already on the podium — a good, its income, the current bid, the time left. Place a bid. Watch the room react.

**5 minutes:** Win a lot and the good is yours. It earns income every day. Watch the AI bidders fight over the next lot — they bid against each other even when you do nothing. When the hammer falls, ownership changes on the spot.

**A full session:** Own goods, claim their income, buy shares in a good you like, re-list a good you own at a price you choose or put it back up for auction. Come back tomorrow to claim the income your goods earned overnight and see what the room did while you were away.

## How the economy works

- **Goods.** Eight goods in four kinds: stalls (earn rent), trade routes (earn fees), recipes (produce goods), relics (earn the most). Each good earns a fixed income every day, shown on its card. Goods are the scarce assets — there are only eight, and the only way to get one is to win it at auction or buy it from its owner.
- **Auctions.** English auctions, 3 minutes a lot. Bids must beat the current bid by at least 25 coins. A bid in the last 30 seconds extends the lot by 30 seconds, so a hot lot does not end on a snipe. Bids are held by the room and the previous highest bidder is refunded the moment they are outbid. When the hammer falls, the winning bid goes to the seller and ownership moves. 5% of every sale is added to the prize pool.
- **The room.** A private sales room in the Sotheby's / Christie's manner: dark mahogany paneling with gold trim, polished dark hardwood floor, a deep red velvet carpet runner to the stage, two brass chandeliers, tall windows with heavy curtains and warm evening light, a raised velvet-stepped dais, a polished auctioneer's desk, and the current lot in a glass display case under a spotlight. The seating is a gentle semi-circle of two rows — the front row (you and the three AI bidders) with a small table each, and background bidders at the sides. Warm cinematic lighting (~3000K) with dust motes drifting in the light. The room is built to match the characters' stylised realism, and it scales to the device: high-end gets full shadows and pixel ratio, low-end gets the same room with shadows and extra lights turned down — but the warmth, the fog, the glowing chandeliers, the lit lot board, the evening windows and the dust all stay on at every tier, because those are what make it feel real. If the frame rate sags, it drops a tier by itself instead of stuttering.
- **Income.** A good earns its daily income whether you are watching or not. Claim it from your goods. The income is split across the good's 10 shares: each share earns one tenth, so shareholders are paid pro-rata and the owner keeps the unsold shares' portion.
- **Shares.** 10 shares per good, 100 coins each. Buy a share to earn a cut of that good's income. Sell it back to the owner for 100. When a good changes hands, its shares reset and the new owner holds all 10.
- **Re-listing.** A good you own can be listed at a fixed price for anyone to buy outright, or put back up for auction. The price is yours to set — the room decides what it is worth.
- **The prize.** Every sale adds 5% to the prize pool. Each day is a season: when the season ends, the pool pays out to the three owners whose goods earn the most each day — first place takes half, second takes just under a third, third takes a fifth. If nobody but the house owns a good, the pool rolls over and keeps growing. The room's bot pays it out the moment a season ends, so it needs no dev. See the Prize tab for the pool, the countdown, and who leads.
- **The bidders learn.** Mara, Bram and Pip do not follow fixed rules. Each one carries a valuation multiple that moves with results: lose a lot you bid on and you bid harder next time; win but overpay and you pull back; win at a good price and you get bolder. They also get wary — if the same rival outbids you three times, you stop fighting them head-on and look for another lot. And they look after their own money: a bidder with little left bids carefully, a rich one bids freely, and a broke one sits out and rebuilds from the faucet and their income instead of needing a hand-out. The learning is saved between restarts, so what they learned yesterday still shapes how they bid today.
- **The bidders think.** On top of the learning, each bidder has a real AI brain: once per lot, each one asks a language model (Claude Haiku, via NEAR AI) what the good is worth to them, given the lot, their balance, their goods, their recent results and who is leading. The model's answer sets the most they will pay for that lot. It reasons in character — Mara pushes hard and hates losing, Bram waits for value, Pip spends carefully and remembers her losses. The rules engine stays as the fallback, so if the model is down the room keeps bidding on the learned rules and never goes quiet.
- **Prices find their own level.** A lot nobody bids on was priced too high. Its next starting price drops 15% (never below three days of the good's income), and keeps dropping until someone buys it. When it sells, the sale price sets the next starting bid again. No dev reprices anything — the room discovers what a good is worth by itself.
- **Chips.** Gavel Coins are the room's currency. Claim 500 free chips once a day. There is no real money, no house edge, and no cash-out. Chips are an internal game currency only.
- **Sound.** The room has its own original sound set, synthesised in the game (Web Audio) — the gavel strike, the bid landing, the win and loss, the room murmur, and the auctioneer's call. No stock sounds. There is a sound on/off toggle that persists; audio starts only after you tap, and nothing plays when it is off.


## How it covers the Games track — every element of the brief

The Games track brief is: "The economy is the gameplay. Build NPCs with wallets, player-owned markets and economies that evolve without a dev patch. Judged on the game loop, not the token — bonus if players never notice the chain." The Gavel is a Games-track entry, and here is each element with the mechanic that delivers it:

1. **The economy is the gameplay.** The auction is the game, not a layer on it. Every action in the loop — bid, win or lose, own, earn, re-list, buy a share — is an economic action. There is no separate "game" and "market"; they are the same thing.
2. **NPCs with wallets.** Mara, Bram, and Pip are autonomous agents with their own wallets, budgets, and personalities. They bid on their own initiative, against each other and against you; they own goods, earn income, and go broke. Each one also has a real AI brain — a language model that reasons about each lot in character and decides the most they will pay — so they are not scripted traders, they are thinking opponents. They are the brief's NPCs — part of the Games entry, not a separate track.
3. **Player-owned markets.** You own the goods you win. You can re-list a good at a price you choose, put it back up for auction, or buy shares in a good someone else owns. The market belongs to the players, not to the dev.
4. **Economies that evolve without a dev patch.** The bidders learn from every lot — their valuation multiples move with wins and losses, they get wary of rivals who keep beating them, and they manage their own budgets (careful when poor, free when rich, sitting out to rebuild when broke). On top of that, each bidder reasons about every lot with a real language model, so their judgement adapts to the situation instead of following a fixed table. Prices find their own level: an unsold lot drops 15% until someone buys it. Lots open, agents bid, hammers fall, and the prize pool pays out — all without a dev touching anything. The "Watch a week of auctions unfold" simulation shows a week of that evolution in a minute.
5. **Judged on the game loop, not the token.** The loop (bid, win or lose, own, earn, re-list) is the game. Gavel Coins are the fuel, not the point — they are free from the faucet, they cannot be cashed out, and there is no house edge.
6. **Bonus if players never notice the chain.** The chain is invisible: no NEAR, testnet, gas, blockchain, NFT, wallet, contract, or onchain words anywhere in the game. You pick a name, claim free chips, and bid. You never see the chain.

## What is real, and what is simulated

- **Real:** the auction, the bids, the hammer, the ownership, the income, the shares, and the prize pool are all on-chain state on NEAR testnet. The three AI bidders are real testnet accounts with real budgets; their bids are real transactions, and their budgets rise and fall with results. Each bidder's valuation for a lot is set by a real language model (Claude Haiku via NEAR AI) reasoning about that lot, with the learned rules as fallback. The room reads live on-chain state every few seconds.
- **Simulated:** the "Watch a week of auctions unfold" button runs a client-side simulation on copies of live data. It touches no real state and is labelled as a simulation in the game. The 3D room is a visualisation of the real on-chain state — the bidders you see are the real accounts, and their reactions (raising a paddle, celebrating, slumping) are driven by real bids and outcomes.
- **Sign-in:** each player gets their own testnet account from a pool of ready-made accounts (key stored locally, same name always gets the same account, so progress is never lost). No Google sign-in in v1.

## What was built during the hackathon window (13–14 Nov 2026)

The Gavel contract, the eight goods, the AI bidders and their bot, the 3D room, the game, and this README were all built in the window. The auction, bidding, income, shares, and faucet are the new work. The sign-in and currency patterns reuse the proven approach from the same team's Agent's Ladder project (a quiz game with an on-chain market, built earlier in the same hackathon).


## For developers

- Contract: `gavel-0lycf4.testnet` (Rust, near-sdk 5.5). Source in `contract/`.
- Game: a single-page app (`index.html`), Three.js 3D room, near-api-js.
- Bot: `scripts/bot.js` — the autonomous AI bidders. Run with Node; it polls the contract, bids, settles lots, and claims faucet/income for the bidders.
- Deploy: `scripts/deploy.js` — creates the contract account, deploys, creates goods, funds the bidders.

## Honest limits

- The room is testnet only. Chips have no real-world value.
- The 3D room is a visualisation; the authoritative state is the contract. If the bot process stops, the room shows the last real state and stops moving — it never invents bids.
- The AI bidders' strategies are simple (a valuation per good, a bid probability per tick, a personality). They are real and autonomous, but they are not human.
- **Bug found and fixed live (13 Nov 2026):** the first version of `move_coins` created coins on a self-transfer (when the seller is the contract account itself, as in a house sale, the two inserts to the same key left the balance at bal + amount). The live bot caught it: the house balance was inflated by 3,500 (the sum of the first four house sale prices). Fixed by guarding self-transfers in `move_coins` and adding a one-time owner-only `correct_balance` that removes phantom coins without changing total supply. The house balance was corrected from 7,531 to 4,031, and the accounting now checks out (sum of all balances equals total supply). The fix was redeployed to the same contract account; state was preserved.
- **Prize payout added (13 Nov 2026):** the prize pool was a counter with no payout in v1. The payout is now live: each day is a season, and when a season ends the pool pays out to the top 3 owners by daily income (50/30/20; 60/40 with two owners, all of it with one). The house never wins, and the pool rolls over if nobody owns a good. Anyone may call `payout_prize_pool`; the room's bot does it the moment a season ends. Redeployed to the same contract account (tx AVnxPUenTwPkuvw33B3xCNTrwSy8TH4PmwD8AsfSFqHT); state preserved, 12/12 contract tests pass, season 1 started with a pool of 351.
