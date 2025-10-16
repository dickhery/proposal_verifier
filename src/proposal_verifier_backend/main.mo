import Array "mo:base/Array";
import Blob "mo:base/Blob";
import Cycles "mo:base/ExperimentalCycles";
import Error "mo:base/Error";
import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Nat8 "mo:base/Nat8";
import Nat32 "mo:base/Nat32";
import Nat64 "mo:base/Nat64";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import Text "mo:base/Text";
import Char "mo:base/Char";
import Buffer "mo:base/Buffer";
import Time "mo:base/Time";
import Int32 "mo:base/Int32";
import Debug "mo:base/Debug";

persistent actor verifier {

  // -----------------------------
  // Types for HTTPS outcalls
  // -----------------------------
  type HttpHeader = { name : Text; value : Text };
  type TransformContext = {
    function : { principal : Principal; method_name : Text };
    context : Blob;
  };
  type HttpRequestArgs = {
    url : Text;
    max_response_bytes : ?Nat64;
    headers : [HttpHeader];
    body : ?Blob;
    method : { #get; #head; #post };
    transform : ?TransformContext;
  };
  type HttpResponsePayload = {
    status : Nat;
    headers : [HttpHeader];
    body : Blob;
  };
  type TransformArgs = { response : HttpResponsePayload; context : Blob };
  type FetchResult = { body : Blob; headers : [HttpHeader] };

  // -----------------------------
  // NNS governance types (expanded subset)
  // -----------------------------
  module GovernanceTypes {
    public type ProposalId = { id : Nat64 };

    // InstallCode as returned inside Proposal.action (hashes, not full bytes)
    public type InstallCode = {
      skip_stopping_before_installing : ?Bool;
      wasm_module_hash : ?[Nat8];
      canister_id : ?Principal;
      arg_hash : ?[Nat8];
      install_mode : ?Int32;
    };

    public type Action = {
      #InstallCode : InstallCode;
      // NOTE: Other action variants omitted; add as needed.
    };

    public type Proposal = {
      url : Text;
      summary : Text;
      title : ?Text;
      action : ?Action;
    };

    public type ProposalInfo = { id : ?ProposalId; proposal : ?Proposal };
  };

  // -----------------------------
  // Public DTOs
  // -----------------------------
  type SimplifiedProposalInfo = {
    id : Nat64;
    summary : Text;
    url : Text;
    title : ?Text;
    extractedCommit : ?Text;
    extractedHash : ?Text;
    extractedDocUrl : ?Text;
    extractedRepo : ?Text;
    extractedArtifact : ?Text;
    proposalType : Text;
    extractedUrls : [Text];
    commitUrl : ?Text;
    extractedDocs : [{ name : Text; hash : ?Text }];

    // Expose on-chain hashes from Proposal.action.InstallCode (if present)
    proposal_arg_hash : ?Text;
    proposal_wasm_hash : ?Text;
  };

  type AugmentedProposalInfo = {
    base : SimplifiedProposalInfo;
    expectedHashFromDashboard : ?Text;
    payloadSnippetFromDashboard : ?Text;
    expectedHashSource : ?Text;
    dashboardUrl : Text;

    // Separate arg_hash from dashboard/api
    argHashFromDashboard : ?Text;

    // Potential Candid arg text extracted from dashboard payload snippet
    extractedArgText : ?Text;

    // Type-specific text blocks for the frontend
    verificationSteps : ?Text;
    requiredTools : ?Text;
  };

  // -----------------------------
  // External canisters
  // -----------------------------
  let Management = actor ("aaaaa-aa") : actor {
    http_request : (HttpRequestArgs) -> async HttpResponsePayload;
  };

  // ICP Ledger (ICRC-1) — used for trustless deposit balance checks
  let ICP_LEDGER = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai") : actor {
    icrc1_balance_of : query ({ owner : Principal; subaccount : ?[Nat8] }) -> async Nat;
  };

  // Legacy Ledger types & interface (Account Identifier + from_subaccount transfer)
  module Ledger {
    public type Tokens = { e8s : Nat64 };
    public type AccountIdentifier = [Nat8];
    public type Subaccount = [Nat8];
    public type Memo = Nat64;
    public type TimeStamp = { timestamp_nanos : Nat64 };
    public type TransferArgs = {
      to : AccountIdentifier;
      fee : Tokens;
      memo : Memo;
      from_subaccount : ?Subaccount;
      created_at_time : ?TimeStamp;
      amount : Tokens;
    };
    public type TransferError = {
      #BadFee : { expected_fee : Tokens };
      #InsufficientFunds : { balance : Tokens };
      #TxTooOld : { allowed_window_nanos : Nat64 };
      // payload-less per spec
      #TxCreatedInFuture;
      #TxDuplicate : { duplicate_of : Nat64 };
    };
    public type TransferResult = { #Ok : Nat64; #Err : TransferError };
  };

  let LEDGER_LEGACY = actor ("ryjl3-tyaaa-aaaaa-aaaba-cai") : actor {
    transfer : (Ledger.TransferArgs) -> async Ledger.TransferResult;
  };

  let NNS_GOVERNANCE : Principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  let governance = actor (Principal.toText(NNS_GOVERNANCE)) : actor {
    get_proposal_info : (Nat64) -> async ?GovernanceTypes.ProposalInfo;
  };

  // -----------------------------
  // Billing & access control
  // -----------------------------

  // Anonymous principal
  let ANON : Principal = Principal.fromText("2vxsx-fae");

  // **** FEES (now 0.1 ICP each) ****
  let FEE_FETCH_PROPOSAL_E8S : Nat64 = 10_000_000; // 0.1 ICP
  let FEE_HTTP_OUTCALL_E8S : Nat64 = 10_000_000; // 0.1 ICP per HTTP outcall

  // ICP transfer fee (e8s) for legacy ledger transfer
  let TRANSFER_FEE_E8S : Nat64 = 10_000; // 0.0001 ICP

  // Very small, persistent balance map (Principal -> e8s).
  // Simple array-based storage to keep stability trivial.
  var balances : [(Principal, Nat64)] = [];

  // --- tiny cache for deposit memos ---
  type DepositCacheEntry = {
    memo : Nat64;
    amount_e8s : Nat64;
    timestamp : Time.Time;
  };
  stable var depositCache : [DepositCacheEntry] = [];
  let DEPOSIT_CACHE_MAX : Nat = 128;

  func cacheGet(memo : Nat64) : ?DepositCacheEntry {
    for (e in depositCache.vals()) {
      if (e.memo == memo) return ?e;
    };
    null;
  };

  func cacheUpsert(entry : DepositCacheEntry) {
    // Replace existing (by memo) or append
    var found = false;
    let buf = Buffer.Buffer<DepositCacheEntry>(Array.size(depositCache));
    for (e in depositCache.vals()) {
      if (e.memo == entry.memo) {
        buf.add(entry);
        found := true;
      } else {
        buf.add(e);
      };
    };
    if (not found) { buf.add(entry) };

    var arr = Buffer.toArray(buf);

    // Trim to max size by dropping the oldest timestamp
    if (Array.size(arr) > DEPOSIT_CACHE_MAX) {
      // find index of minimum timestamp
      var minIdx : Nat = 0;
      var minTs : Time.Time = arr[0].timestamp;
      var i : Nat = 1;
      while (i < Array.size(arr)) {
        if (arr[i].timestamp < minTs) {
          minTs := arr[i].timestamp;
          minIdx := i;
        };
        i += 1;
      };
      let buf2 = Buffer.Buffer<DepositCacheEntry>(Array.size(arr) - 1);
      var j : Nat = 0;
      while (j < Array.size(arr)) {
        if (j != minIdx) { buf2.add(arr[j]) };
        j += 1;
      };
      arr := Buffer.toArray(buf2);
    };

    depositCache := arr;
  };

  // ---- NEW: track how much on-chain balance we've already credited per user ----
  stable var creditedByUser : [(Principal, Nat64)] = [];

  func getCredited(p : Principal) : Nat64 {
    for (pair in creditedByUser.vals()) { if (pair.0 == p) return pair.1 };
    0;
  };

  func setCredited(p : Principal, v : Nat64) {
    let buf = Buffer.Buffer<(Principal, Nat64)>(Array.size(creditedByUser));
    var found = false;
    for (pair in creditedByUser.vals()) {
      if (pair.0 == p) { buf.add((p, v)); found := true } else { buf.add(pair) };
    };
    if (not found) { buf.add((p, v)) };
    creditedByUser := Buffer.toArray(buf);
  };

  // Beneficiary Account Identifier (32 bytes) where fees are forwarded
  func hexToBytes(h : Text) : [Nat8] {
    let s = Text.toLowercase(Text.trim(h, #char ' '));
    let n = Text.size(s);
    assert (n % 2 == 0);
    let out = Buffer.Buffer<Nat8>(n / 2);
    var i : Nat = 0;
    let arr = Text.toArray(s);
    func hexVal(c : Char) : Nat8 {
      let u = Nat32.toNat(Char.toNat32(c));
      if (u >= 48 and u <= 57) { Nat8.fromNat(u - 48) } // 0-9
      else if (u >= 97 and u <= 102) { Nat8.fromNat(10 + u - 97) } // a-f
      else if (u >= 65 and u <= 70) { Nat8.fromNat(10 + u - 65) } // A-F (defensive)
      else { 0 };
    };
    while (i < n) {
      let a = arr[i];
      let b = arr[i + 1];
      let byte : Nat8 = Nat8.fromNat(Nat8.toNat(hexVal(a)) * 16 + Nat8.toNat(hexVal(b)));
      out.add(byte);
      i += 2;
    };
    Buffer.toArray(out);
  };

  let BENEFICIARY_ACCOUNT_HEX : Text = "2ec3dee16236d389ebdff4346bc47d5faf31db393dac788e6a6ab5e10ade144e";
  let BENEFICIARY_ACCOUNT_ID : [Nat8] = hexToBytes(BENEFICIARY_ACCOUNT_HEX);

  // ICP transfer from the caller's subaccount to the beneficiary
  func forwardFeeToBeneficiary(fromSub : [Nat8], fee_e8s : Nat64) : async Result.Result<(), Text> {
    let args : Ledger.TransferArgs = {
      to = BENEFICIARY_ACCOUNT_ID;
      fee = { e8s = TRANSFER_FEE_E8S };
      memo = 0;
      from_subaccount = ?fromSub;
      created_at_time = null;
      amount = { e8s = fee_e8s };
    };
    try {
      let r = await LEDGER_LEGACY.transfer(args);
      switch (r) {
        case (#Ok(_)) { #ok(()) };
        case (#Err(e)) {
          let msg = switch e {
            case (#BadFee({ expected_fee })) {
              "BadFee (expected " # Nat64.toText(expected_fee.e8s) # " e8s)";
            };
            case (#InsufficientFunds({ balance })) {
              "InsufficientFunds (balance " # Nat64.toText(balance.e8s) # " e8s)";
            };
            case (#TxTooOld({ allowed_window_nanos })) {
              "TxTooOld (" # Nat64.toText(allowed_window_nanos) # " ns)";
            };
            case (#TxCreatedInFuture) { "TxCreatedInFuture" };
            case (#TxDuplicate({ duplicate_of })) {
              "TxDuplicate (block " # Nat64.toText(duplicate_of) # ")";
            };
          };
          #err("Ledger transfer failed: " # msg);
        };
      };
    } catch (e) {
      #err("Ledger transfer call failed: " # Error.message(e));
    };
  };

  func getBalanceInternal(p : Principal) : Nat64 {
    for (pair in balances.vals()) {
      if (pair.0 == p) return pair.1;
    };
    0;
  };

  func setBalanceInternal(p : Principal, newBal : Nat64) {
    let buf = Buffer.Buffer<(Principal, Nat64)>(Array.size(balances));
    var found = false;
    for (pair in balances.vals()) {
      if (pair.0 == p) {
        buf.add((p, newBal));
        found := true;
      } else {
        buf.add(pair);
      };
    };
    if (not found) { buf.add((p, newBal)) };
    balances := Buffer.toArray(buf);
  };

  func addBalanceInternal(p : Principal, delta : Nat64) {
    setBalanceInternal(p, getBalanceInternal(p) + delta);
  };

  func requireAuth(caller : Principal) : Result.Result<(), Text> {
    if (caller == ANON) {
      #err("Authentication required (use Internet Identity).");
    } else { #ok(()) };
  };

  func saturatingSubNat64(a : Nat64, b : Nat64) : Nat64 {
    if (a <= b) {
      0;
    } else {
      Nat64.fromNat(Nat64.toNat(a) - Nat64.toNat(b));
    };
  };

  // Derive a deterministic 32-byte subaccount from the caller principal.
  func principalToSubaccount(p : Principal) : [Nat8] {
    let src = Blob.toArray(Principal.toBlob(p));
    let out = Array.init<Nat8>(32, 0);
    let m = Nat.min(32, Array.size(src));
    var i : Nat = 0;
    while (i < m) { out[i] := src[i]; i += 1 };
    Array.freeze(out);
  };

  // charge + forward (subtracts fee + transfer fee on success)
func chargeAndForward(caller : Principal, fee_e8s : Nat64, purpose : Text) : async Result.Result<(), Text> {
  let owner = Principal.fromActor(verifier);
  let sub = principalToSubaccount(caller);

  // Query live balance on the user's deposit subaccount (owner = this canister)
  let ledgerBalNat = await ICP_LEDGER.icrc1_balance_of({
    owner = owner;
    subaccount = ?sub;
  });

  let totalNeeded : Nat64 = fee_e8s + TRANSFER_FEE_E8S;

  if (ledgerBalNat < Nat64.toNat(totalNeeded)) {
    return #err(
      "Insufficient balance for " # purpose #
      ". On-chain subaccount has " # Nat.toText(ledgerBalNat) # " e8s, need " # Nat64.toText(totalNeeded) # " e8s (incl. network fee)."
    );
  };

  // NEW: actually deduct the fee from the user's subaccount and forward it
  switch (await forwardFeeToBeneficiary(sub, fee_e8s)) {
    case (#ok(())) {
      let totalDebited : Nat64 = fee_e8s + TRANSFER_FEE_E8S;

      let prevCredited = getCredited(caller);
      let newCredited = saturatingSubNat64(prevCredited, totalDebited);
      setCredited(caller, newCredited);

      let prevInternal = getBalanceInternal(caller);
      let newInternal = saturatingSubNat64(prevInternal, totalDebited);
      setBalanceInternal(caller, newInternal);

      #ok(());
    };
    case (#err(msg)) { #err("Unable to collect fee for " # purpose # ": " # msg) };
  };
};


  // Public helpers for the UI:
  // - where to deposit (owner = this canister principal, subaccount = user-specific)
  public query ({ caller }) func getDepositAccount() : async {
    owner : Principal;
    subaccount : [Nat8];
  } {
    {
      owner = Principal.fromActor(verifier);
      subaccount = principalToSubaccount(caller);
    };
  };

  // -------- NEW: Auto-credit based on on-chain subaccount balance (no amount field) --------
  public shared ({ caller }) func recordDepositAuto() : async Result.Result<{ credited_delta_e8s : Nat64; total_internal_balance_e8s : Nat64; ledger_balance_e8s : Nat; credited_total_e8s : Nat64 }, Text> {
    switch (requireAuth(caller)) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    let owner = Principal.fromActor(verifier);
    let sub = principalToSubaccount(caller);

    try {
      let balNat : Nat = await ICP_LEDGER.icrc1_balance_of({
        owner = owner;
        subaccount = ?sub;
      });
      let prevCredited : Nat64 = getCredited(caller);

      if (balNat <= Nat64.toNat(prevCredited)) {
        return #err("No new deposits detected on your subaccount.");
      };

      let deltaNat : Nat = balNat - Nat64.toNat(prevCredited);
      let delta64 : Nat64 = Nat64.fromNat(deltaNat);

      // Credit the delta internally and advance the credited marker
      addBalanceInternal(caller, delta64);
      setCredited(caller, prevCredited + delta64);

      #ok({
        credited_delta_e8s = delta64;
        total_internal_balance_e8s = getBalanceInternal(caller);
        ledger_balance_e8s = balNat;
        credited_total_e8s = prevCredited + delta64;
      });
    } catch (e) {
      #err("Ledger query failed: " # Error.message(e));
    };
  };

  // -------- NEW: Deposit status helper for UI --------
  public shared ({ caller }) func getDepositStatus() : async {
    owner : Principal;
    subaccount : [Nat8];
    ledger_balance_e8s : Nat;
    credited_total_e8s : Nat64;
    available_to_credit_e8s : Nat;
  } {
    let owner = Principal.fromActor(verifier);
    let sub = principalToSubaccount(caller);

    var ledgerBal : Nat = 0;
    // best-effort; if query fails, leave 0
    try {
      ledgerBal := await ICP_LEDGER.icrc1_balance_of({
        owner = owner;
        subaccount = ?sub;
      });
    } catch (e) {};

    let credited = getCredited(caller);
    let available : Nat = if (ledgerBal > Nat64.toNat(credited)) {
      ledgerBal - Nat64.toNat(credited);
    } else { 0 };

    {
      owner = owner;
      subaccount = sub;
      ledger_balance_e8s = ledgerBal;
      credited_total_e8s = credited;
      available_to_credit_e8s = available;
    };
  };

  // Trustless credit of balance after a user transfers ICP to the above account.
  // Verifies the (owner, subaccount) balance on the ICP ICRC-1 ledger.
  // (Kept for backward compatibility; now also advances the credited marker)
  public shared ({ caller }) func recordDeposit(amount_e8s : Nat64, memo : ?Nat64) : async Result.Result<Nat64, Text> {
    switch (requireAuth(caller)) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    // Check the subaccount balance on the ICP ledger
    let owner = Principal.fromActor(verifier);
    let sub = principalToSubaccount(caller);

    try {
      let balNat : Nat = await ICP_LEDGER.icrc1_balance_of({
        owner = owner;
        subaccount = ?sub;
      });

      // Require at least (amount + transfer fee) present to cover the first billed action margin.
      let needed : Nat = Nat64.toNat(amount_e8s + TRANSFER_FEE_E8S);
      if (balNat < needed) {
        return #err(
          "Insufficient ledger balance on your deposit subaccount. " #
          "Have " # Nat.toText(balNat) # " e8s, need at least " # Nat.toText(needed) # " e8s (incl. fee margin)."
        );
      };

      // Prevent rapid double-claims with the same memo (best-effort)
      let now : Time.Time = Time.now();
      let memoKey : Nat64 = switch (memo) { case (?m) m; case null 0 };
      switch (cacheGet(memoKey)) {
        case (?prev) {
          if (now - prev.timestamp < 60_000_000_000) {
            // 60 seconds in ns
            return #err("Recent deposit claim with the same memo detected. Please wait ~1 minute and try again.");
          };
        };
        case null {};
      };
      cacheUpsert({ memo = memoKey; amount_e8s = amount_e8s; timestamp = now });

      addBalanceInternal(caller, amount_e8s);
      // NEW: also advance the credited marker so auto-credit uses deltas correctly
      let prev = getCredited(caller);
      setCredited(caller, prev + amount_e8s);

      #ok(getBalanceInternal(caller));
    } catch (e) {
      #err("Ledger query failed: " # Error.message(e));
    };
  };

  public shared ({ caller }) func getBalance() : async Nat64 {
    let owner = Principal.fromActor(verifier);
    let sub = principalToSubaccount(caller);
    try {
      let balNat : Nat = await ICP_LEDGER.icrc1_balance_of({
        owner = owner;
        subaccount = ?sub;
      });
      Nat64.fromNat(balNat);
    } catch (e) {
      0;
    };
  };

  public query func getFees() : async {
    fetchProposal_e8s : Nat64;
    httpOutcall_e8s : Nat64;
  } {
    {
      fetchProposal_e8s = FEE_FETCH_PROPOSAL_E8S;
      httpOutcall_e8s = FEE_HTTP_OUTCALL_E8S;
    };
  };

  // -----------------------------
  // Hex helpers
  // -----------------------------
  func hexDigit(n : Nat8) : Text {
    switch (n) {
      case (0) "0";
      case (1) "1";
      case (2) "2";
      case (3) "3";
      case (4) "4";
      case (5) "5";
      case (6) "6";
      case (7) "7";
      case (8) "8";
      case (9) "9";
      case (10) "a";
      case (11) "b";
      case (12) "c";
      case (13) "d";
      case (14) "e";
      case (15) "f";
      case (_) "";
    };
  };

  func bytesToHex(v : [Nat8]) : Text {
    var out = "";
    for (b in v.vals()) {
      let hi = b / 16;
      let lo = b % 16;
      out #= hexDigit(hi) # hexDigit(lo);
    };
    out;
  };

  // -----------------------------
  // Text helpers
  // -----------------------------
  func textSlice(t : Text, from : Nat, to : Nat) : Text {
    let chars = Text.toArray(t);
    let n = Array.size(chars);
    let start = if (from < n) from else n;
    let finishBase = if (to < n) to else n;
    let finish = if (finishBase > start) finishBase else start;
    Text.fromIter(Array.slice<Char>(chars, start, finish));
  };

  func indexOf(text : Text, pattern : Text) : ?Nat {
    let tSize = Text.size(text);
    let pSize = Text.size(pattern);
    if (pSize == 0 or pSize > tSize) return null;
    label search for (i in Iter.range(0, tSize - pSize)) {
      if (textSlice(text, i, i + pSize) == pattern) return ?i;
    };
    return null;
  };

  func isHex(s : Text) : Bool {
    for (ch in s.chars()) {
      let c = Char.toNat32(ch);
      let isDigit = (c >= 48 and c <= 57);
      let isLower = (c >= 97 and c <= 102);
      let isUpper = (c >= 65 and c <= 70);
      if (not (isDigit or isLower or isUpper)) return false;
    };
    true;
  };

  func findFirst40Hex(t : Text) : ?Text {
    let n = Text.size(t);
    for (i in Iter.range(0, if (n >= 40) n - 40 else 0)) {
      let candidate = textSlice(t, i, i + 40);
      if (isHex(candidate) and Text.size(candidate) == 40) return ?candidate;
    };
    null;
  };

  func findFirst64Hex(t : Text) : ?Text {
    let n = Text.size(t);
    for (i in Iter.range(0, if (n >= 64) n - 64 else 0)) {
      let candidate = textSlice(t, i, i + 64);
      if (isHex(candidate) and Text.size(candidate) == 64) return ?candidate;
    };
    null;
  };

  func find64HexNearMarker(t : Text, marker : Text, window : Nat) : ?Text {
    switch (indexOf(t, marker)) {
      case null { null };
      case (?p) {
        let start = if (p < window / 2) 0 else p - (window / 2);
        let end = Nat.min(Text.size(t), p + window / 2);
        let segment = textSlice(t, start, end);
        findFirst64Hex(segment);
      };
    };
  };

  func extractHexFromTextAroundMarkers(t : Text, markers : [Text], window : Nat) : ?Text {
    for (m in markers.vals()) {
      switch (find64HexNearMarker(t, m, window)) {
        case (?h) { return ?h };
        case null {};
      };
    };
    null;
  };

  // Extract GitHub repo+commit if it appears in the summary
  func extractGithubRepoAndCommit(summary : Text) : (?Text, ?Text) {
    let marker = "https://github.com/";
    var posOpt = indexOf(summary, marker);
    label scan while (switch (posOpt) { case null { false }; case (?_) { true } }) {
      let pos = switch (posOpt) { case (?p) p; case null 0 };
      let sl = textSlice(summary, pos + Text.size(marker), Nat.min(Text.size(summary), pos + 200));
      let idxSlash = indexOf(sl, "/");
      switch (idxSlash) {
        case (?s1) {
          let owner = textSlice(sl, 0, s1);
          let rest = textSlice(sl, s1 + 1, Text.size(sl));
          let idxSlash2 = indexOf(rest, "/");
          switch (idxSlash2) {
            case (?s2) {
              let repo = textSlice(rest, 0, s2);
              let afterRepo = textSlice(rest, s2 + 1, Text.size(rest)); // tree|commit/...
              let treeIdx = indexOf(afterRepo, "tree/");
              let commitIdx = indexOf(afterRepo, "commit/");
              let picked = switch (treeIdx, commitIdx) {
                case (?ti, null) { ("tree/", ti) };
                case (null, ?ci) { ("commit/", ci) };
                case (?ti, ?ci) {
                  if (ti <= ci) ("tree/", ti) else ("commit/", ci);
                };
                case (null, null) { ("", 0) };
              };
              if (picked.0 != "") {
                let afterKind = textSlice(afterRepo, picked.1 + Text.size(picked.0), Text.size(afterRepo));
                var j : Nat = 0;
                let m = Text.size(afterKind);
                label walk while (j < m) {
                  let ch = Text.toArray(afterKind)[j];
                  let c = Nat32.toNat(Char.toNat32(ch));
                  let isSep = (c == 47 or c == 63 or c == 35 or c == 41 or c == 32); // / ? # ) space
                  if (isSep) break walk;
                  j += 1;
                };
                let sha = textSlice(afterKind, 0, j);
                if (Text.size(sha) >= 7 and Text.size(sha) <= 40) {
                  return (?(owner # "/" # repo), ?sha);
                };
              };
            };
            case null {};
          };
        };
        case null {};
      };
      posOpt := switch (indexOf(textSlice(summary, pos + 1, Text.size(summary)), "https://github.com/")) {
        case null null;
        case (?nx) ?(nx + pos + 1);
      };
    };
    (null, null);
  };

  // Artifact hint in summaries produced by CI
  func extractArtifactPath(summary : Text) : ?Text {
    let needle = "sha256sum ./artifacts/canisters/";
    switch (indexOf(summary, needle)) {
      case null null;
      case (?p) {
        let from = p + Text.size(needle);
        var j = from;
        let n = Text.size(summary);
        label walk while (j < n) {
          let ch = Text.toArray(summary)[j];
          if (ch == ' ' or ch == '\n' or ch == '\r' or ch == '`') break walk;
          j += 1;
        };
        ?("./artifacts/canisters/" # textSlice(summary, from, j));
      };
    };
  };

  // Extract bullet documents lines like "* Name: hash"
  func extractDocuments(summary : Text) : [{ name : Text; hash : ?Text }] {
    let lines = Array.filter<Text>(
      Iter.toArray(Text.split(summary, #char '\n')),
      func(l) { Text.startsWith(l, #text "* ") },
    );
    let docs = Array.init<{ name : Text; hash : ?Text }>(Array.size(lines), { name = ""; hash = null });
    var idx = 0;
    for (line in lines.vals()) {
      let trimmed = Text.trimStart(line, #char '*');
      let colonIdx = indexOf(trimmed, ":");
      switch (colonIdx) {
        case (?c) {
          let name = Text.trim(textSlice(trimmed, 0, c), #char ' ');
          let after = Text.trim(textSlice(trimmed, c + 1, Text.size(trimmed)), #char ' ');
          if (isHex(after) and Text.size(after) == 64) {
            let hashOpt = ?after;
            docs[idx] := { name; hash = hashOpt };
            idx += 1;
          };
        };
        case null {};
      };
    };
    Array.subArray(Array.freeze(docs), 0, idx);
  };

  // Only call deterministic/text/json providers here
  func isStableDomain(url : Text) : Bool {
    Text.contains(url, #text "https://ic-api.internetcomputer.org/") or Text.contains(url, #text "https://api.github.com/") or Text.contains(url, #text "https://raw.githubusercontent.com/");
  };

  // -----------------------------
  // URL extraction utilities
  // -----------------------------
  func sanitizeUrl(raw : Text) : Text {
    var s = raw;

    func isTrimChar(c : Char) : Bool {
      let n = Char.toNat32(c);
      // ) ] } . , ; : ' " `
      n == 41 or n == 93 or n == 125 or n == 46 or n == 44 or n == 59 or n == 58 or n == 39 or n == 34 or n == 96;
    };

    // Trim trailing punctuation commonly stuck to URLs
    label trim_loop loop {
      if (Text.size(s) == 0) break trim_loop;
      let last = Text.toArray(s)[Text.size(s) - 1];
      if (isTrimChar(last)) {
        s := textSlice(s, 0, Text.size(s) - 1);
      } else { break trim_loop };
    };

    // Remove extra closing ')' if more ')' than '('
    func countChar(t : Text, c : Char) : Nat {
      var k : Nat = 0;
      for (ch in t.chars()) { if (ch == c) k += 1 };
      k;
    };
    var opens = countChar(s, '(');
    var closes = countChar(s, ')');
    label fix_paren loop {
      if (closes > opens and Text.size(s) > 0 and Text.toArray(s)[Text.size(s) - 1] == ')') {
        s := textSlice(s, 0, Text.size(s) - 1);
        closes -= 1;
      } else break fix_paren;
    };

    s;
  };

  func extractAllUrls(t : Text) : [Text] {
    let n = Text.size(t);
    var i : Nat = 0;
    var acc : [Text] = [];
    func isHttpStart(at : Nat) : Bool {
      let max8 = Nat.min(n, at + 8);
      let slice8 = textSlice(t, at, max8);
      Text.contains(slice8, #text "https://") or Text.contains(slice8, #text "http://");
    };
    while (i < n) {
      if (isHttpStart(i)) {
        var j = i;
        label adv while (j < n) {
          let ch = Text.toArray(t)[j];
          if (ch == ' ' or ch == '\n' or ch == '\r' or ch == '\t') break adv;
          j += 1;
        };
        let raw = textSlice(t, i, j);
        let clean = sanitizeUrl(raw);
        var exists = false;
        for (u in acc.vals()) { if (u == clean) { exists := true } };
        if (not exists and Text.size(clean) > 0) {
          acc := Array.append<Text>(acc, [clean]);
        };
        i := j;
      } else { i += 1 };
    };
    acc;
  };

  func chooseDocUrl(urls : [Text]) : ?Text {
    // Prefer dashboard release links, then GitHub/raw links, else first found
    for (u in urls.vals()) {
      if (Text.contains(Text.toLowercase(u), #text "dashboard.internetcomputer.org/release")) return ?u;
    };
    for (u in urls.vals()) {
      if (Text.contains(u, #text "https://raw.githubusercontent.com/") or Text.contains(u, #text "https://github.com/")) return ?u;
    };
    if (Array.size(urls) > 0) ?urls[0] else null;
  };

  // -----------------------------
  // Type-specific text for UI
  // -----------------------------
  func getVerificationSteps(proposalType : Text) : ?Text {
    switch (proposalType) {
      case ("ProtocolCanisterManagement") {
        ?(
          "1. Identify action (InstallCode / UpdateCanisterSettings / Stop/Start).\n" #
          "2. Extract repo & commit from the summary; confirm commit exists.\n" #
          "3. Rebuild canister(s):\n" #
          " git clone https://github.com/dfinity/ic && cd ic && git checkout COMMIT && ./ci/container/build-ic.sh -c\n" #
          "4. Compute hashes: sha256sum ./artifacts/canisters/*.wasm{,.gz}\n" #
          "5. Compare to on-chain wasm hash and dashboard expected hash (if any).\n" #
          "6. Args: encode with didc, hash bytes, and compare to arg_hash.\n" #
          "7. Review forum/context links as needed."
        );
      };
      case ("ServiceNervousSystemManagement") {
        ?(
          "1. Identify SNS action (e.g., AddSnsWasm / Upgrade).\n" #
          "2. Locate SNS repo/commit; rebuild per repo README.\n" #
          "3. Compute SHA-256 of produced WASM and compare to proposal.\n" #
          "4. For parameter changes, review payload fields."
        );
      };
      case ("ApplicationCanisterManagement") {
        ?(
          "1. Identify target app canister (e.g., ledger, II, ckBTC).\n" #
          "2. Use the indicated repo (IC or app-specific) and commit.\n" #
          "3. Build the module and sha256sum the output.\n" #
          "4. Compare to expected/wasm hash; verify args if present."
        );
      };
      case ("IcOsVersionElection") {
        ?(
          "1. Confirm GuestOS/HostOS versions and associated commit.\n" #
          "2. Use IC repro-check to reproduce artifacts.\n" #
          "3. Compare computed hashes to those referenced by the proposal."
        );
      };
      case ("IcOsVersionDeployment") {
        ?(
          "1. Confirm IC-OS release identifiers (GuestOS/HostOS).\n" #
          "2. Download the release package from the dashboard release link.\n" #
          "3. sha256sum the package; compare to release_package_sha256_hex.\n" #
          "4. Cross-check targeted subnets/nodes if applicable."
        );
      };
      case ("Governance") {
        ?(
          "1. Motion / governance-text only: no binaries to rebuild.\n" #
          "2. Read the summary and linked discussion carefully.\n" #
          "3. Validate intent and scope match the title and context."
        );
      };
      case ("SnsAndCommunityFund") {
        ?(
          "1. Review CreateServiceNervousSystem payload parameters.\n" #
          "2. Verify initial distribution, swap params, Neurons’ Fund usage.\n" #
          "3. Check referenced docs and hashes if provided."
        );
      };
      case ("NetworkEconomics") {
        ?(
          "1. Inspect parameter/table changes (e.g., NodeRewardsTable).\n" #
          "2. Compare against prior values and rationale.\n" #
          "3. No binaries: manual policy review."
        );
      };
      case ("SubnetManagement") {
        ?(
          "1. Identify action (CreateSubnet / AddNode / UpdateConfig, etc.).\n" #
          "2. Verify principal IDs, node/provider IDs, and config diffs.\n" #
          "3. For firewall/registry changes, review fields and effects."
        );
      };
      case ("ParticipantManagement") {
        ?(
          "1. Identify node provider / data center update.\n" #
          "2. Download referenced PDFs from wiki/dashboard.\n" #
          "3. sha256sum the PDFs; compare to hashes in the proposal.\n" #
          "4. Sanity-check provider and forum introduction."
        );
      };
      case ("NodeAdmin") {
        ?(
          "1. Confirm node operator config/allowance changes.\n" #
          "2. Verify IDs and expected subnet allocations."
        );
      };
      case ("KYC") {
        ?(
          "1. ApproveGenesisKYC: verify principals match intended list.\n" #
          "2. No hashes: manual identity/eligibility review."
        );
      };
      case ("NeuronManagement") {
        ?(
          "1. ManageNeuron: verify target neuron and permissions.\n" #
          "2. Manual check of intent and timing."
        );
      };
      case _ { null };
    };
  };

  func getRequiredTools(proposalType : Text) : ?Text {
    switch (proposalType) {
      case ("ProtocolCanisterManagement") {
        ?"git, Docker (for builds), sha256sum, didc (for Candid args)";
      };
      case ("IcOsVersionDeployment") {
        ?"curl, git, sha256sum, Docker (for repro-check)";
      };
      case ("ParticipantManagement") { ?"Browser (wiki/forum), sha256sum" };
      case _ { null };
    };
  };

  // -----------------------------
  // Core getters (authenticated + billed)
  // -----------------------------
  public shared ({ caller }) func getProposal(id : Nat64) : async Result.Result<SimplifiedProposalInfo, Text> {
    if (id == 0) return #err("Proposal id must be greater than zero");
    switch (requireAuth(caller)) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    // bill + forward fee before work (single charge)
    switch (await chargeAndForward(caller, FEE_FETCH_PROPOSAL_E8S, "fetch proposal")) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    try {
      let responseOpt = await governance.get_proposal_info(id);
      switch (responseOpt) {
        case null { #err("Proposal not found") };
        case (?info) {
          switch (info.id, info.proposal) {
            case (?pid, ?proposal) {
              let summary = proposal.summary;

              let (repoFromUrlOpt, commitFromUrlOpt) = extractGithubRepoAndCommit(summary);
              let commit40Opt = findFirst40Hex(summary);
              let sha256Opt = findFirst64Hex(summary);

              // Robust URL extraction from summary
              let urls = extractAllUrls(summary);
              let docUrlOpt = chooseDocUrl(urls);

              let artifactOpt = extractArtifactPath(summary);
              let repoFinal = switch (repoFromUrlOpt) {
                case (?r) ?r;
                case null null;
              };
              let commitFinal = switch (commitFromUrlOpt, commit40Opt) {
                case (?c, _) ?c;
                case (null, ?c40) ?c40;
                case (null, null) null;
              };

              // Build commit URL if we have repo + commit
              let commitUrlOpt : ?Text = switch (repoFinal, commitFinal) {
                case (?r, ?c) ?("https://github.com/" # r # "/commit/" # c);
                case _ null;
              };

              // Simple type classification
              let lowerSummary = Text.toLowercase(summary);
              let proposalType = if (Text.contains(lowerSummary, #text "ic os") or Text.contains(lowerSummary, #text "replica") or Text.contains(lowerSummary, #text "guestos")) "IcOsVersionDeployment" else if (Text.contains(lowerSummary, #text "wasm") or Text.contains(lowerSummary, #text "canister")) "ProtocolCanisterManagement" else if (Text.contains(lowerSummary, #text "motion")) "Governance" else if (Text.contains(lowerSummary, #text "node provider")) "ParticipantManagement" else if (Text.contains(lowerSummary, #text "subnet")) "SubnetManagement" else if (Text.contains(lowerSummary, #text "sns")) "ServiceNervousSystemManagement" else if (Text.contains(lowerSummary, #text "application canister")) "ApplicationCanisterManagement" else if (Text.contains(lowerSummary, #text "economics")) "NetworkEconomics" else "Unknown";

              // Extract bullet docs
              let extractedDocs = extractDocuments(summary);

              // For ParticipantManagement, default wiki if not present
              let finalDocUrl = switch (proposalType) {
                case ("ParticipantManagement") {
                  if (docUrlOpt == null) ?"https://wiki.internetcomputer.org/wiki/" else docUrlOpt;
                };
                case _ docUrlOpt;
              };

              // Surface on-chain hashes if action is InstallCode (hash vectors -> hex)
              var proposal_arg_hash : ?Text = null;
              var proposal_wasm_hash : ?Text = null;
              switch (proposal.action) {
                case (?#InstallCode(ic)) {
                  switch (ic.arg_hash) {
                    case (?v) { proposal_arg_hash := ?bytesToHex(v) };
                    case null {};
                  };
                  switch (ic.wasm_module_hash) {
                    case (?v) { proposal_wasm_hash := ?bytesToHex(v) };
                    case null {};
                  };
                };
                case _ {};
              };

              #ok({
                id = pid.id;
                summary = summary;
                url = proposal.url;
                title = proposal.title;
                extractedCommit = commitFinal;
                extractedHash = sha256Opt;
                extractedDocUrl = finalDocUrl;
                extractedRepo = repoFinal;
                extractedArtifact = artifactOpt;
                proposalType;
                extractedUrls = urls;
                commitUrl = commitUrlOpt;
                extractedDocs;
                proposal_arg_hash;
                proposal_wasm_hash;
              });
            };
            case _ { #err("Proposal missing summary data") };
          };
        };
      };
    } catch (e) {
      #err("Failed to query governance canister: " # Error.message(e));
    };
  };

  // Commit existence check (GitHub) - only if repo/commit present
  public shared ({ caller }) func checkGitCommit(repo : Text, commit : Text) : async Result.Result<Text, Text> {
    switch (requireAuth(caller)) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    // bill + forward
    switch (await chargeAndForward(caller, FEE_HTTP_OUTCALL_E8S, "GitHub commit check")) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    if (Text.size(commit) == 0) return #err("Commit hash missing");
    if (Text.size(repo) == 0) return #err("Repository missing");

    let url = "https://api.github.com/repos/" # repo # "/commits/" # commit;
    let request : HttpRequestArgs = {
      url = url;
      method = #get;
      headers = [
        { name = "Accept"; value = "application/vnd.github.v3+json" },
        { name = "User-Agent"; value = "proposal-verifier-canister" },
        { name = "X-GitHub-Api-Version"; value = "2022-11-28" },
        { name = "Accept-Encoding"; value = "identity" },
        { name = "Cache-Control"; value = "no-cache" },
        { name = "Pragma"; value = "no-cache" },
      ];
      body = null;
      max_response_bytes = ?1_000_000;
      transform = ?{
        function = {
          principal = Principal.fromActor(verifier);
          method_name = "githubTransform";
        };
        context = Blob.fromArray([]);
      };
    };
    Cycles.add<system>(100_000_000_000);
    try {
      let response = await Management.http_request(request);
      if (response.status == 200) {
        switch (Text.decodeUtf8(response.body)) {
          case (?bodyText) { #ok(bodyText) };
          case null { #err("Unable to decode GitHub response") };
        };
      } else { #err("GitHub returned status " # Nat.toText(response.status)) };
    } catch (e) { #err("HTTPS outcall failed: " # Error.message(e)) };
  };

  // Deterministic fetcher (blocked for dynamic domains)
  public shared ({ caller }) func fetchDocument(url : Text) : async Result.Result<FetchResult, Text> {
    switch (requireAuth(caller)) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };
    if (Text.size(url) == 0) return #err("URL missing");
    if (not isStableDomain(url)) {
      return #err("Domain likely dynamic / non-deterministic for canister outcalls; fetch in browser instead.");
    };

    // bill + forward
    switch (await chargeAndForward(caller, FEE_HTTP_OUTCALL_E8S, "fetch document")) {
      case (#err(e)) return #err(e);
      case (#ok(())) {};
    };

    let request : HttpRequestArgs = {
      url = url;
      method = #get;
      headers = [
        { name = "User-Agent"; value = "proposal-verifier-canister" },
        { name = "Accept-Encoding"; value = "identity" },
      ];
      body = null;
      max_response_bytes = ?2_000_000;
      transform = ?{
        function = {
          principal = Principal.fromActor(verifier);
          method_name = "generalTransform";
        };
        context = Blob.fromArray([]);
      };
    };
    Cycles.add<system>(100_000_000_000);
    try {
      let response = await Management.http_request(request);
      if (response.status == 200) {
        #ok({ body = response.body; headers = response.headers });
      } else { #err("Fetch failed with status " # Nat.toText(response.status)) };
    } catch (e) { #err("Outcall failed: " # Error.message(e)) };
  };

  // Placeholder – client computes SHA-256; this keeps the candid stable
  public func verifyArgsHash(args : Text, expectedHash : Text) : async Bool {
    return Text.equal(args, expectedHash);
  };

  public query func getRebuildScript(proposalType : Text, commit : Text) : async Text {
    switch (proposalType) {
      case ("IcOsVersionDeployment") {
        "sudo apt-get update && sudo apt-get install -y curl git docker.io\n" #
        "curl --proto '=https' --tlsv1.2 -sSLO https://raw.githubusercontent.com/dfinity/ic/" # commit # "/gitlab-ci/tools/repro-check.sh\n" #
        "chmod +x repro-check.sh\n" #
        "./repro-check.sh -c " # commit # "\n";
      };
      case ("ProtocolCanisterManagement") {
        let hint = "If you used ./ci/container/build-ic.sh -c, the artifact is under ./artifacts/canisters/...";
        "git clone https://github.com/dfinity/ic\n" #
        "cd ic\n" #
        "git fetch --all\n" #
        "git checkout " # commit # "\n" #
        "./ci/container/build-ic.sh -c\n" #
        "# Fingerprint the built module (replace with exact path if different):\n" #
        "sha256sum ./artifacts/canisters/*.wasm{,.gz}\n" #
        "# " # hint # "\n";
      };
      case ("Governance") {
        "echo 'Motion proposals do not require rebuild; verify summary manually.'";
      };
      case ("ParticipantManagement") {
        "echo 'NodeProvider: Download self-declaration PDFs from wiki, compute SHA-256, compare to proposal hashes.'\n# Example:\nsha256sum yourfile.pdf";
      };
      case _ {
        "echo 'Determine proposal type, then rebuild/verify accordingly'";
      };
    };
  };

  // -----------------------------
  // Dashboard API helpers (no extra billing here to avoid double charge)
  // -----------------------------
  func fetchIcApiProposalJsonText(id : Nat64, caller : Principal) : async ?Text {
    // (bill once in getProposal; do NOT bill again here)

    let url = "https://ic-api.internetcomputer.org/api/v3/proposals/" # Nat64.toText(id);
    let req : HttpRequestArgs = {
      url = url;
      method = #get;
      headers = [
        { name = "Accept"; value = "application/json" },
        { name = "User-Agent"; value = "proposal-verifier-canister" },
        { name = "Accept-Encoding"; value = "identity" },
      ];
      body = null;
      max_response_bytes = ?2_000_000;
      transform = ?{
        function = {
          principal = Principal.fromActor(verifier);
          method_name = "generalTransform";
        };
        context = Blob.fromArray([]);
      };
    };
    Cycles.add<system>(100_000_000_000);
    try {
      let resp = await Management.http_request(req);
      if (resp.status == 200) {
        switch (Text.decodeUtf8(resp.body)) { case (?t) ?t; case null null };
      } else { null };
    } catch (e) { null };
  };

  // Prefer WASM hash, fall back to other common markers
  func extractExpectedHashFromJsonText(jsonText : Text) : ?Text {
    extractHexFromTextAroundMarkers(
      jsonText,
      // order matters
      ["wasm_module_hash", "\"wasm_module_hash\"", "expected_hash", "\"expected_hash\"", "release_package_sha256_hex", "\"release_package_sha256_hex\"", "sha256", "\"sha256\"", "hash", "\"hash\""],
      1200,
    );
  };

  // Separate arg_hash from dashboard/api
  func extractArgHashFromJsonText(jsonText : Text) : ?Text {
    extractHexFromTextAroundMarkers(
      jsonText,
      ["arg_hash", "\"arg_hash\""],
      1200,
    );
  };

  func extractPayloadSnippetFromJson(jsonText : Text) : ?Text {
    switch (indexOf(jsonText, "\"payload\"")) {
      case null null;
      case (?p) {
        let end = Nat.min(Text.size(jsonText), p + 1500);
        ?textSlice(jsonText, p, end);
      };
    };
  };

  // -------- Extract likely Candid arg text from a payload snippet -------
  func findBalancedFromBrace(t : Text, bracePos : Nat) : ?Text {
    let arr = Text.toArray(t);
    let n = Array.size(arr);
    if (bracePos >= n or arr[bracePos] != '{') return null;
    var depth : Nat = 0;
    var i = bracePos;
    label scan while (i < n) {
      let ch = arr[i];
      if (ch == '{') { depth += 1 };
      if (ch == '}') {
        if (depth == 0) { return null } else { depth -= 1 };
        if (depth == 0) {
          return ?textSlice(t, bracePos, i + 1);
        };
      };
      i += 1;
    };
    null;
  };

  func findBraceAfter(t : Text, from : Nat) : ?Nat {
    let n = Text.size(t);
    var i = from;
    let arr = Text.toArray(t);
    while (i < n) {
      if (arr[i] == '{') return ?i;
      i += 1;
    };
    null;
  };

  func extractArgText(snippet : Text) : ?Text {
    let lowers = Text.toLowercase(snippet);
    let candidates = ["record {", "variant {", "vec {", "opt {"];

    // Prefer after an "arg" marker, if present
    var startHint : Nat = 0;
    let argMarkers = ["arg =", "arg=", "arg :", "arg:", "\"arg\""];
    label findArg for (m in argMarkers.vals()) {
      switch (indexOf(lowers, m)) {
        case (?p) { startHint := p + Text.size(m); break findArg };
        case null {};
      };
    };

    func searchFrom(base : Nat) : ?Text {
      for (c in candidates.vals()) {
        switch (indexOf(textSlice(lowers, base, Text.size(lowers)), c)) {
          case (?rel) {
            let abs = base + rel;
            switch (findBraceAfter(lowers, abs)) {
              case (?bpos) {
                switch (findBalancedFromBrace(snippet, bpos)) {
                  case (?block) { return ?block };
                  case null {};
                };
              };
              case null {};
            };
          };
          case null {};
        };
      };
      null;
    };

    switch (searchFrom(startHint)) {
      case (?t) ?t;
      case null searchFrom(0);
    };
  };

  // Augmented getter that merges base summary info with ic-api JSON
  public shared ({ caller }) func getProposalAugmented(id : Nat64) : async Result.Result<AugmentedProposalInfo, Text> {
    switch (await getProposal(id)) {
      case (#err(e)) { #err(e) };
      case (#ok(base)) {
        let dashboardUrl = "https://dashboard.internetcomputer.org/proposal/" # Nat64.toText(id);

        var expected : ?Text = null;
        var argHash : ?Text = null;
        var snippet : ?Text = null;
        var source : ?Text = null;
        var extractedArg : ?Text = null;

        let jsonOpt = await fetchIcApiProposalJsonText(id, caller);
        switch (jsonOpt) {
          case (?json) {
            expected := extractExpectedHashFromJsonText(json);
            argHash := extractArgHashFromJsonText(json);
            snippet := extractPayloadSnippetFromJson(json);
            switch (snippet) {
              case (?s) { extractedArg := extractArgText(s) };
              case null {};
            };
            if (expected != null) { source := ?"ic-api" };
          };
          case null {};
        };

        // Type-specific helper text
        let steps = getVerificationSteps(base.proposalType);
        let tools = getRequiredTools(base.proposalType);

        #ok({
          base;
          expectedHashFromDashboard = expected;
          payloadSnippetFromDashboard = snippet;
          expectedHashSource = source;
          dashboardUrl;
          argHashFromDashboard = argHash;
          extractedArgText = extractedArg;
          verificationSteps = steps;
          requiredTools = tools;
        });
      };
    };
  };

  // -----------------------------
  // Transforms
  // -----------------------------
  public query func generalTransform(args : TransformArgs) : async HttpResponsePayload {
    { status = args.response.status; headers = []; body = args.response.body };
  };

  public query func githubTransform(args : TransformArgs) : async HttpResponsePayload {
    { status = args.response.status; headers = []; body = args.response.body };
  };

  // -----------------------------
  // Debug
  // -----------------------------
  public query func getCycleBalance() : async Nat {
    Cycles.balance();
  };
};
