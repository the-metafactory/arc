import { describe, test, expect, afterEach } from "bun:test";
import {
  fetchRegistryPublicKey,
  verifyRegistrySignature,
  verifyVersionSignature,
} from "../../src/lib/registry-signing.js";
import type { RegistrySource } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetch(handler: (input: any, init?: any) => Promise<Response>): typeof fetch {
  const fn = handler as typeof fetch;
  (fn as any).preconnect = () => {};
  return fn;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function generateKeypair() {
  const kp = (await crypto.subtle.generateKey(
    { name: "Ed25519" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const raw = await crypto.subtle.exportKey("raw", kp.publicKey);
  return { kp, rawPubBase64: bytesToBase64(new Uint8Array(raw)) };
}

async function signBytes(kp: CryptoKeyPair, text: string): Promise<string> {
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    kp.privateKey,
    new TextEncoder().encode(text),
  );
  return bytesToBase64(new Uint8Array(sig));
}

function source(url = "https://reg.test"): RegistrySource {
  return { name: "mf", url, tier: "official", enabled: true, type: "metafactory" };
}

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

// ---------------------------------------------------------------------------
// verifyRegistrySignature — pure crypto
// ---------------------------------------------------------------------------

describe("verifyRegistrySignature", () => {
  test("returns true for a valid signature over the exact bytes", async () => {
    const { kp, rawPubBase64 } = await generateKeypair();
    const manifest = '{"name":"@x/y","version":"1.0.0"}';
    const sig = await signBytes(kp, manifest);
    expect(await verifyRegistrySignature(rawPubBase64, sig, manifest)).toBe(true);
  });

  test("returns false when a single byte of the manifest is changed", async () => {
    const { kp, rawPubBase64 } = await generateKeypair();
    const manifest = '{"name":"@x/y","version":"1.0.0"}';
    const sig = await signBytes(kp, manifest);
    const tampered = manifest.replace('"1.0.0"', '"1.0.1"');
    expect(await verifyRegistrySignature(rawPubBase64, sig, tampered)).toBe(false);
  });

  test("returns false for a signature made by a different key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const manifest = "hello";
    const sig = await signBytes(a.kp, manifest);
    // verify with b's public key
    expect(await verifyRegistrySignature(b.rawPubBase64, sig, manifest)).toBe(false);
  });

  test("returns false (never throws) for malformed base64", async () => {
    expect(await verifyRegistrySignature("!!!not-base64!!!", "!!!", "x")).toBe(false);
  });

  test("returns false for wrong-length public key", async () => {
    const shortKey = bytesToBase64(new Uint8Array(16));
    const sig = bytesToBase64(new Uint8Array(64));
    expect(await verifyRegistrySignature(shortKey, sig, "x")).toBe(false);
  });

  test("returns false for wrong-length signature", async () => {
    const { rawPubBase64 } = await generateKeypair();
    const shortSig = bytesToBase64(new Uint8Array(32));
    expect(await verifyRegistrySignature(rawPubBase64, shortSig, "x")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchRegistryPublicKey
// ---------------------------------------------------------------------------

describe("fetchRegistryPublicKey", () => {
  test("returns the parsed body on 200", async () => {
    const { rawPubBase64 } = await generateKeypair();
    globalThis.fetch = mockFetch(async () =>
      new Response(
        JSON.stringify({
          algorithm: "Ed25519",
          key_id: "mf-reg-2026-04",
          public_key: rawPubBase64,
          created_at: 1776124800,
        }),
        { status: 200 },
      ),
    );
    const key = await fetchRegistryPublicKey(source());
    expect(key).not.toBeNull();
    expect(key!.key_id).toBe("mf-reg-2026-04");
    expect(key!.public_key).toBe(rawPubBase64);
  });

  test("returns null on 503 (registry in degraded mode)", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response(JSON.stringify({ error: "signing_unconfigured" }), { status: 503 }),
    );
    expect(await fetchRegistryPublicKey(source())).toBeNull();
  });

  test("returns null on network error (never throws)", async () => {
    globalThis.fetch = mockFetch(async () => {
      throw new Error("boom");
    });
    expect(await fetchRegistryPublicKey(source())).toBeNull();
  });

  test("returns null on shape mismatch (wrong algorithm)", async () => {
    globalThis.fetch = mockFetch(async () =>
      new Response(
        JSON.stringify({ algorithm: "RSA", key_id: "x", public_key: "y", created_at: 0 }),
        { status: 200 },
      ),
    );
    expect(await fetchRegistryPublicKey(source())).toBeNull();
  });

  test("does not send Authorization header (anonymous)", async () => {
    let authSeen: string | null | undefined;
    globalThis.fetch = mockFetch(async (_input: any, init?: any) => {
      authSeen = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({}), { status: 404 });
    });
    await fetchRegistryPublicKey(source());
    expect(authSeen).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyVersionSignature — orchestration
// ---------------------------------------------------------------------------

describe("verifyVersionSignature", () => {
  test("verified=true when signature matches manifest_canonical", async () => {
    const { kp, rawPubBase64 } = await generateKeypair();
    const manifest = '{"name":"@x/y","version":"1.0.0"}';
    const sig = await signBytes(kp, manifest);

    globalThis.fetch = mockFetch(async () =>
      new Response(
        JSON.stringify({
          algorithm: "Ed25519",
          key_id: "mf-reg-2026-04",
          public_key: rawPubBase64,
          created_at: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await verifyVersionSignature(
      source(),
      { registry_signature: sig, registry_key_id: "mf-reg-2026-04" },
      manifest,
    );
    expect(result.verified).toBe(true);
  });

  test("verified=false when manifest_canonical is tampered", async () => {
    const { kp, rawPubBase64 } = await generateKeypair();
    const manifest = '{"name":"@x/y","version":"1.0.0"}';
    const sig = await signBytes(kp, manifest);

    globalThis.fetch = mockFetch(async () =>
      new Response(
        JSON.stringify({
          algorithm: "Ed25519",
          key_id: "mf-reg-2026-04",
          public_key: rawPubBase64,
          created_at: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await verifyVersionSignature(
      source(),
      { registry_signature: sig, registry_key_id: "mf-reg-2026-04" },
      manifest.replace("1.0.0", "9.9.9"),
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signature does not match/i);
  });

  test("verified=null when registry_signature is null (legacy/unsigned)", async () => {
    const result = await verifyVersionSignature(
      source(),
      { registry_signature: null, registry_key_id: null },
      "whatever",
    );
    expect(result.verified).toBeNull();
  });

  test("verified=false when well-known returns 503 but version claims to be signed", async () => {
    globalThis.fetch = mockFetch(async () => new Response("", { status: 503 }));
    const result = await verifyVersionSignature(
      source(),
      { registry_signature: "A".repeat(88), registry_key_id: "mf-reg-2026-04" },
      "manifest-bytes",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/public key unavailable/i);
  });

  test("verified=false when key_id on the version disagrees with the served key", async () => {
    const { kp, rawPubBase64 } = await generateKeypair();
    const sig = await signBytes(kp, "m");
    globalThis.fetch = mockFetch(async () =>
      new Response(
        JSON.stringify({
          algorithm: "Ed25519",
          key_id: "mf-reg-CURRENT",
          public_key: rawPubBase64,
          created_at: 0,
        }),
        { status: 200 },
      ),
    );
    const result = await verifyVersionSignature(
      source(),
      { registry_signature: sig, registry_key_id: "mf-reg-OLD" },
      "m",
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/key_id mismatch/i);
  });

  test("verified=false when manifest_canonical is missing from registry response", async () => {
    const result = await verifyVersionSignature(
      source(),
      { registry_signature: "sig", registry_key_id: "kid" },
      null,
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/manifest_canonical missing/i);
  });
});
