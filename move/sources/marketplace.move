/// Corpus — on-chain marketplace for AI datasets stored on Shelby.
///
/// Responsibilities of this module:
///   * Registry of dataset listings. Each listing records WHERE the bytes live on
///     Shelby. Because the Shelby SDK's `upload()` returns no handle and reads are
///     addressed by `(uploader account address, blobName)`, the listing stores
///     exactly that pair: `storage_account` + `blob_name`. That pair is the
///     "storage handle" the backend later feeds to `ShelbyClient.download()`.
///   * Purchase flow: a buyer pays the listing price (APT on shelbynet) to the
///     owner and receives a non-transferable entitlement to that dataset.
///   * View functions the frontend/backend read: list datasets, fetch one,
///     and check whether an address is entitled.
///
/// Safety properties enforced here:
///   * A buyer cannot purchase the same dataset twice (E_ALREADY_PURCHASED).
///   * Only the listing owner can delist (E_NOT_OWNER).
///   * Delisted datasets cannot be purchased (E_DATASET_INACTIVE).
///   * Owners cannot buy their own dataset (E_CANNOT_BUY_OWN) — avoids a no-op
///     self-payment that would still mint an entitlement.
///
/// Coin abstraction: v1 charges in APT via `aptos_account::transfer`. The payment
/// is isolated in `charge_buyer()` so swapping to a different coin / fungible asset
/// is a single-function change. (TODO: parameterize the payment asset for mainnet.)
module corpus::marketplace {
    use std::signer;
    use std::string::String;
    use std::vector;
    use aptos_std::table::{Self, Table};
    use aptos_framework::aptos_account;
    use aptos_framework::event;
    use aptos_framework::timestamp;

    // ---- Errors ----
    /// The marketplace has not been initialized at @corpus.
    const E_NOT_INITIALIZED: u64 = 1;
    /// No dataset exists for the given id.
    const E_DATASET_NOT_FOUND: u64 = 2;
    /// Caller is not the owner of the dataset.
    const E_NOT_OWNER: u64 = 3;
    /// Buyer already owns an entitlement to this dataset.
    const E_ALREADY_PURCHASED: u64 = 4;
    /// Dataset has been delisted and can no longer be purchased.
    const E_DATASET_INACTIVE: u64 = 5;
    /// An owner cannot purchase their own dataset.
    const E_CANNOT_BUY_OWN: u64 = 6;
    /// Price must be greater than zero.
    const E_INVALID_PRICE: u64 = 7;

    // ---- Core resources ----

    /// A single dataset listing. `has store` so it can live inside a Table.
    struct Dataset has store {
        id: u64,
        owner: address,
        title: String,
        description: String,
        /// Shelby account namespace the blob was uploaded under.
        storage_account: address,
        /// Shelby blob name/path under `storage_account`. Together with
        /// `storage_account` this is the full read reference for download().
        blob_name: String,
        /// Listing price in Octas (APT smallest unit).
        price: u64,
        created_at: u64,
        active: bool,
    }

    /// Composite key for the entitlement table: (buyer, dataset_id).
    struct EntitlementKey has copy, drop, store {
        buyer: address,
        dataset_id: u64,
    }

    /// The marketplace singleton, stored at @corpus by `init_module`.
    struct Marketplace has key {
        datasets: Table<u64, Dataset>,
        /// Stable list of all minted ids so views can enumerate without a count gap.
        dataset_ids: vector<u64>,
        /// (buyer, dataset_id) -> true. Presence == entitled.
        entitlements: Table<EntitlementKey, bool>,
        next_id: u64,
    }

    // ---- Events (module events: `#[event]` + `event::emit`) ----
    #[event]
    struct DatasetListedEvent has drop, store {
        id: u64,
        owner: address,
        price: u64,
    }
    #[event]
    struct DatasetPurchasedEvent has drop, store {
        id: u64,
        buyer: address,
        owner: address,
        price: u64,
    }
    #[event]
    struct DatasetDelistedEvent has drop, store {
        id: u64,
        owner: address,
    }

