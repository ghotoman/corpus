import assert from "node:assert/strict";
import { test } from "node:test";
import { Account } from "@aptos-labs/ts-sdk";
import { ChallengeStore, challengeMessage, type Proof } from "../src/auth.js";

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
