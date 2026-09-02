import { describe, expect, it } from "vitest";
import { DEFAULT_CHARACTER, validateCharacterProfile } from "./character";

describe("character profile", () => {
  it("accepts the bundled character", () => expect(validateCharacterProfile(DEFAULT_CHARACTER)).toEqual([]));
  it("rejects paths escaping the character pack", () => {
    expect(validateCharacterProfile({ ...DEFAULT_CHARACTER, avatar: "../secret.png" })).toContain("头像路径必须位于角色包内");
  });
  it("rejects incomplete manifests", () => expect(validateCharacterProfile({ schemaVersion: 1 })).toContain("缺少角色名称"));
});
