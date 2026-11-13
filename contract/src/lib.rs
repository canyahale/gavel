//! The Gavel — a live auction house game economy for the NEAR hackathon.
//!
//! You and AI agents with their own wallets bid in real time for scarce
//! goods that earn income. The auction is the game, and the price is
//! the economy.
//!
//! Gavel Coins are an INTERNAL on-chain game currency: they are minted
//! and moved by this contract, they are NOT redeemable for NEAR, and
//! they are NOT NEAR-backed. Testnet NEAR pays transaction costs and
//! funds the account infrastructure; players never need to understand
//! any of that.
//!
//! Core rules:
//! - Faucet: 500 Gavel Coins once per day per account.
//! - Goods (stall, route, recipe, relic) earn income every day. The
//!   owner claims it; each of the 10 shares in a good earns 1/10 of
//!   the income, so shareholders are paid pro-rata and the owner keeps
//!   the unsold shares' portion.
//! - English auctions: a lot opens with a starting bid, bids must beat
//!   the current bid by at least the minimum increment, a bid in the
//!   last 30 seconds extends the lot by 30 seconds (anti-snipe), and
//!   the highest bidder wins. Bids are escrowed by the contract and
//!   the previous highest bidder is refunded the moment they are
//!   outbid. On settlement the winning bid moves to the seller and
//!   ownership transfers; 5% of the winning bid is minted extra to
//!   the prize pool (the seller still receives the full bid).
//! - A good you own can also be listed at a fixed price and bought
//!   outright, or put back up for auction by its owner.
//! - Shares: 10 per good at 100 coins each. Buy a share to earn a
//!   pro-rata cut of the good's income; sell it back to the owner
//!   for 100. Shares reset when a good changes hands.
//! - Prize seasons: each day is a season. When a season ends, anyone
//!   may call `payout_prize_pool`: the pool (5% of every sale) pays
//!   out to the season's top 3 good owners by daily income, 50/30/20,
//!   then a new season starts. If nobody but the house owns a good,
//!   the pool rolls over and keeps growing. The house never wins.
//! - The house seeds each AI bidder with a starting bankroll via the
//!   owner-only `seed_bankroll` (transparent: it mints coins, so it
//!   shows in total supply). AI bidders then win and lose on their
//!   own; their budgets rise and fall with results.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};

/// The single Gavel Coin token id (NEP-245).
pub const GAVEL_TOKEN_ID: &str = "gavel";
/// Faucet grant, once per day per account.
pub const FAUCET_AMOUNT: u128 = 500;
/// One day, in nanoseconds.
pub const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// Minimum bid increment, in Gavel Coins.
pub const MIN_INCREMENT: u128 = 25;
/// Anti-snipe window: a bid inside this window extends the lot.
pub const ANTI_SNIPE_NS: u64 = 30 * 1_000_000_000;
/// Anti-snipe extension, in nanoseconds.
pub const ANTI_SNIPE_EXTEND_NS: u64 = 30 * 1_000_000_000;
/// Price of one share in a good's income, in Gavel Coins.
pub const SHARE_PRICE: u128 = 100;
/// Shares in one good's income. The owner starts holding all 10.
pub const SHARES_PER_GOOD: u8 = 10;
/// Fee on every sale (percent of the price) minted extra to the prize
/// pool. The seller still receives the full price.
pub const SALE_FEE_PERCENT: u128 = 5;
/// A prize season lasts one day. When a season ends, anyone may call
/// `payout_prize_pool`: the pool pays out to the season's top 3 good
/// owners by daily income (50/30/20), then a new season starts. The
/// pool is a counter of coins to be minted on payout, not minted
/// coins, so paying it out mints exactly the pool amount.
pub const SEASON_NS: u64 = DAY_NS;
/// Minimum auction duration, in seconds.
pub const MIN_AUCTION_SECONDS: u64 = 60;
/// Maximum auction duration, in seconds.
pub const MAX_AUCTION_SECONDS: u64 = 3600;

/// Storage prefixes for state that lives OUTSIDE the `Contract` struct
/// (same pattern as the Ladder): a redeploy keeps every record intact.
const GOODS_PREFIX: &[u8] = b"gd";
const GOODS_KEYS_KEY: &[u8] = b"gdk";
const AUCTIONS_PREFIX: &[u8] = b"au";
const AUCTIONS_KEYS_KEY: &[u8] = b"auk";
const SHARES_PREFIX: &[u8] = b"sh";
/// Current prize season (stored separately so a redeploy keeps it).
const SEASON_KEY: &[u8] = b"season";
/// The most recent prize payout (stored separately).
const LAST_PAYOUT_KEY: &[u8] = b"payout";

/// One good: a scarce, income-earning asset. Goods are NEP-245 tokens
/// in spirit (each good id is a token), and Gavel Coins are the NEP-245
/// currency that buys them.
#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Debug,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(crate = "near_sdk::serde")]
pub struct Good {
    pub good_id: String,
    pub name: String,
    /// "stall" | "route" | "recipe" | "relic".
    pub kind: String,
    /// Income in Gavel Coins per day.
    #[schemars(with = "String")]
    pub income_per_day: U128,
    pub owner_id: AccountId,
    /// Fixed-price listing (None = not listed at a fixed price).
    #[schemars(with = "Option<String>")]
    pub listed_price: Option<U128>,
    /// Block timestamp (ns) income was last claimed at.
    pub last_income_claim_at: u64,
}

/// One auction (a lot in the room).
#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Debug,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(crate = "near_sdk::serde")]
pub struct Auction {
    pub auction_id: u64,
    pub good_id: String,
    pub seller_id: AccountId,
    #[schemars(with = "String")]
    pub starting_bid: U128,
    #[schemars(with = "String")]
    pub current_bid: U128,
    pub current_bidder: Option<AccountId>,
    /// Block timestamp (ns) the lot closes.
    pub ends_at: u64,
    pub settled: bool,
    pub winner: Option<AccountId>,
    pub bids_count: u32,
}

/// One account's shares in one good's income.
#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Debug,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(crate = "near_sdk::serde")]
pub struct ShareHolding {
    pub account: AccountId,
    pub shares: u8,
}

/// A good as returned by the views: stored fields plus live income
/// accrued and shares sold.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct GoodView {
    pub good_id: String,
    pub name: String,
    pub kind: String,
    #[schemars(with = "String")]
    pub income_per_day: U128,
    pub owner_id: AccountId,
    #[schemars(with = "Option<String>")]
    pub listed_price: Option<U128>,
    #[schemars(with = "String")]
    pub income_accrued: U128,
    pub shares_sold: u8,
}

