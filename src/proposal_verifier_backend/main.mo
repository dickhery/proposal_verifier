import Blob "mo:base/Blob";
import Cycles "mo:base/ExperimentalCycles";
import Error "mo:base/Error";
import Nat64 "mo:base/Nat64";
import Principal "mo:base/Principal";
import Result "mo:base/Result";
import Text "mo:base/Text";
import TrieMap "mo:base/TrieMap";

import IC "mo:ic";
// If you want them later, keep these (correct) imports.
// import Candid "mo:candid";
// import JSON "mo:json";

persistent actor {

  let Management = actor ("aaaaa-aa") : actor {
  http_request : (IC.HttpRequestArgs) -> async IC.HttpResponsePayload;
};

  transient let NNS_GOVERNANCE : Principal = Principal.fromText("rrkah-fqaaa-aaaaa-aaaaq-cai");

  type ProposalInfo = {
    id : Nat64;
    summary : Text;
  };

  // Placeholder for now so the canister deploys cleanly.
  // TODO: Replace with a typed actor interface to NNS governance or a Candid-based dynamic call.
  public query func getProposal(id : Nat64) : async Result.Result<ProposalInfo, Text> {
    #err("getProposal not implemented yet — add NNS governance interface or Candid call.")
  };

  // HTTPS outcall to GitHub API to check a commit; returns raw body text for now.
public func checkGitCommit(repo : Text, commit : Text) : async Result.Result<Text, Text> {
  let url = "https://api.github.com/repos/" # repo # "/commits/" # commit;

  // Build a typed request (IC.HttpRequestArgs).
  let request : IC.HttpRequestArgs = {
    url = url;
    method = #get;
    headers = [];                 // e.g., you can add a User-Agent if needed
    body = null;
    max_response_bytes = ?200_000;
    transform = null;             // optional
  };

  // Attach cycles (tune as needed).
  Cycles.add<system>(100_000_000_000);

  try {
    // Call the management canister’s http_request method.
    let response : IC.HttpResponsePayload = await Management.http_request(request);

    switch (Text.decodeUtf8(response.body)) {
      case (?t) { #ok(t) };
      case null { #err("No body") };
    };
  } catch (e) {
    #err(Error.message(e))
  };
}


  // Temporary args "hash" check — replace with real SHA-256 + hex later.
  public func verifyArgsHash(args : Text, expectedHash : Text) : async Bool {
    // TODO: implement cryptographic hash check (e.g., SHA-256) and compare hex.
    return args == expectedHash;
  };

  public query func getRebuildScript(proposalType : Text, commit : Text) : async Text {
    switch (proposalType) {
      case ("IC-OS") {
        "git clone https://github.com/dfinity/ic && git checkout " # commit
        # " && ./gitlab-ci/tools/repro-check.sh -c " # commit
      };
      case _ { "echo 'Run local build commands here'" };
    }
  };
};
