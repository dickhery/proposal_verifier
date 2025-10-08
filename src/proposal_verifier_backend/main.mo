import Array "mo:base/Array";
import Blob "mo:base/Blob";
import Cycles "mo:base/ExperimentalCycles";
import Error "mo:base/Error";
import Nat "mo:base/Nat";
import Nat64 "mo:base/Nat64";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import Text "mo:base/Text";

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
  };

  // -----------------------------
  // External canisters
  // -----------------------------
  let Management = actor ("aaaaa-aa") : actor {
    http_request : (HttpRequestArgs) -> async HttpResponsePayload;
  };

  let NNS_GOVERNANCE : Principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");

  let governance = actor (Principal.toText(NNS_GOVERNANCE)) : actor {
    get_proposal_info : (Nat64) -> async ?GovernanceTypes.ProposalInfo;
  };

  // GitHub HTTP transform – strips disallowed headers and leaves body untouched.
  public query func githubTransform(args : TransformArgs) : async HttpResponsePayload {
    let sanitizedHeaders = Array.filter<HttpHeader>(
      args.response.headers,
      func(h : HttpHeader) : Bool {
        switch (h.name) {
          case ("set-cookie") { false };
          case ("Set-Cookie") { false };
          case _ { true };
        }
      }
    );

    {
      status = args.response.status;
      headers = sanitizedHeaders;
      body = args.response.body;
    };
  };

  // -----------------------------
  // Public API
  // -----------------------------

  public query func getProposal(id : Nat64) : async Result.Result<SimplifiedProposalInfo, Text> {
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
              #ok({
                id = pid.id;
                summary = proposal.summary;
                url = proposal.url;
                title = proposal.title;
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

  public func checkGitCommit(repo : Text, commit : Text) : async Result.Result<Text, Text> {
    if (Text.size(commit) == 0) {
      return #err("Commit hash missing from proposal summary");
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
          method_name = "githubTransform";
        };
        context = Blob.fromArray([]);
      };
    };

    // 100B cycles covers most GitHub responses; adjust if responses exceed limit.
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

  public func verifyArgsHash(args : Text, expectedHash : Text) : async Bool {
    // Placeholder: front-end performs actual SHA-256 comparison.
    return args == expectedHash;
  };

  public query func getRebuildScript(proposalType : Text, commit : Text) : async Text {
    switch (proposalType) {
      case ("IC-OS") {
        "git clone https://github.com/dfinity/ic && git checkout " # commit
        # " && ./gitlab-ci/tools/repro-check.sh -c " # commit;
      };
      case _ {
        "echo 'Run local build commands here'";
      };
    }
  };
};