/// An auction as returned by the views.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct AuctionView {
    pub auction_id: u64,
    pub good_id: String,
    pub good_name: String,
    pub good_kind: String,
    #[schemars(with = "String")]
    pub good_income_per_day: U128,
    pub seller_id: AccountId,
    #[schemars(with = "String")]
    pub starting_bid: U128,
    #[schemars(with = "String")]
    pub current_bid: U128,
    pub current_bidder: Option<AccountId>,
    pub ends_at: u64,
    pub settled: bool,
    pub winner: Option<AccountId>,
    pub bids_count: u32,
}

/// Shares in one good's income, as returned by `get_shares`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct SharesView {
    pub good_id: String,
    pub total_sold: u8,
    pub holders: Vec<ShareHolding>,
}

/// The current prize season, stored under SEASON_KEY. A season lasts
/// one day; when it ends, `payout_prize_pool` pays the pool to the
/// top 3 owners and starts the next season.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug)]
pub struct SeasonState {
    pub season_number: u64,
    /// Block timestamp (ns) the current season started.
    pub season_start: u64,
    /// The last season that was paid out (0 = none yet).
    pub last_payout_season: u64,
}

/// One winner of a prize payout.
#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Debug,
    PartialEq,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(crate = "near_sdk::serde")]
pub struct PayoutWinner {
    pub account: AccountId,
    #[schemars(with = "String")]
    pub amount: U128,
}

/// One prize payout, stored under LAST_PAYOUT_KEY so the room can
/// show who won the last season.
#[derive(
    BorshDeserialize,
    BorshSerialize,
    Clone,
    Debug,
    PartialEq,
    serde::Serialize,
    serde::Deserialize,
    schemars::JsonSchema,
)]
#[serde(crate = "near_sdk::serde")]
pub struct PayoutRecord {
    pub season_number: u64,
    /// Winners in rank order. Empty when no one was eligible and the
    /// pool rolled over.
    pub winners: Vec<PayoutWinner>,
    #[schemars(with = "String")]
    pub total_paid: U128,
    /// Block timestamp (ns) the payout happened.
    pub paid_at: u64,
}

/// One row of the leaderboard: a player's total daily income from
/// the goods they own. The house (contract owner) is excluded.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct LeaderboardEntry {
    pub account: AccountId,
    #[schemars(with = "String")]
    pub income_per_day: U128,
    pub goods_owned: u8,
}

/// The prize season as returned by `get_season_info`.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct SeasonView {
    pub season_number: u64,
    pub season_start: u64,
    pub season_end: u64,
    /// Seconds until the season ends (0 when it has ended).
    pub seconds_remaining: u64,
    #[schemars(with = "String")]
    pub prize_pool: U128,
    pub can_payout: bool,
    pub last_payout_season: u64,
}

/// Minimal NEP-245 token metadata.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct TokenMetadata {
    pub title: Option<String>,
    pub description: Option<String>,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
}

/// Minimal NEP-245 token record.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
#[serde(crate = "near_sdk::serde")]
pub struct MtToken {
    pub token_id: String,
    pub owner_id: AccountId,
    pub metadata: Option<TokenMetadata>,
}

// ─── Storage helpers (outside the Contract struct) ─────────────────

fn goods_map() -> LookupMap<String, Good> {
    LookupMap::new(GOODS_PREFIX)
}

fn read_goods_keys() -> Vec<String> {
    match env::storage_read(GOODS_KEYS_KEY) {
        Some(bytes) => Vec::<String>::try_from_slice(&bytes).unwrap_or_default(),
        None => vec![],
    }
}

fn write_goods_keys(keys: &[String]) {
    env::storage_write(GOODS_KEYS_KEY, &borsh::to_vec(keys).unwrap());
}

fn goods_insert(good: Good) {
    let mut map = goods_map();
    if map.get(&good.good_id).is_none() {
        let mut keys = read_goods_keys();
        keys.push(good.good_id.clone());
        write_goods_keys(&keys);
    }
    map.insert(good.good_id.clone(), good);
}

fn auctions_map() -> LookupMap<u64, Auction> {
    LookupMap::new(AUCTIONS_PREFIX)
}

fn read_auction_keys() -> Vec<u64> {
    match env::storage_read(AUCTIONS_KEYS_KEY) {
        Some(bytes) => Vec::<u64>::try_from_slice(&bytes).unwrap_or_default(),
        None => vec![],
    }
}

fn write_auction_keys(keys: &[u64]) {
    env::storage_write(AUCTIONS_KEYS_KEY, &borsh::to_vec(keys).unwrap());
}

fn auctions_insert(auction: Auction) {
    let mut map = auctions_map();
    if map.get(&auction.auction_id).is_none() {
        let mut keys = read_auction_keys();
        keys.push(auction.auction_id);
        write_auction_keys(&keys);
    }
    map.insert(auction.auction_id, auction);
}

fn shares_map() -> LookupMap<String, Vec<ShareHolding>> {
    LookupMap::new(SHARES_PREFIX)
}

fn shares_for(good_id: &str) -> Vec<ShareHolding> {
    shares_map()
        .get(&good_id.to_string())
        .cloned()
        .unwrap_or_default()
}

fn set_shares(good_id: &str, holdings: Vec<ShareHolding>) {
    if holdings.is_empty() {
        shares_map().remove(&good_id.to_string());
    } else {
        shares_map().insert(good_id.to_string(), holdings);
    }
}

fn shares_sold(holdings: &[ShareHolding]) -> u8 {
    holdings.iter().map(|h| h.shares).sum()
}

fn read_season_state() -> Option<SeasonState> {
    match env::storage_read(SEASON_KEY) {
        Some(bytes) => SeasonState::try_from_slice(&bytes).ok(),
        None => None,
    }
}

fn write_season_state(state: &SeasonState) {
    env::storage_write(SEASON_KEY, &borsh::to_vec(state).unwrap());
}

fn read_last_payout() -> Option<PayoutRecord> {
    match env::storage_read(LAST_PAYOUT_KEY) {
        Some(bytes) => PayoutRecord::try_from_slice(&bytes).ok(),
        None => None,
    }
}

