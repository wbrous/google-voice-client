import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/index";

// If this fails: the package's exported VERSION constant is missing or malformed
describe("VERSION", () => {
  test("is a non-empty semver-like string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
