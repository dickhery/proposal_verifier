import Array "mo:base/Array";
import Blob "mo:base/Blob";
import Cycles "mo:base/ExperimentalCycles";
import Error "mo:base/Error";
import Iter "mo:base/Iter";
import Nat "mo:base/Nat";
import Nat64 "mo:base/Nat64";
import Option "mo:base/Option";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import Text "mo:base/Text";
import TrieMap "mo:base/TrieMap";

persistent actor self {

  // -----------------------------
  // Types for HTTPS outcalls
  // -----------------------------
  type HttpHeader = {
    name : Text;
    value : Text;
  };

  type TransformContext = {
    function : {
      principal : Principal;
      method_name : Text;
    };
    context : Blob;
  };

  type HttpRequestArgs = {
    url : Text;
    max_response_bytes : ?Nat64;
    headers : [HttpHeader];
    body : ?Blob;
    method : {
      #get;
      #head;
      #post;
    };
    transform : ?TransformContext;
  };

  type HttpResponsePayload = {
    status : Nat;
    headers : [HttpHeader];
    body : Blob;
  };

  type TransformArgs = {
    response : HttpResponsePayload;
    context : Blob;
  };

  type FetchResult = {
    body : Blob;
    headers : [HttpHeader];
  };

  // -----------------------------
  // NNS governance types (subset)
  // -----------------------------
  module GovernanceTypes {
    public type ProposalId = {
      id : Nat64;
    };

    public type Proposal = {
      url : Text;
      summary : Text;
      title : ?Text;
    };

    public type ProposalInfo = {
      id : ?ProposalId;
      proposal : ?Proposal;
    };
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
    proposalType : Text;
  };

  // -----------------------------
  // External canisters
  // -----------------------------
  // NOTE: Keep these as persistent (non-transient) to preserve the stable layout
  // and avoid M0169 on upgrades.
  let Management = actor ("aaaaa-aa") : actor {
    http_request : (HttpRequestArgs) -> async HttpResponsePayload;
  };

  let NNS_GOVERNANCE : Principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");

  let governance = actor (Principal.toText(NNS_GOVERNANCE)) : actor {
    get_proposal_info : (Nat64) -> async ?GovernanceTypes.ProposalInfo;
  };

  // -----------------------------
  // Helpers
  // -----------------------------
  /// Text slicing helper: returns substring [from, to) (end-exclusive).
  /// Clamps bounds to the text length and handles from >= to → "".
  func textSlice(t : Text, from : Nat, to : Nat) : Text {
    let chars = Text.toArray(t);
    let n = Array.size(chars);
    let start = if (from < n) from else n;
    let finishBase = if (to < n) to else n;
    let finish = if (finishBase > start) finishBase else start;
    let sliced = Array.slice<Char>(chars, start, finish);
    Text.fromIter(sliced);
  };

  // General transform – strips varying headers (e.g., dates, cookies)
  public query func generalTransform(args : TransformArgs) : async HttpResponsePayload {
    let sanitizedHeaders = Array.filter<HttpHeader>(
      args.response.headers,
      func(h : HttpHeader) : Bool {
        let lowerName = Text.toLowercase(h.name);
        not (lowerName == "date" or lowerName == "set-cookie" or lowerName == "etag")
      }
    );
    {
      status = args.response.status;
      headers = sanitizedHeaders;
      body = args.response.body;
    };
  };

  // Custom indexOf implementation (uses textSlice)
  func indexOf(text : Text, pattern : Text) : ?Nat {
    let tSize = Text.size(text);
    let pSize = Text.size(pattern);
    if (pSize == 0 or pSize > tSize) return null;
    label search for (i in Iter.range(0, tSize - pSize)) {
      if (textSlice(text, i, i + pSize) == pattern) return ?i;
    };
    return null;
  };

  // -----------------------------
  // Public API
  // -----------------------------
  public shared func getProposal(id : Nat64) : async Result.Result<SimplifiedProposalInfo, Text> {
    if (id == 0) {
      return #err("Proposal id must be greater than zero");
    };

    try {
      let responseOpt = await governance.get_proposal_info(id);
      switch (responseOpt) {
        case (null) { #err("Proposal not found") };
        case (?info) {
          switch (info.id, info.proposal) {
            case (?pid, ?proposal) {
              // Parse summary for common patterns
              let commitOpt = extractPattern(proposal.summary, "git commit: ", "\n");
              let hashOpt = extractPattern(proposal.summary, "sha256 hash: ", "\n");
              let docUrlOpt = extractPattern(proposal.summary, "document url: ", "\n");
              let repoOpt = extractPattern(proposal.summary, "repository: ", "\n");

              let proposalType =
                if (Text.contains(proposal.summary, #text "IC OS") or Text.contains(proposal.summary, #text "replica")) "IC-OS"
                else if (Text.contains(proposal.summary, #text "Wasm") or Text.contains(proposal.summary, #text "canister upgrade")) "WASM"
                else "Unknown";

              #ok({
                id = pid.id;
                summary = proposal.summary;
                url = proposal.url;
                title = proposal.title;
                extractedCommit = commitOpt;
                extractedHash = hashOpt;
                extractedDocUrl = docUrlOpt;
                extractedRepo = repoOpt;
                proposalType;
              });
            };
            case _ {
              #err("Proposal missing summary data")
            };
          }
        }
      }
    } catch (e) {
      #err("Failed to query governance canister: " # Error.message(e))
    }
  };

  func extractPattern(text : Text, start : Text, end : Text) : ?Text {
    let startPos = indexOf(text, start);
    switch (startPos) {
      case null { null };
      case (?sp) {
        let fromStart = textSlice(text, sp + Text.size(start), Text.size(text));
        let endPos = indexOf(fromStart, end);
        switch (endPos) {
          case null { null };
          case (?ep) {
            let extracted = textSlice(fromStart, 0, ep);
            ?Text.trim(extracted, #char ' ') // Trim surrounding spaces
          };
        }
      }
    }
  };

  public func checkGitCommit(repo : Text, commit : Text) : async Result.Result<Text, Text> {
    if (Text.size(commit) == 0) {
      return #err("Commit hash missing");
    };
    if (Text.size(repo) == 0) {
      return #err("Repository missing");
    };

    let url = "https://api.github.com/repos/" # repo # "/commits/" # commit;

    let request : HttpRequestArgs = {
      url = url;
      method = #get;
      headers = [
        { name = "Accept"; value = "application/vnd.github+json" },
        { name = "User-Agent"; value = "proposal-verifier-canister" },
      ];
      body = null;
      max_response_bytes = ?200_000;
      transform = ?{
        function = {
          principal = Principal.fromActor(self);
          method_name = "generalTransform";
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
        }
      } else {
        #err("GitHub returned status " # Nat.toText(response.status))
      }
    } catch (e) {
      #err("HTTPS outcall failed: " # Error.message(e))
    }
  };

  public func fetchDocument(url : Text) : async Result.Result<FetchResult, Text> {
    let request : HttpRequestArgs = {
      url = url;
      method = #get;
      headers = [{ name = "User-Agent"; value = "proposal-verifier-canister" }];
      body = null;
      max_response_bytes = ?2_000_000; // Limit to 2MB
      transform = ?{
        function = {
          principal = Principal.fromActor(self);
          method_name = "generalTransform";
        };
        context = Blob.fromArray([]);
      };
    };

    Cycles.add<system>(100_000_000_000);

    try {
      let response = await Management.http_request(request);
      if (response.status == 200) {
        #ok({ body = response.body; headers = response.headers })
      } else {
        #err("Fetch failed with status " # Nat.toText(response.status))
      }
    } catch (e) {
      #err("Outcall failed: " # Error.message(e))
    }
  };

  public func verifyArgsHash(args : Text, expectedHash : Text) : async Bool {
    // Placeholder; real compute in frontend
    return Text.equal(args, expectedHash);
  };

  public query func getRebuildScript(proposalType : Text, commit : Text) : async Text {
    switch (proposalType) {
      case ("IC-OS") {
        "sudo apt-get install -y curl && curl --proto '=https' --tlsv1.2 -sSLO https://raw.githubusercontent.com/dfinity/ic/" # commit # "/gitlab-ci/tools/repro-check.sh && chmod +x repro-check.sh && ./repro-check.sh -c " # commit;
      };
      case ("WASM") {
        "git clone https://github.com/dfinity/ic && git checkout " # commit # " && cargo build --release --target wasm32-unknown-unknown && ic-wasm target/wasm32-unknown-unknown/release/<module>.wasm -o verified.wasm metadata candid:service -f <candid.did> -v public && sha256sum verified.wasm";
      };
      case _ {
        "echo 'Determine type and run manual build'";
      };
    }
  };
};