fn write_last_payout(record: &PayoutRecord) {
    env::storage_write(LAST_PAYOUT_KEY, &borsh::to_vec(record).unwrap());
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    pub owner_id: AccountId,
    pub treasury: AccountId,
    /// Gavel Coin balances (NEP-245, single token id "gavel").
    /// The contract's own balance (key = current account) holds
    /// escrowed bids.
    pub balances: LookupMap<AccountId, u128>,
    pub total_supply: u128,
    /// Day number (block timestamp / DAY_NS) each account last
    /// claimed the faucet in.
    pub faucet_claimed_day: LookupMap<AccountId, u64>,
    /// Prize pool: 5% of every sale, minted extra. Paid out by
    /// `payout_prize_pool` at the end of each daily season.
    pub prize_pool: u128,
    /// Next auction id.
    pub next_auction_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, treasury: AccountId) -> Self {
        Self {
            owner_id,
            treasury,
            balances: LookupMap::new(b"b"),
            total_supply: 0,
            faucet_claimed_day: LookupMap::new(b"f"),
            prize_pool: 0,
            next_auction_id: 1,
        }
    }

    // ─── Internal token helpers ──────────────────────────────────

    fn balance_of(&self, account_id: &AccountId) -> u128 {
        self.balances.get(account_id).copied().unwrap_or(0)
    }

    fn mint(&mut self, account_id: &AccountId, amount: u128) {
        let b = self.balance_of(account_id) + amount;
        self.balances.insert(account_id.clone(), b);
        self.total_supply += amount;
    }

    /// Move `amount` from `from` to `to`. Panics on insufficient balance.
    /// A self-transfer is a no-op: without this guard the two inserts
    /// to the same key would leave the balance at bal + amount, creating
    /// coins from nothing (found by the live bot: house settlements
    /// inflated the house balance by the sale price each time).
    fn move_coins(&mut self, from: &AccountId, to: &AccountId, amount: u128) {
        if from == to {
            return;
        }
        assert!(
            self.balance_of(from) >= amount,
            "Insufficient Gavel Coin balance"
        );
        let fb = self.balance_of(from) - amount;
        let tb = self.balance_of(to) + amount;
        self.balances.insert(from.clone(), fb);
        self.balances.insert(to.clone(), tb);
    }

    fn assert_owner(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only the owner can call this"
        );
    }

    fn current_day() -> u64 {
        env::block_timestamp() / DAY_NS
    }

    /// Income accrued by a good since its last claim.
    fn income_accrued(good: &Good) -> u128 {
        let elapsed = env::block_timestamp().saturating_sub(good.last_income_claim_at);
        good.income_per_day.0 * (elapsed as u128) / (DAY_NS as u128)
    }

    fn good_view(&self, good: &Good) -> GoodView {
        GoodView {
            good_id: good.good_id.clone(),
            name: good.name.clone(),
            kind: good.kind.clone(),
            income_per_day: good.income_per_day,
            owner_id: good.owner_id.clone(),
            listed_price: good.listed_price,
            income_accrued: U128(Self::income_accrued(good)),
            shares_sold: shares_sold(&shares_for(&good.good_id)),
        }
    }

    fn auction_view(&self, auction: &Auction) -> AuctionView {
        let good = goods_map()
            .get(&auction.good_id)
            .cloned()
            .unwrap_or(Good {
                good_id: auction.good_id.clone(),
                name: auction.good_id.clone(),
                kind: "unknown".to_string(),
                income_per_day: U128(0),
                owner_id: auction.seller_id.clone(),
                listed_price: None,
                last_income_claim_at: 0,
            });
        AuctionView {
            auction_id: auction.auction_id,
            good_id: auction.good_id.clone(),
            good_name: good.name,
            good_kind: good.kind,
            good_income_per_day: good.income_per_day,
            seller_id: auction.seller_id.clone(),
            starting_bid: auction.starting_bid,
            current_bid: auction.current_bid,
            current_bidder: auction.current_bidder.clone(),
            ends_at: auction.ends_at,
            settled: auction.settled,
            winner: auction.winner.clone(),
            bids_count: auction.bids_count,
        }
    }

    // ─── NEP-245 multi token (Gavel Coins) ───────────────────────

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        assert_eq!(token_id, GAVEL_TOKEN_ID, "Unknown token");
        U128(self.balance_of(&account_id))
    }

    pub fn mt_total_supply(&self, token_id: String) -> U128 {
        assert_eq!(token_id, GAVEL_TOKEN_ID, "Unknown token");
        U128(self.total_supply)
    }

    pub fn mt_tokens(&self, _from_index: Option<U128>, _limit: Option<u64>) -> Vec<String> {
        vec![GAVEL_TOKEN_ID.to_string()]
    }

    pub fn mt_token(&self, token_id: String) -> Option<MtToken> {
        if token_id != GAVEL_TOKEN_ID {
            return None;
        }
        Some(MtToken {
            token_id: GAVEL_TOKEN_ID.to_string(),
            owner_id: env::current_account_id(),
            metadata: Some(TokenMetadata {
                title: Some("Gavel Coin".to_string()),
                description: Some(
                    "Gavel Coin is an internal on-chain game currency. It is not redeemable for NEAR."
                        .to_string(),
                ),
                symbol: Some("GAVEL".to_string()),
                decimals: Some(0),
            }),
        })
    }

    /// Transfer Gavel Coins to another account. Requires 1 yoctoNEAR.
    /// (The Ladder's mt_transfer was missing #[payable] and could never
    /// succeed; this one has it.)
    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        _memo: Option<String>,
    ) {
        assert_eq!(token_id, GAVEL_TOKEN_ID, "Unknown token");
        assert_eq!(
            env::attached_deposit(),
            NearToken::from_yoctonear(1),
            "Requires 1 yoctoNEAR"
        );
        let sender = env::predecessor_account_id();
        self.move_coins(&sender, &receiver_id, amount.0);
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        _memo: Option<String>,
    ) {
        assert_eq!(
            token_ids.len(),
            amounts.len(),
            "Tokens and amounts length mismatch"
        );
        assert_eq!(
            env::attached_deposit(),
            NearToken::from_yoctonear(1),
            "Requires 1 yoctoNEAR"
        );
        let sender = env::predecessor_account_id();
        for (t, a) in token_ids.iter().zip(amounts.iter()) {
            assert_eq!(t, GAVEL_TOKEN_ID, "Unknown token");
            self.move_coins(&sender, &receiver_id, a.0);
        }
    }

    // ─── Faucet ──────────────────────────────────────────────────

    /// Gives the caller 500 Gavel Coins once per day.
    /// Fails if already claimed today.
    pub fn claim_faucet(&mut self) -> U128 {
        let caller = env::predecessor_account_id();
        let claimed = self
            .faucet_claimed_day
            .get(&caller)
            .copied()
            .unwrap_or(0);
        let today = Self::current_day();
        assert_ne!(claimed, today, "Faucet already claimed today");
        self.faucet_claimed_day.insert(caller.clone(), today);
        self.mint(&caller, FAUCET_AMOUNT);
        U128(self.balance_of(&caller))
    }

    /// Whether the caller can claim the faucet right now.
    pub fn can_claim_faucet(&self, account_id: AccountId) -> bool {
        let claimed = self
            .faucet_claimed_day
            .get(&account_id)
            .copied()
            .unwrap_or(0);
        claimed != Self::current_day()
    }

    // ─── Goods (owner creates them) ──────────────────────────────

    /// Owner-only: create a good. The owner holds it until it is sold
    /// at auction or at a fixed price.
    pub fn create_good(
        &mut self,
        good_id: String,
        name: String,
        kind: String,
        income_per_day: U128,
    ) {
        self.assert_owner();
        assert!(
            goods_map().get(&good_id).is_none(),
            "Good already exists"
        );
        assert!(income_per_day.0 > 0, "Income must be greater than 0");
        goods_insert(Good {
            good_id,
            name,
            kind,
            income_per_day,
            owner_id: self.owner_id.clone(),
            listed_price: None,
            last_income_claim_at: env::block_timestamp(),
        });
    }

    /// Owner-only: seed a starting bankroll (mints coins). Used to
    /// fund the AI bidders' starting budgets; it mints, so it shows
    /// in total supply. Documented in the README.
    pub fn seed_bankroll(&mut self, account_id: AccountId, amount: U128) {
        self.assert_owner();
        assert!(amount.0 > 0, "Amount must be greater than 0");
        self.mint(&account_id, amount.0);
    }

    /// Owner-only: remove `amount` from an account's balance WITHOUT
    /// changing total supply. A one-time correction for the self-transfer
    /// bug (fixed in `move_coins`): house settlements before the fix
    /// inflated the house balance by the sale price each time, creating
    /// phantom coins that were never minted. This removes exactly that
    /// phantom amount. It cannot create coins and it cannot mint.
    pub fn correct_balance(&mut self, account_id: AccountId, amount: U128) {
        self.assert_owner();
        assert!(amount.0 > 0, "Amount must be greater than 0");
        let bal = self.balance_of(&account_id);
        assert!(bal >= amount.0, "Correction exceeds the balance");
        self.balances.insert(account_id, bal - amount.0);
    }

    // ─── Income ──────────────────────────────────────────────────

    /// Income accrued by a good since its last claim (view).
    pub fn get_income_accrued(&self, good_id: String) -> U128 {
        let good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        U128(Self::income_accrued(&good))
    }

    /// Claims a good's accrued income. The caller must own the good.
    /// The income is minted and split pro-rata across the good's 10
    /// shares: each share earns 1/10, the owner keeps the unsold
    /// shares' portion. Returns the amount the caller received.
    pub fn claim_income(&mut self, good_id: String) -> U128 {
        let caller = env::predecessor_account_id();
        let mut good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        assert_eq!(good.owner_id, caller, "Only the owner can claim income");
        let accrued = Self::income_accrued(&good);
        assert!(accrued > 0, "No income accrued yet");
        good.last_income_claim_at = env::block_timestamp();
        goods_insert(good.clone());
        let per_share = accrued / (SHARES_PER_GOOD as u128);
        let holdings = shares_for(&good_id);
        let mut paid_out = 0u128;
        for h in &holdings {
            let share_income = per_share * (h.shares as u128);
            if share_income > 0 {
                self.mint(&h.account, share_income);
                paid_out += share_income;
            }
        }
        let owner_income = accrued - paid_out;
        if owner_income > 0 {
            self.mint(&caller, owner_income);
        }
        U128(owner_income)
    }

    // ─── Auctions ────────────────────────────────────────────────

    /// Opens a lot for a good the caller owns. `starting_bid` must be
    /// above 0; duration 60..3600 seconds. The good must not already
    /// be in an open auction or listed at a fixed price.
    pub fn open_auction(
        &mut self,
        good_id: String,
        starting_bid: U128,
        duration_seconds: u64,
    ) -> u64 {
        let caller = env::predecessor_account_id();
        let mut good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        assert_eq!(good.owner_id, caller, "Only the owner can auction this good");
        assert!(starting_bid.0 > 0, "Starting bid must be greater than 0");
        assert!(
            duration_seconds >= MIN_AUCTION_SECONDS
                && duration_seconds <= MAX_AUCTION_SECONDS,
            "Duration must be 60..3600 seconds"
        );
        assert!(
            good.listed_price.is_none(),
            "Good is listed at a fixed price; delist it first"
        );
        for id in read_auction_keys() {
            if let Some(a) = auctions_map().get(&id) {
                assert!(
                    !(a.good_id == good_id && !a.settled),
                    "Good already has an open auction"
                );
            }
        }
        let auction_id = self.next_auction_id;
        self.next_auction_id += 1;
        let now = env::block_timestamp();
        auctions_insert(Auction {
            auction_id,
            good_id: good_id.clone(),
            seller_id: caller,
            starting_bid,
            current_bid: U128(0),
            current_bidder: None,
            ends_at: now + duration_seconds * 1_000_000_000,
            settled: false,
            winner: None,
            bids_count: 0,
        });
        good.listed_price = None;
        goods_insert(good);
        auction_id
    }

    /// Places a bid. The bid must beat the current bid by at least
    /// the minimum increment (or meet the starting bid when there are
    /// no bids yet). The bid is escrowed by the contract; the previous
    /// highest bidder is refunded the moment they are outbid. A bid
    /// inside the last 30 seconds extends the lot by 30 seconds.
    pub fn place_bid(&mut self, auction_id: u64, amount: U128) {
        let caller = env::predecessor_account_id();
        let mut auction = auctions_map()
            .get(&auction_id)
            .cloned()
            .expect("Auction does not exist");
        assert!(!auction.settled, "Auction is settled");
        let now = env::block_timestamp();
        assert!(now < auction.ends_at, "Auction has ended");
        let min_bid = if auction.bids_count == 0 {
            auction.starting_bid.0
        } else {
            auction.current_bid.0 + MIN_INCREMENT
        };
        assert!(
            amount.0 >= min_bid,
            "Bid must be at least the minimum bid"
        );
        assert_ne!(
            auction.current_bidder,
            Some(caller.clone()),
            "You are already the highest bidder"
        );
        assert!(
            self.balance_of(&caller) >= amount.0,
            "Insufficient Gavel Coin balance"
        );
        // Escrow the new bid.
        let contract_id = env::current_account_id();
        self.move_coins(&caller, &contract_id, amount.0);
        // Refund the previous highest bidder.
        if let Some(prev) = auction.current_bidder.clone() {
            let prev_bid = auction.current_bid.0;
            if prev_bid > 0 {
                self.move_coins(&contract_id, &prev, prev_bid);
            }
        }
        auction.current_bid = amount;
        auction.current_bidder = Some(caller);
        auction.bids_count += 1;
        // Anti-snipe: extend when a bid lands in the last 30 seconds.
        if auction.ends_at.saturating_sub(now) < ANTI_SNIPE_NS {
            auction.ends_at = now + ANTI_SNIPE_EXTEND_NS;
        }
        auctions_insert(auction);
    }

    /// Settles a lot after it ends. Anyone may call it. The winning
    /// bid moves from escrow to the seller, ownership transfers to
    /// the winner, shares reset (the new owner holds all 10), and 5%
    /// of the winning bid is minted extra to the prize pool. With no
    /// bids the good stays with the seller. Returns the winner, if any.
    pub fn settle_auction(&mut self, auction_id: u64) -> Option<AccountId> {
        let mut auction = auctions_map()
            .get(&auction_id)
            .cloned()
            .expect("Auction does not exist");
        assert!(!auction.settled, "Auction is already settled");
        assert!(
            env::block_timestamp() >= auction.ends_at,
            "Auction has not ended yet"
        );
        auction.settled = true;
        let winner = auction.current_bidder.clone();
        if let Some(winner_id) = winner.clone() {
            let price = auction.current_bid.0;
            let contract_id = env::current_account_id();
            // Escrowed winning bid to the seller.
            self.move_coins(&contract_id, &auction.seller_id, price);
            // 5% minted extra to the prize pool.
            self.prize_pool += price * SALE_FEE_PERCENT / 100;
            // Ownership transfers; shares reset.
            let mut good = goods_map()
                .get(&auction.good_id)
                .cloned()
                .expect("Good does not exist");
            good.owner_id = winner_id.clone();
            good.listed_price = None;
            goods_insert(good);
            set_shares(&auction.good_id, vec![]);
            auction.winner = Some(winner_id);
        }
        auctions_insert(auction);
        winner
    }

    // ─── Fixed-price listings ────────────────────────────────────

    /// Lists a good you own at a fixed price. Clears any open auction
    /// is not possible here (open_auction blocks when listed); the
    /// good must not be in an open auction.
    pub fn list_good(&mut self, good_id: String, price: U128) {
        let caller = env::predecessor_account_id();
        let mut good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        assert_eq!(good.owner_id, caller, "Only the owner can list this good");
        assert!(price.0 > 0, "Price must be greater than 0");
        for id in read_auction_keys() {
            if let Some(a) = auctions_map().get(&id) {
                assert!(
                    !(a.good_id == good_id && !a.settled),
                    "Good has an open auction; settle it first"
                );
            }
        }
        good.listed_price = Some(price);
        goods_insert(good);
    }

    /// Removes a fixed-price listing. Only the owner.
    pub fn delist_good(&mut self, good_id: String) {
        let caller = env::predecessor_account_id();
        let mut good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        assert_eq!(good.owner_id, caller, "Only the owner can delist this good");
        good.listed_price = None;
        goods_insert(good);
    }

    /// Buys a fixed-price listed good. The price moves from buyer to
    /// seller, ownership transfers, shares reset, and 5% of the price
    /// is minted extra to the prize pool.
    pub fn buy_good(&mut self, good_id: String) {
        let caller = env::predecessor_account_id();
        let mut good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        let price = good.listed_price.expect("Good is not for sale");
        assert_ne!(good.owner_id, caller, "You already own this good");
        assert!(
            self.balance_of(&caller) >= price.0,
            "Insufficient Gavel Coin balance"
        );
        let seller = good.owner_id.clone();
        self.move_coins(&caller, &seller, price.0);
        self.prize_pool += price.0 * SALE_FEE_PERCENT / 100;
        good.owner_id = caller;
        good.listed_price = None;
        goods_insert(good);
        set_shares(&good_id, vec![]);
    }

    // ─── Shares ──────────────────────────────────────────────────

    /// Buys one share in a good's income for exactly 100 Gavel Coins.
    /// The price goes to the good's owner. The owner already holds
    /// the unsold shares.
    pub fn buy_share(&mut self, good_id: String) {
        let caller = env::predecessor_account_id();
        let good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        assert_ne!(
            good.owner_id, caller,
            "The owner already holds the unsold shares"
        );
        let holdings = shares_for(&good_id);
        assert!(
            shares_sold(&holdings) < SHARES_PER_GOOD,
            "All 10 shares are sold"
        );
        assert!(
            self.balance_of(&caller) >= SHARE_PRICE,
            "Need at least 100 Gavel Coins to buy a share"
        );
        self.move_coins(&caller, &good.owner_id, SHARE_PRICE);
        let mut holdings = holdings;
        if let Some(h) = holdings.iter_mut().find(|h| h.account == caller) {
            h.shares += 1;
        } else {
            holdings.push(ShareHolding {
                account: caller,
                shares: 1,
            });
        }
        set_shares(&good_id, holdings);
    }

    /// Sells one of the caller's shares back to the good's owner for
    /// exactly 100 Gavel Coins. The owner must hold at least 100.
    pub fn sell_share(&mut self, good_id: String) {
        let caller = env::predecessor_account_id();
        let good = goods_map()
            .get(&good_id)
            .cloned()
            .expect("Good does not exist");
        let mut holdings = shares_for(&good_id);
        let idx = holdings
            .iter()
            .position(|h| h.account == caller)
            .expect("You hold no shares in this good");
        assert!(
            self.balance_of(&good.owner_id) >= SHARE_PRICE,
            "The owner cannot buy back the share right now"
        );
        self.move_coins(&good.owner_id, &caller, SHARE_PRICE);
        holdings[idx].shares -= 1;
        if holdings[idx].shares == 0 {
            holdings.remove(idx);
        }
        set_shares(&good_id, holdings);
    }

    pub fn get_shares(&self, good_id: String) -> SharesView {
        let holdings = shares_for(&good_id);
        SharesView {
            good_id,
            total_sold: shares_sold(&holdings),
            holders: holdings,
        }
    }

    pub fn get_all_shares(&self) -> Vec<SharesView> {
        read_goods_keys()
            .iter()
            .map(|k| self.get_shares(k.clone()))
            .filter(|v| v.total_sold > 0)
            .collect()
    }

    // ─── Views ───────────────────────────────────────────────────

    pub fn get_good(&self, good_id: String) -> Option<GoodView> {
        goods_map().get(&good_id).map(|g| self.good_view(g))
    }

    pub fn get_goods(&self) -> Vec<GoodView> {
        read_goods_keys()
            .iter()
            .filter_map(|k| goods_map().get(k).map(|g| self.good_view(g)))
            .collect()
    }

    pub fn get_auction(&self, auction_id: u64) -> Option<AuctionView> {
        auctions_map().get(&auction_id).map(|a| self.auction_view(a))
    }

    pub fn get_auctions(&self) -> Vec<AuctionView> {
        read_auction_keys()
            .iter()
            .filter_map(|id| auctions_map().get(id).map(|a| self.auction_view(a)))
            .collect()
    }

    /// Lots that are open right now (not settled, not ended).
    pub fn get_open_auctions(&self) -> Vec<AuctionView> {
        let now = env::block_timestamp();
        let map = auctions_map();
        read_auction_keys()
            .iter()
            .filter_map(|id| map.get(id))
            .filter(|a| !a.settled && now < a.ends_at)
            .map(|a| self.auction_view(a))
            .collect()
    }

    pub fn get_prize_pool(&self) -> U128 {
        U128(self.prize_pool)
    }

    // ─── Prize seasons ───────────────────────────────────────────

    /// The leaderboard: every account that owns at least one good,
    /// ranked by the total daily income of the goods they own. The
    /// house (contract owner) is excluded — it never wins the pool.
    fn leaderboard(&self) -> Vec<LeaderboardEntry> {
        let mut totals: std::collections::HashMap<AccountId, (u128, u8)> =
            std::collections::HashMap::new();
        for key in read_goods_keys() {
            if let Some(good) = goods_map().get(&key) {
                if good.owner_id == self.owner_id {
                    continue;
                }
                let e = totals.entry(good.owner_id.clone()).or_insert((0, 0));
                e.0 += good.income_per_day.0;
                e.1 += 1;
            }
        }
        let mut rows: Vec<LeaderboardEntry> = totals
            .into_iter()
            .map(|(account, (income_per_day, goods_owned))| LeaderboardEntry {
                account,
                income_per_day: U128(income_per_day),
                goods_owned,
            })
            .collect();
        rows.sort_by(|a, b| {
            b.income_per_day
                .0
                .cmp(&a.income_per_day.0)
                .then_with(|| a.account.cmp(&b.account))
        });
        rows
    }

    /// The leaderboard as a view (top owners by daily income).
    pub fn get_leaderboard(&self) -> Vec<LeaderboardEntry> {
        self.leaderboard()
    }

    /// The prize season as a view: number, start/end, time left, the
    /// pool, and whether a payout is available right now. Before the
    /// first payout call, season 1 is shown as starting now.
    pub fn get_season_info(&self) -> SeasonView {
        let now = env::block_timestamp();
        let state = read_season_state().unwrap_or(SeasonState {
            season_number: 1,
            season_start: now,
            last_payout_season: 0,
        });
        let season_end = state.season_start.saturating_add(SEASON_NS);
        SeasonView {
            season_number: state.season_number,
            season_start: state.season_start,
            season_end,
            seconds_remaining: season_end
                .saturating_sub(now)
                .saturating_div(1_000_000_000),
            prize_pool: U128(self.prize_pool),
            can_payout: now >= season_end,
            last_payout_season: state.last_payout_season,
        }
    }

    /// The most recent prize payout, if any.
    pub fn get_last_payout(&self) -> Option<PayoutRecord> {
        read_last_payout()
    }

    /// Pays the prize pool out at the end of a season. Anyone may call
    /// it; the room's bot does it the moment a season ends, so the
    /// economy pays out without a dev. Returns the payout record, or
    /// None when the season has not ended yet (the first call also
    /// starts season 1, so the season runs from first use).
    ///
    /// The top 3 owners by daily income split the pool 50/30/20.
    /// With two owners it is 60/40; with one, that owner takes all.
    /// The winner takes any rounding remainder. If nobody but the
    /// house owns a good, nobody is paid and the pool rolls over to
    /// the next season. The pool is minted to the winners on payout.
    pub fn payout_prize_pool(&mut self) -> Option<PayoutRecord> {
        let now = env::block_timestamp();
        let mut state = read_season_state().unwrap_or(SeasonState {
            season_number: 1,
            season_start: now,
            last_payout_season: 0,
        });
        // Season not over yet: make sure the season is stored, then
        // report that there is nothing to pay out.
        if now < state.season_start.saturating_add(SEASON_NS) {
            write_season_state(&state);
            return None;
        }
        let season_number = state.season_number;
        let pool = self.prize_pool;
        let leaders = self.leaderboard();
        let mut winners: Vec<PayoutWinner> = vec![];
        if !leaders.is_empty() && pool > 0 {
            let amounts: Vec<u128> = match leaders.len() {
                1 => vec![pool],
                2 => {
                    let first = pool * 60 / 100;
                    vec![first, pool - first]
                }
                _ => {
                    let second = pool * 30 / 100;
                    let third = pool * 20 / 100;
                    let first = pool - second - third;
                    vec![first, second, third]
                }
            };
            for (i, entry) in leaders.iter().take(3).enumerate() {
                let amount = amounts[i];
                if amount > 0 {
                    self.mint(&entry.account, amount);
                    winners.push(PayoutWinner {
                        account: entry.account.clone(),
                        amount: U128(amount),
                    });
                }
            }
        }
        let total_paid: u128 = winners.iter().map(|w| w.amount.0).sum();
        self.prize_pool = 0;
        state.last_payout_season = season_number;
        state.season_number += 1;
        state.season_start = now;
        write_season_state(&state);
        let record = PayoutRecord {
            season_number,
            winners,
            total_paid: U128(total_paid),
            paid_at: now,
        };
        write_last_payout(&record);
        Some(record)
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner_id.clone()
    }

    pub fn get_treasury(&self) -> AccountId {
        self.treasury.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::{testing_env, AccountId};

    fn alice() -> AccountId {
        accounts(0)
    }
    fn bob() -> AccountId {
        accounts(1)
    }
    fn carol() -> AccountId {
        accounts(2)
    }

    fn ctx(predecessor: AccountId, timestamp: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(predecessor);
        b.block_timestamp(timestamp);
        // The contract account is alice in these tests (she is the
        // owner), so escrow and self-transfers behave as on-chain.
        b.current_account_id(alice());
        b
    }

    fn setup() -> Contract {
        let mut c = Contract::new(alice(), alice());
        // Create two goods as the owner.
        testing_env!(ctx(alice(), 0).build());
        c.create_good(
            "stall-1".to_string(),
            "Corner Stall".to_string(),
            "stall".to_string(),
            U128(60),
        );
        c.create_good(
            "relic-1".to_string(),
            "Sun Relic".to_string(),
            "relic".to_string(),
            U128(200),
        );
        c
    }

    #[test]
    fn faucet_once_per_day() {
        let mut c = setup();
        testing_env!(ctx(bob(), DAY_NS).build());
        let bal = c.claim_faucet();
        assert_eq!(bal.0, 500);
        // Second claim same day fails.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.claim_faucet();
        }));
        assert!(r.is_err());
        // Next day works.
        testing_env!(ctx(bob(), 2 * DAY_NS).build());
        let bal = c.claim_faucet();
        assert_eq!(bal.0, 1000);
    }

    #[test]
    fn auction_flow_settles_to_highest_bidder() {
        let mut c = setup();
        // Fund bob and carol.
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(2000));
        c.seed_bankroll(carol(), U128(2000));
        // Owner opens a 3-minute lot for the stall, starting bid 300.
        testing_env!(ctx(alice(), DAY_NS).build());
        let id = c.open_auction("stall-1".to_string(), U128(300), 180);
        assert_eq!(id, 1);
        // Bob bids 300.
        testing_env!(ctx(bob(), DAY_NS + 10_000_000_000).build());
        c.place_bid(id, U128(300));
        assert_eq!(c.balance_of(&bob()), 1700);
        // Carol must beat it by at least 25.
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.place_bid(id, U128(310));
        }));
        assert!(r.is_err());
        testing_env!(ctx(carol(), DAY_NS + 20_000_000_000).build());
        c.place_bid(id, U128(350));
        // Bob is refunded.
        assert_eq!(c.balance_of(&bob()), 2000);
        assert_eq!(c.balance_of(&carol()), 1650);
        // Settle after the end (180s).
        testing_env!(ctx(alice(), DAY_NS + 200_000_000_000).build());
        let winner = c.settle_auction(id);
        assert_eq!(winner, Some(carol()));
        // Seller (alice) received the winning bid; carol owns the good.
        assert_eq!(c.balance_of(&alice()), 350);
        let good = c.get_good("stall-1".to_string()).unwrap();
        assert_eq!(good.owner_id, carol());
        // 5% of 350 minted to the prize pool.
        assert_eq!(c.get_prize_pool().0, 17);
    }

    #[test]
    fn anti_snipe_extends_the_lot() {
        let mut c = setup();
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(2000));
        let id = c.open_auction("stall-1".to_string(), U128(300), 180);
        // Bid 10s before the end.
        testing_env!(ctx(bob(), DAY_NS + 170_000_000_000).build());
        c.place_bid(id, U128(300));
        let a = c.get_auction(id).unwrap();
        // Extended to now + 30s.
        assert_eq!(a.ends_at, DAY_NS + 170_000_000_000 + 30_000_000_000);
    }

    #[test]
    fn income_split_by_shares() {
        let mut c = setup();
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(2000));
        // Bob buys 2 shares in the relic (200/day).
        testing_env!(ctx(bob(), DAY_NS).build());
        c.buy_share("relic-1".to_string());
        c.buy_share("relic-1".to_string());
        // Two days pass from creation (t=0) to claim (t=2 days);
        // accrued 400. Per share 40; bob holds 2 -> 80; alice keeps 320.
        testing_env!(ctx(alice(), 2 * DAY_NS).build());
        let got = c.claim_income("relic-1".to_string());
        assert_eq!(got.0, 320);
        assert_eq!(c.balance_of(&bob()), 2000 - 200 + 80);
    }

    #[test]
    fn fixed_price_sale_and_shares_reset() {
        let mut c = setup();
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(2000));
        c.seed_bankroll(carol(), U128(2000));
        // Bob buys a share, then alice lists the stall at 500, carol buys.
        testing_env!(ctx(bob(), DAY_NS).build());
        c.buy_share("stall-1".to_string());
        testing_env!(ctx(alice(), DAY_NS).build());
        c.list_good("stall-1".to_string(), U128(500));
        testing_env!(ctx(carol(), DAY_NS).build());
        c.buy_good("stall-1".to_string());
        let good = c.get_good("stall-1".to_string()).unwrap();
        assert_eq!(good.owner_id, carol());
        assert_eq!(good.shares_sold, 0);
        // Alice got the 500 sale price plus bob's 100 share payment.
        assert_eq!(c.balance_of(&alice()), 600);
    }

    #[test]
    fn self_transfer_is_a_noop_and_creates_no_coins() {
        // The contract account is alice in this test (she is the
        // owner and the seller), so settlement moves escrow to the
        // seller via a self-transfer for the house.
        let mut c = setup();
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(2000));
        let id = c.open_auction("stall-1".to_string(), U128(300), 180);
        testing_env!(ctx(bob(), DAY_NS + 10_000_000_000).build());
        c.place_bid(id, U128(300));
        testing_env!(ctx(alice(), DAY_NS + 200_000_000_000).build());
        let winner = c.settle_auction(id);
        assert_eq!(winner, Some(bob()));
        // The house (contract account) holds exactly the 300 sale
        // proceeds — not 600. Total supply is unchanged by settlement.
        assert_eq!(c.balance_of(&alice()), 300);
        assert_eq!(c.total_supply, 2000);
        // The one-time correction removes phantom coins, not supply.
        c.correct_balance(alice(), U128(100));
        assert_eq!(c.balance_of(&alice()), 200);
        assert_eq!(c.total_supply, 2000);
    }

    fn dave() -> AccountId {
        accounts(3)
    }

    #[test]
    fn payout_before_season_end_returns_none() {
        let mut c = setup();
        // First call starts season 1 (at DAY_NS) and returns None.
        testing_env!(ctx(alice(), DAY_NS).build());
        assert_eq!(c.payout_prize_pool(), None);
        let info = c.get_season_info();
        assert_eq!(info.season_number, 1);
        assert!(!info.can_payout);
        assert_eq!(info.seconds_remaining, 24 * 60 * 60);
        // Half a day later, still nothing to pay out.
        testing_env!(ctx(alice(), DAY_NS + 12 * 60 * 60 * 1_000_000_000).build());
        assert_eq!(c.payout_prize_pool(), None);
        assert_eq!(c.get_season_info().season_number, 1);
    }

    #[test]
    fn leaderboard_excludes_the_house() {
        let c = setup();
        // Both goods are owned by alice (the house), so nobody is
        // on the leaderboard.
        testing_env!(ctx(alice(), DAY_NS).build());
        assert!(c.get_leaderboard().is_empty());
    }

    #[test]
    fn payout_splits_pool_50_30_20() {
        let mut c = setup();
        // A third good so three different players can own one each.
        testing_env!(ctx(alice(), DAY_NS).build());
        c.create_good(
            "route-1".to_string(),
            "River Route".to_string(),
            "route".to_string(),
            U128(100),
        );
        c.seed_bankroll(bob(), U128(5000));
        c.seed_bankroll(carol(), U128(5000));
        c.seed_bankroll(dave(), U128(5000));
        // Bob buys the stall (60/day) for 1000 -> pool +50.
        testing_env!(ctx(alice(), DAY_NS).build());
        c.list_good("stall-1".to_string(), U128(1000));
        testing_env!(ctx(bob(), DAY_NS).build());
        c.buy_good("stall-1".to_string());
        // Carol buys the relic (200/day) for 2000 -> pool +100.
        testing_env!(ctx(alice(), DAY_NS).build());
        c.list_good("relic-1".to_string(), U128(2000));
        testing_env!(ctx(carol(), DAY_NS).build());
        c.buy_good("relic-1".to_string());
        // Dave buys the route (100/day) for 1000 -> pool +50.
        testing_env!(ctx(alice(), DAY_NS).build());
        c.list_good("route-1".to_string(), U128(1000));
        testing_env!(ctx(dave(), DAY_NS).build());
        c.buy_good("route-1".to_string());
        assert_eq!(c.get_prize_pool().0, 200);
        // Leaderboard: carol 200, dave 100, bob 60.
        let board = c.get_leaderboard();
        assert_eq!(board.len(), 3);
        assert_eq!(board[0].account, carol());
        assert_eq!(board[1].account, dave());
        assert_eq!(board[2].account, bob());
        // Start season 1, then move past its end.
        testing_env!(ctx(alice(), DAY_NS).build());
        assert_eq!(c.payout_prize_pool(), None);
        testing_env!(ctx(alice(), 2 * DAY_NS + 1).build());
        let record = c.payout_prize_pool().expect("payout should happen");
        assert_eq!(record.season_number, 1);
        assert_eq!(record.total_paid.0, 200);
        // Carol 100 (50%), Dave 60 (30%), Bob 40 (20%).
        assert_eq!(
            record.winners[0],
            PayoutWinner {
                account: carol(),
                amount: U128(100)
            }
        );
        assert_eq!(
            record.winners[1],
            PayoutWinner {
                account: dave(),
                amount: U128(60)
            }
        );
        assert_eq!(
            record.winners[2],
            PayoutWinner {
                account: bob(),
                amount: U128(40)
            }
        );
        assert_eq!(c.get_prize_pool().0, 0);
        // Balances: each winner's sale payment is gone, payout added.
        assert_eq!(c.balance_of(&carol()), 5000 - 2000 + 100);
        assert_eq!(c.balance_of(&dave()), 5000 - 1000 + 60);
        assert_eq!(c.balance_of(&bob()), 5000 - 1000 + 40);
        // Season 2 has started; the last payout is recorded.
        let info = c.get_season_info();
        assert_eq!(info.season_number, 2);
        assert_eq!(info.last_payout_season, 1);
        assert!(!info.can_payout);
        assert_eq!(c.get_last_payout().unwrap().season_number, 1);
        // Calling again in season 2 pays nothing.
        assert_eq!(c.payout_prize_pool(), None);
    }

    #[test]
    fn payout_with_two_owners_is_60_40() {
        let mut c = setup();
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(5000));
        c.seed_bankroll(carol(), U128(5000));
        // Bob buys the stall (60/day) for 1000 -> pool +50.
        // Carol buys the relic (200/day) for 1000 -> pool +50.
        c.list_good("stall-1".to_string(), U128(1000));
        testing_env!(ctx(bob(), DAY_NS).build());
        c.buy_good("stall-1".to_string());
        testing_env!(ctx(alice(), DAY_NS).build());
        c.list_good("relic-1".to_string(), U128(1000));
        testing_env!(ctx(carol(), DAY_NS).build());
        c.buy_good("relic-1".to_string());
        assert_eq!(c.get_prize_pool().0, 100);
        testing_env!(ctx(alice(), DAY_NS).build());
        assert_eq!(c.payout_prize_pool(), None);
        testing_env!(ctx(alice(), 2 * DAY_NS + 1).build());
        let record = c.payout_prize_pool().expect("payout should happen");
        // Carol (200/day) first: 60. Bob (60/day) second: 40.
        assert_eq!(
            record.winners[0],
            PayoutWinner {
                account: carol(),
                amount: U128(60)
            }
        );
        assert_eq!(
            record.winners[1],
            PayoutWinner {
                account: bob(),
                amount: U128(40)
            }
        );
        assert_eq!(record.total_paid.0, 100);
    }

    #[test]
    fn payout_with_one_owner_takes_all() {
        let mut c = setup();
        testing_env!(ctx(alice(), DAY_NS).build());
        c.seed_bankroll(bob(), U128(5000));
        c.list_good("stall-1".to_string(), U128(1000));
        testing_env!(ctx(bob(), DAY_NS).build());
        c.buy_good("stall-1".to_string());
        assert_eq!(c.get_prize_pool().0, 50);
        testing_env!(ctx(alice(), DAY_NS).build());
        assert_eq!(c.payout_prize_pool(), None);
        testing_env!(ctx(alice(), 2 * DAY_NS + 1).build());
        let record = c.payout_prize_pool().expect("payout should happen");
        assert_eq!(
            record.winners,
            vec![PayoutWinner {
                account: bob(),
                amount: U128(50)
            }]
        );
        assert_eq!(record.total_paid.0, 50);
        assert_eq!(c.balance_of(&bob()), 5000 - 1000 + 50);
    }

    #[test]
    fn payout_with_no_eligible_owners_rolls_over() {
        let mut c = setup();
        // Nobody but the house owns a good, so the pool stays empty
        // and the season still advances.
        testing_env!(ctx(alice(), DAY_NS).build());
        assert_eq!(c.payout_prize_pool(), None);
        testing_env!(ctx(alice(), 2 * DAY_NS + 1).build());
        let record = c.payout_prize_pool().expect("payout should happen");
        assert_eq!(record.season_number, 1);
        assert!(record.winners.is_empty());
        assert_eq!(record.total_paid.0, 0);
        assert_eq!(c.get_prize_pool().0, 0);
        assert_eq!(c.get_season_info().season_number, 2);
    }
}
