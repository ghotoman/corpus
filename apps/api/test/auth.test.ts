import assert from "node:assert/strict";
import { test } from "node:test";
import { Account } from "@aptos-labs/ts-sdk";
import {
  CHALLENGE_STATEMENT,
  ChallengeStore,
  challengeMessage,
  type Proof,
} from "../src/auth.js";

function proofFor(store: ChallengeStore, account: Account): Proof {
  const address = account.accountAddress.toString();
  const { nonce } = store.issue(address);
  const signature = account.sign(challengeMessage(nonce));
  return {
    address,
    publicKey: account.publicKey.toString(),
    nonce,
    signature: signature.toString(),
  };
}

test("valid proof returns the normalized address", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const verified = store.verify(proofFor(store, account));
  assert.equal(verified, account.accountAddress.toStringLong());
});

test("replay of a consumed challenge is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const proof = proofFor(store, account);
  store.verify(proof); // first use ok
  assert.throws(() => store.verify(proof), /unknown or used challenge/);
});

test("a different key signing for someone else's address is rejected", () => {
  const store = new ChallengeStore();
  const victim = Account.generate();
  const attacker = Account.generate();
  // Attacker gets a challenge bound to the victim's address, signs with own key.
  const { nonce } = store.issue(victim.accountAddress.toString());
  const sig = attacker.sign(challengeMessage(nonce));
  assert.throws(
    () =>
      store.verify({
        address: victim.accountAddress.toString(),
        publicKey: attacker.publicKey.toString(),
        nonce,
        signature: sig.toString(),
      }),
    /public key does not match address/,
  );
});

test("a tampered signature is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const proof = proofFor(store, account);
  // Flip a hex nibble in the signature.
  const tampered = {
    ...proof,
    signature: proof.signature.slice(0, -1) + (proof.signature.endsWith("0") ? "1" : "0"),
  };
  assert.throws(() => store.verify(tampered)); // bad signature or encoding
});

// ---- AIP-62 (wallet signMessage) scheme ----

/** Build a fullMessage the way an AIP-62 wallet would. */
function walletFullMessage(address: string, statement: string, nonce: string): string {
  return `APTOS\naddress: ${address}\nmessage: ${statement}\nnonce: ${nonce}`;
}

function aip62ProofFor(store: ChallengeStore, account: Account): Proof {
  const address = account.accountAddress.toString();
  const { nonce } = store.issue(address);
  const fullMessage = walletFullMessage(address, CHALLENGE_STATEMENT, nonce);
  const signature = account.sign(new TextEncoder().encode(fullMessage));
  return {
    address,
    publicKey: account.publicKey.toString(),
    nonce,
    signature: signature.toString(),
    scheme: "aip62",
    fullMessage,
  };
}

test("aip62: valid wallet-style proof is accepted", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const verified = store.verify(aip62ProofFor(store, account));
  assert.equal(verified, account.accountAddress.toStringLong());
});

test("aip62: fullMessage with a different nonce is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const address = account.accountAddress.toString();
  const { nonce } = store.issue(address);
  const forged = walletFullMessage(address, CHALLENGE_STATEMENT, "0xother");
  const signature = account.sign(new TextEncoder().encode(forged));
  assert.throws(
    () =>
      store.verify({
        address,
        publicKey: account.publicKey.toString(),
        nonce,
        signature: signature.toString(),
        scheme: "aip62",
        fullMessage: forged,
      }),
    /nonce mismatch/,
  );
});

test("aip62: fullMessage without our statement is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const address = account.accountAddress.toString();
  const { nonce } = store.issue(address);
  const forged = walletFullMessage(address, "Approve unrelated dapp action", nonce);
  const signature = account.sign(new TextEncoder().encode(forged));
  assert.throws(
    () =>
      store.verify({
        address,
        publicKey: account.publicKey.toString(),
        nonce,
        signature: signature.toString(),
        scheme: "aip62",
        fullMessage: forged,
      }),
    /challenge statement/,
  );
});

test("aip62: signature over a different fullMessage is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const address = account.accountAddress.toString();
  const { nonce } = store.issue(address);
  const genuine = walletFullMessage(address, CHALLENGE_STATEMENT, nonce);
  // Signature made over some other bytes entirely.
  const signature = account.sign(new TextEncoder().encode("something else"));
  assert.throws(
    () =>
      store.verify({
        address,
        publicKey: account.publicKey.toString(),
        nonce,
        signature: signature.toString(),
        scheme: "aip62",
        fullMessage: genuine,
      }),
    /bad signature/,
  );
});

test("aip62: missing fullMessage is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  const address = account.accountAddress.toString();
  const { nonce } = store.issue(address);
  const signature = account.sign(challengeMessage(nonce));
  assert.throws(
    () =>
      store.verify({
        address,
        publicKey: account.publicKey.toString(),
        nonce,
        signature: signature.toString(),
        scheme: "aip62",
      }),
    /fullMessage required/,
  );
});

test("unknown nonce is rejected", () => {
  const store = new ChallengeStore();
  const account = Account.generate();
  assert.throws(
    () =>
      store.verify({
        address: account.accountAddress.toString(),
        publicKey: account.publicKey.toString(),
        nonce: "0xdeadbeef",
        signature: "0x" + "00".repeat(64),
      }),
    /unknown or used challenge/,
  );
});
