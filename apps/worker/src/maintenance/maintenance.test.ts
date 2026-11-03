import type { Storage } from "@ai-triage/storage";
import { describe, expect, it } from "vitest";
import { deleteStorage } from "./register";

// `storage.delete` only ever touches its own tenant's key space.

function fakeStorage() {
  const calls: string[] = [];
  const storage = {
    delete: async (keys: readonly string[]) => {
      calls.push(...keys.map((k) => `key:${k}`));
    },
    deletePrefix: async (prefix: string) => {
      calls.push(`prefix:${prefix}`);
      return 0;
    },
  } as unknown as Storage;
  return { storage, calls };
}

describe("deleteStorage", () => {
  it("deletes the tenant's keys and folders", async () => {
    const { storage, calls } = fakeStorage();
    await deleteStorage(storage, { tenantId: "a", keys: ["t/a/a/1"], prefixes: ["t/a/e/2/"] });
    expect(calls).toEqual(["key:t/a/a/1", "prefix:t/a/e/2/"]);
  });

  it("refuses another tenant's keys, and the tenant's whole folder", async () => {
    const { storage, calls } = fakeStorage();
    await expect(deleteStorage(storage, { tenantId: "a", keys: ["t/b/a/1"], prefixes: [] })).rejects.toThrow();
    await expect(deleteStorage(storage, { tenantId: "a", keys: [], prefixes: ["t/a/"] })).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
