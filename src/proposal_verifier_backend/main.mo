import Array "mo:base/Array";
import Blob "mo:base/Blob";
import Cycles "mo:base/ExperimentalCycles";
import Error "mo:base/Error";
import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Nat32 "mo:base/Nat32";
import Nat64 "mo:base/Nat64";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import Text "mo:base/Text";
import Char "mo:base/Char";

// Remove 'persistent' as no stable vars; reduces potential overhead
persistent actor self {
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
  type HttpResponsePayload = { status : Nat; headers : [HttpHeader]; body : Blob };
  type TransformArgs = { response : HttpResponsePayload; context : Blob };
  type FetchResult = { body : Blob; headers : [HttpHeader] };

  // -----------------------------
  // NNS governance types (subset)
  // -----------------------------
  module GovernanceTypes {
    public type ProposalId = { id : Nat64 };
    public type Proposal = { url : Text; summary : Text; title : ?Text };
    public type ProposalInfo = { id : ?ProposalId; proposal : ?Proposal };
  };

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
    // NEW
    extractedUrls : [Text];
    commitUrl : ?Text;
  };

  public type AugmentedProposalInfo = {
    base : SimplifiedProposalInfo;
    expectedHashFromDashboard : ?Text;
    payloadSnippetFromDashboard : ?Text;
    expectedHashSource : ?Text;
    dashboardUrl : Text;
  };

  // -----------------------------
  // External canisters
  // -----------------------------
  let Management = actor("aaaaa-aa") : actor {
    http_request : (HttpRequestArgs) -> async HttpResponsePayload;
  };

  let NNS_GOVERNANCE : Principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");
  let governance = actor (Principal.toText(NNS_GOVERNANCE)) : actor {
    get_proposal_info : (Nat64) -> async ?GovernanceTypes.ProposalInfo;
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
    true
  };

  func findFirst40Hex(t : Text) : ?Text {
    let n = Text.size(t);
    for (i in Iter.range(0, if (n >= 40) n - 40 else 0)) {
      let candidate = textSlice(t, i, i + 40);
      if (isHex(candidate) and Text.size(candidate) == 40) return ?candidate;
    };
    null
  };

  func findFirst64Hex(t : Text) : ?Text {
    let n = Text.size(t);
    for (i in Iter.range(0, if (n >= 64) n - 64 else 0)) {
      let candidate = textSlice(t, i, i + 64);
      if (isHex(candidate) and Text.size(candidate) == 64) return ?candidate;
    };
    null
  };

  func find64HexNearMarker(t : Text, marker : Text, window : Nat) : ?Text {
    switch (indexOf(t, marker)) {
      case null { null };
      case (?p) {
        let start = if (p < window/2) 0 else p - (window/2);
        let end = Nat.min(Text.size(t), p + window/2);
        let segment = textSlice(t, start, end);
        findFirst64Hex(segment)
      }
    }
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
                case (?ti, ?ci) { if (ti <= ci) ("tree/", ti) else ("commit/", ci) };
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
    (null, null)
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
        ?("./artifacts/canisters/" # textSlice(summary, from, j))
      };
    }
  };

  // Only call deterministic/text/json providers here
  func isStableDomain(url : Text) : Bool {
    Text.contains(url, #text "https://ic-api.internetcomputer.org/")
    or Text.contains(url, #text "https://api.github.com/")
    or Text.contains(url, #text "https://raw.githubusercontent.com/");
  };

  // -----------------------------
  // URL extraction (NEW)
  // -----------------------------
  func sanitizeUrl(raw : Text) : Text {
    // Remove trailing punctuation and unbalanced ')'
    var s = raw;

    // Helper: is a trailing punctuation we want to trim?
    func isTrimChar(c : Char) : Bool {
      let n = Char.toNat32(c);
      // ) ] } . , ; : ' " `
      n == 41      // ')'
      or n == 93   // ']'
      or n == 125  // '}'
      or n == 46   // '.'
      or n == 44   // ','
      or n == 59   // ';'
      or n == 58   // ':'
      or n == 39   // '\''
      or n == 34   // '"'
      or n == 96;  // '`'
    };

    // Trim trailing punctuation commonly stuck to URLs
    label trim_loop loop {
      if (Text.size(s) == 0) break trim_loop;
      let last = Text.toArray(s)[Text.size(s) - 1];
      if (isTrimChar(last)) {
        s := textSlice(s, 0, Text.size(s) - 1);
      } else break trim_loop;
    };

    // Remove extra closing ')' if more ')' than '('
    func countChar(t : Text, c : Char) : Nat {
      var k : Nat = 0;
      for (ch in t.chars()) { if (ch == c) k += 1 };
      k
    };
    var opens = countChar(s, '(');
    var closes = countChar(s, ')');
    label fix_paren loop {
      if (closes > opens and Text.size(s) > 0 and Text.toArray(s)[Text.size(s) - 1] == ')') {
        s := textSlice(s, 0, Text.size(s) - 1);
        closes -= 1;
      } else break fix_paren;
    };

    s
  };

  func extractAllUrls(t : Text) : [Text] {
    let n = Text.size(t);
    var i : Nat = 0;
    var acc : [Text] = [];
    func isHttpStart(at : Nat) : Bool {
      let max8 = Nat.min(n, at + 8);
      let slice8 = textSlice(t, at, max8);
      Text.contains(slice8, #text "https://") or Text.contains(slice8, #text "http://")
    };
    while (i < n) {
      if (isHttpStart(i)) {
        // start at i, advance until whitespace
        var j = i;
        label adv while (j < n) {
          let ch = Text.toArray(t)[j];
          if (ch == ' ' or ch == '\n' or ch == '\r' or ch == '\t') break adv;
          j += 1;
        };
        let raw = textSlice(t, i, j);
        let clean = sanitizeUrl(raw);
        // Dedup
        var exists = false;
        for (u in acc.vals()) { if (u == clean) { exists := true } };
        if (not exists and Text.size(clean) > 0) {
          acc := Array.append<Text>(acc, [clean]);
        };
        i := j;
      } else {
        i += 1;
      }
    };
    acc
  };

  func chooseDocUrl(urls : [Text]) : ?Text {
    // Prefer dashboard release links, then GitHub/raw links, else first found
    var pick : ?Text = null;
    for (u in urls.vals()) {
      if (Text.contains(Text.toLowercase(u), #text "dashboard.internetcomputer.org/release")) return ?u;
    };
    for (u in urls.vals()) {
      if (Text.contains(u, #text "https://raw.githubusercontent.com/") or Text.contains(u, #text "https://github.com/")) return ?u;
    };
    if (Array.size(urls) > 0) ?urls[0] else null
  };

  // -----------------------------
  // Core getters
  // -----------------------------
  public shared func getProposal(id : Nat64) : async Result.Result<SimplifiedProposalInfo, Text> {
    if (id == 0) return #err("Proposal id must be greater than zero");

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
              let repoFinal = switch (repoFromUrlOpt) { case (?r) ?r; case null null };
              let commitFinal =
                switch (commitFromUrlOpt, commit40Opt) {
                  case (?c, _) ?c;
                  case (null, ?c40) ?c40;
                  case (null, null) null;
                };

              // Build commit URL if we have repo + commit
              let commitUrlOpt : ?Text = switch (repoFinal, commitFinal) {
                case (?r, ?c) ?("https://github.com/" # r # "/commit/" # c);
                case _ null;
              };

              // Enhanced classification by simple keyword scan
              let lowerSummary = Text.toLowercase(summary);
              let proposalType =
                if (Text.contains(lowerSummary, #text "ic os") or Text.contains(lowerSummary, #text "replica") or Text.contains(lowerSummary, #text "guestos")) "IcOsVersionDeployment"
                else if (Text.contains(lowerSummary, #text "wasm") or Text.contains(lowerSummary, #text "canister")) "ProtocolCanisterManagement"
                else if (Text.contains(lowerSummary, #text "motion")) "Governance"
                else if (Text.contains(lowerSummary, #text "node provider")) "ParticipantManagement"
                else if (Text.contains(lowerSummary, #text "subnet")) "SubnetManagement"
                else if (Text.contains(lowerSummary, #text "sns")) "ServiceNervousSystemManagement"
                else if (Text.contains(lowerSummary, #text "application canister")) "ApplicationCanisterManagement"
                else if (Text.contains(lowerSummary, #text "economics")) "NetworkEconomics"
                else "Unknown";

              #ok({
                id = pid.id;
                summary = summary;
                url = proposal.url;
                title = proposal.title;
                extractedCommit = commitFinal;
                extractedHash = sha256Opt;
                extractedDocUrl = docUrlOpt;
                extractedRepo = repoFinal;
                extractedArtifact = artifactOpt;
                proposalType;
                extractedUrls = urls;
                commitUrl = commitUrlOpt;
              })
            };
            case _ { #err("Proposal missing summary data") };
          }
        }
      }
    } catch (e) {
      #err("Failed to query governance canister: " # Error.message(e))
    }
  };

  // Commit existence check (GitHub)
  public func checkGitCommit(repo : Text, commit : Text) : async Result.Result<Text, Text> {
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
      transform = ?{ function = { principal = Principal.fromActor(self); method_name = "generalTransform" }; context = Blob.fromArray([]) };
    };
    Cycles.add<system>(100_000_000_000);
    try {
      let response = await Management.http_request(request);
      if (response.status == 200) {
        switch (Text.decodeUtf8(response.body)) {
          case (?bodyText) { #ok(bodyText) };
          case null { #err("Unable to decode GitHub response") };
        }
      } else { #err("GitHub returned status " # Nat.toText(response.status)) }
    } catch (e) { #err("HTTPS outcall failed: " # Error.message(e)) }
  };

  // Deterministic fetcher (blocked for dynamic domains)
  public func fetchDocument(url : Text) : async Result.Result<FetchResult, Text> {
    if (Text.size(url) == 0) return #err("URL missing");
    if (not isStableDomain(url)) {
      return #err("Domain likely dynamic / non-deterministic for canister outcalls; fetch in browser instead.");
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
      transform = ?{ function = { principal = Principal.fromActor(self); method_name = "generalTransform" }; context = Blob.fromArray([]) };
    };
    Cycles.add<system>(100_000_000_000);
    try {
      let response = await Management.http_request(request);
      if (response.status == 200) { #ok({ body = response.body; headers = response.headers }) }
      else { #err("Fetch failed with status " # Nat.toText(response.status)) }
    } catch (e) { #err("Outcall failed: " # Error.message(e)) }
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
      case ("Governance") { "echo 'Motion proposals do not require rebuild; verify summary manually.'"; };
      case ("ParticipantManagement") { "echo 'NodeProvider: Download self-declaration PDF, compute SHA-256, compare to proposal hash.'\nsha256sum yourfile.pdf"; };
      case _ { "echo 'Determine proposal type, then rebuild/verify accordingly'"; }
    }
  };

  // -----------------------------
  // Dashboard API helpers
  // -----------------------------
  func fetchIcApiProposalJsonText(id : Nat64) : async ?Text {
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
      transform = ?{ function = { principal = Principal.fromActor(self); method_name = "generalTransform" }; context = Blob.fromArray([]) };
    };
    Cycles.add<system>(100_000_000_000);
    try {
      let resp = await Management.http_request(req);
      if (resp.status == 200) {
        switch (Text.decodeUtf8(resp.body)) { case (?t) ?t; case null null };
      } else { null };
    } catch (e) { null };
  };

  func extractExpectedHashFromJsonText(jsonText : Text) : ?Text {
    switch (find64HexNearMarker(jsonText, "\"expected_hash\"", 1200)) {
      case (?h) ?h;
      case null {
        switch (find64HexNearMarker(jsonText, "\"wasm_module_hash\"", 1200)) {
          case (?h2) ?h2;
          case null {
            switch (find64HexNearMarker(jsonText, "\"sha256\"", 1200)) {
              case (?h3) ?h3;
              case null find64HexNearMarker(jsonText, "\"hash\"", 1200);
            }
          }
        }
      }
    }
  };

  func extractPayloadSnippetFromJson(jsonText : Text) : ?Text {
    switch (indexOf(jsonText, "\"payload\"")) {
      case null null;
      case (?p) {
        let end = Nat.min(Text.size(jsonText), p + 1500);
        ?textSlice(jsonText, p, end)
      }
    }
  };

  // Augmented getter that merges base summary info with ic-api JSON
  public shared func getProposalAugmented(id : Nat64) : async Result.Result<AugmentedProposalInfo, Text> {
    switch (await getProposal(id)) {
      case (#err(e)) { #err(e) };
      case (#ok(base)) {
        let dashboardUrl = "https://dashboard.internetcomputer.org/proposal/" # Nat64.toText(id);

        var expected : ?Text = null;
        var snippet  : ?Text = null;
        var source   : ?Text = null;

        let jsonOpt = await fetchIcApiProposalJsonText(id);
        switch (jsonOpt) {
          case (?json) {
            expected := extractExpectedHashFromJsonText(json);
            snippet  := extractPayloadSnippetFromJson(json);
            if (expected != null) { source := ?"ic-api" };
          };
          case null {};
        };

        #ok({
          base;
          expectedHashFromDashboard = expected;
          payloadSnippetFromDashboard = snippet;
          expectedHashSource = source;
          dashboardUrl;
        })
      }
    }
  };

  // Transform: strip ALL headers to avoid consensus diffs
  public query func generalTransform(args : TransformArgs) : async HttpResponsePayload {
    { status = args.response.status; headers = []; body = args.response.body };
  };

  // NEW: Debug query for cycle balance (call from frontend to monitor)
  public query func getCycleBalance() : async Nat {
    Cycles.balance()
  };
}