    // ---- Read-only view structs (copyable snapshots returned by views) ----
    struct DatasetView has copy, drop, store {
        id: u64,
        owner: address,
        title: String,
        description: String,
        storage_account: address,
        blob_name: String,
        price: u64,
        created_at: u64,
        active: bool,
    }

    /// Published automatically on `aptos move publish`. Creates the singleton.
    fun init_module(publisher: &signer) {
        move_to(publisher, Marketplace {
            datasets: table::new(),
            dataset_ids: vector::empty<u64>(),
            entitlements: table::new(),
            next_id: 0,
        });
    }

    // ---- Entry functions ----

    /// Register a new dataset listing. The caller becomes the owner. The Shelby
    /// storage handle (`storage_account` + `blob_name`) is recorded as-is; this
    /// module does not verify the blob exists (it can't reach Shelby) — the seed
    /// script / uploader is responsible for uploading before (or alongside) listing.
    public entry fun list_dataset(
        owner: &signer,
        title: String,
        description: String,
        storage_account: address,
        blob_name: String,
        price: u64,
    ) acquires Marketplace {
        assert!(exists<Marketplace>(@corpus), E_NOT_INITIALIZED);
        assert!(price > 0, E_INVALID_PRICE);

        let market = borrow_global_mut<Marketplace>(@corpus);
        let id = market.next_id;
        market.next_id = id + 1;

        let owner_addr = signer::address_of(owner);
        table::add(&mut market.datasets, id, Dataset {
            id,
            owner: owner_addr,
            title,
            description,
            storage_account,
            blob_name,
            price,
            created_at: timestamp::now_seconds(),
            active: true,
        });
        vector::push_back(&mut market.dataset_ids, id);

        event::emit(DatasetListedEvent { id, owner: owner_addr, price });
    }

    /// Purchase a dataset. Transfers `price` APT from buyer to owner and records a
    /// non-transferable entitlement. Reverts if already purchased, inactive, the
    /// buyer is the owner, or the dataset doesn't exist.
    public entry fun purchase(buyer: &signer, dataset_id: u64) acquires Marketplace {
        assert!(exists<Marketplace>(@corpus), E_NOT_INITIALIZED);
        let buyer_addr = signer::address_of(buyer);

        let market = borrow_global_mut<Marketplace>(@corpus);
        assert!(table::contains(&market.datasets, dataset_id), E_DATASET_NOT_FOUND);

        // Read the bits we need, then drop the borrow before transferring funds.
        let (owner, price, active) = {
            let ds = table::borrow(&market.datasets, dataset_id);
            (ds.owner, ds.price, ds.active)
        };
        assert!(active, E_DATASET_INACTIVE);
        assert!(buyer_addr != owner, E_CANNOT_BUY_OWN);

        let key = EntitlementKey { buyer: buyer_addr, dataset_id };
        assert!(!table::contains(&market.entitlements, key), E_ALREADY_PURCHASED);

        // Record entitlement BEFORE moving funds so the state mutation and the
        // (reverting-on-failure) transfer are committed atomically by the VM.
        table::add(&mut market.entitlements, key, true);

        charge_buyer(buyer, owner, price);

        event::emit(DatasetPurchasedEvent {
            id: dataset_id, buyer: buyer_addr, owner, price,
        });
    }

    /// Delist a dataset so it can no longer be purchased. Owner-only. Existing
    /// entitlements are unaffected (buyers keep access to what they bought).
    public entry fun delist(owner: &signer, dataset_id: u64) acquires Marketplace {
        assert!(exists<Marketplace>(@corpus), E_NOT_INITIALIZED);
        let market = borrow_global_mut<Marketplace>(@corpus);
        assert!(table::contains(&market.datasets, dataset_id), E_DATASET_NOT_FOUND);

        let owner_addr = signer::address_of(owner);
        let ds = table::borrow_mut(&mut market.datasets, dataset_id);
        assert!(ds.owner == owner_addr, E_NOT_OWNER);
        ds.active = false;

        event::emit(DatasetDelistedEvent { id: dataset_id, owner: owner_addr });
    }

    /// The single point where payment happens — swap the asset here to change
    /// the marketplace currency. v1: APT via aptos_account (auto-registers payee).
    fun charge_buyer(buyer: &signer, owner: address, price: u64) {
        aptos_account::transfer(buyer, owner, price);
    }

    // ---- View functions ----

    #[view]
    /// True if `buyer` holds an entitlement to `dataset_id`. The backend gate
    /// calls this before serving a download. Fails closed (returns false) when
    /// the marketplace isn't initialized.
    public fun is_entitled(buyer: address, dataset_id: u64): bool acquires Marketplace {
        if (!exists<Marketplace>(@corpus)) return false;
        let market = borrow_global<Marketplace>(@corpus);
        table::contains(&market.entitlements, EntitlementKey { buyer, dataset_id })
    }

    #[view]
    /// Number of datasets ever listed (including delisted).
    public fun datasets_count(): u64 acquires Marketplace {
        if (!exists<Marketplace>(@corpus)) return 0;
        borrow_global<Marketplace>(@corpus).next_id
    }

    #[view]
    /// All listing ids (including delisted ones; check `active` per-dataset).
    public fun get_dataset_ids(): vector<u64> acquires Marketplace {
        if (!exists<Marketplace>(@corpus)) return vector::empty<u64>();
        borrow_global<Marketplace>(@corpus).dataset_ids
    }

    #[view]
    /// Full metadata for one dataset. Aborts if not found.
    public fun get_dataset(dataset_id: u64): DatasetView acquires Marketplace {
        assert!(exists<Marketplace>(@corpus), E_NOT_INITIALIZED);
        let market = borrow_global<Marketplace>(@corpus);
        assert!(table::contains(&market.datasets, dataset_id), E_DATASET_NOT_FOUND);
        to_view(table::borrow(&market.datasets, dataset_id))
    }

    #[view]
    /// Every dataset as a copyable snapshot — convenient single call for the UI.
    public fun list_datasets(): vector<DatasetView> acquires Marketplace {
        let out = vector::empty<DatasetView>();
        if (!exists<Marketplace>(@corpus)) return out;
        let market = borrow_global<Marketplace>(@corpus);
        let ids = &market.dataset_ids;
        let i = 0;
        let n = vector::length(ids);
        while (i < n) {
            let id = *vector::borrow(ids, i);
            vector::push_back(&mut out, to_view(table::borrow(&market.datasets, id)));
            i = i + 1;
        };
        out
    }

    fun to_view(ds: &Dataset): DatasetView {
        DatasetView {
            id: ds.id,
            owner: ds.owner,
            title: ds.title,
            description: ds.description,
            storage_account: ds.storage_account,
            blob_name: ds.blob_name,
            price: ds.price,
            created_at: ds.created_at,
            active: ds.active,
        }
    }

    // ---- Tests ----
    #[test_only]
    use std::string;
    #[test_only]
    use aptos_framework::account;
    #[test_only]
    use aptos_framework::aptos_coin::{Self, AptosCoin};
    #[test_only]
    use aptos_framework::coin;

    #[test_only]
    fun setup_for_test(aptos_framework: &signer, corpus_signer: &signer) {
        timestamp::set_time_has_started_for_testing(aptos_framework);
        init_module(corpus_signer);
    }

    #[test_only]
    /// Mint `amount` APT to `who` so purchase() has funds to move.
    fun fund(aptos_framework: &signer, who: address, amount: u64) {
        let (burn, mint) = aptos_coin::initialize_for_test(aptos_framework);
        coin::register<AptosCoin>(&account::create_signer_for_test(who));
        aptos_coin::mint(aptos_framework, who, amount);
        coin::destroy_burn_cap(burn);
        coin::destroy_mint_cap(mint);
    }

    #[test(aptos_framework = @aptos_framework, corpus = @corpus, seller = @0xA11CE, buyer = @0xB0B)]
    fun test_list_purchase_entitlement(
        aptos_framework: &signer, corpus: &signer, seller: &signer, buyer: &signer,
    ) acquires Marketplace {
        setup_for_test(aptos_framework, corpus);
        let seller_addr = signer::address_of(seller);
        let buyer_addr = signer::address_of(buyer);
        account::create_account_for_test(seller_addr);
        account::create_account_for_test(buyer_addr);
        fund(aptos_framework, buyer_addr, 1000);

        list_dataset(
            seller,
            string::utf8(b"Sample"),
            string::utf8(b"A tiny dataset"),
            seller_addr,
            string::utf8(b"corpus/sample.jsonl"),
            100,
        );

        assert!(!is_entitled(buyer_addr, 0), 100);
        purchase(buyer, 0);
        assert!(is_entitled(buyer_addr, 0), 101);
        assert!(coin::balance<AptosCoin>(seller_addr) == 100, 102);
        assert!(coin::balance<AptosCoin>(buyer_addr) == 900, 103);
    }

    #[test(aptos_framework = @aptos_framework, corpus = @corpus, seller = @0xA11CE, buyer = @0xB0B)]
    #[expected_failure(abort_code = E_ALREADY_PURCHASED)]
    fun test_no_double_purchase(
        aptos_framework: &signer, corpus: &signer, seller: &signer, buyer: &signer,
    ) acquires Marketplace {
        setup_for_test(aptos_framework, corpus);
        let seller_addr = signer::address_of(seller);
        let buyer_addr = signer::address_of(buyer);
        account::create_account_for_test(seller_addr);
        account::create_account_for_test(buyer_addr);
        fund(aptos_framework, buyer_addr, 1000);
        list_dataset(seller, string::utf8(b"S"), string::utf8(b"d"), seller_addr, string::utf8(b"b"), 100);
        purchase(buyer, 0);
        purchase(buyer, 0); // aborts
    }

    #[test(aptos_framework = @aptos_framework, corpus = @corpus, seller = @0xA11CE)]
    #[expected_failure(abort_code = E_CANNOT_BUY_OWN)]
    fun test_cannot_buy_own(
        aptos_framework: &signer, corpus: &signer, seller: &signer,
    ) acquires Marketplace {
        setup_for_test(aptos_framework, corpus);
        let seller_addr = signer::address_of(seller);
        account::create_account_for_test(seller_addr);
        fund(aptos_framework, seller_addr, 1000);
        list_dataset(seller, string::utf8(b"S"), string::utf8(b"d"), seller_addr, string::utf8(b"b"), 100);
        purchase(seller, 0); // aborts
    }

    #[test(aptos_framework = @aptos_framework, corpus = @corpus, seller = @0xA11CE, buyer = @0xB0B)]
    #[expected_failure(abort_code = E_DATASET_INACTIVE)]
    fun test_cannot_buy_delisted(
        aptos_framework: &signer, corpus: &signer, seller: &signer, buyer: &signer,
    ) acquires Marketplace {
        setup_for_test(aptos_framework, corpus);
        let seller_addr = signer::address_of(seller);
        let buyer_addr = signer::address_of(buyer);
        account::create_account_for_test(seller_addr);
        account::create_account_for_test(buyer_addr);
        fund(aptos_framework, buyer_addr, 1000);
        list_dataset(seller, string::utf8(b"S"), string::utf8(b"d"), seller_addr, string::utf8(b"b"), 100);
        delist(seller, 0);
        purchase(buyer, 0); // aborts
    }

    #[test(aptos_framework = @aptos_framework, corpus = @corpus, seller = @0xA11CE, attacker = @0xBAD)]
    #[expected_failure(abort_code = E_NOT_OWNER)]
    fun test_only_owner_delists(
        aptos_framework: &signer, corpus: &signer, seller: &signer, attacker: &signer,
    ) acquires Marketplace {
        setup_for_test(aptos_framework, corpus);
        let seller_addr = signer::address_of(seller);
        account::create_account_for_test(seller_addr);
        list_dataset(seller, string::utf8(b"S"), string::utf8(b"d"), seller_addr, string::utf8(b"b"), 100);
        delist(attacker, 0); // aborts
    }
}
