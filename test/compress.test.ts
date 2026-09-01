import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { compressImageToFit } from "../src/compress";

async function makeTestPng(width: number, height: number): Promise<Uint8Array> {
  // A solid-color PNG large enough that at full quality it exceeds tiny
  // byte budgets, giving the compressor real work to do.
  const buffer = await sharp({
    create: { width, height, channels: 3, background: { r: 120, g: 40, b: 200 } },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buffer);
}

// If this fails: compressImageToFit no longer shrinks an oversized image
// under the requested byte budget, so large attachments would keep failing
// to send even with `compress: true`.
describe("compressImageToFit", () => {
  test("returns JPEG bytes at or under maxBytes for an image that needs shrinking", async () => {
    const original = await makeTestPng(1200, 1200);
    const maxBytes = 20_000;
    const result = await compressImageToFit(original, maxBytes);
    expect(result.mimeType).toBe("image/jpeg");
    expect(result.data.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(result.data.byteLength).toBeGreaterThan(0);
  });

  // If this fails: an already-small image gets needlessly re-encoded into
  // something larger than necessary, or the function stops respecting a
  // generous budget it should hit on the first attempt.
  test("fits a small image within a generous budget", async () => {
    const original = await makeTestPng(50, 50);
    const result = await compressImageToFit(original, 50_000);
    expect(result.data.byteLength).toBeLessThanOrEqual(50_000);
  });

  // If this fails: an impossible budget silently returns oversized data
  // instead of surfacing that it couldn't be met.
  test("throws when no attempted quality/scale fits the budget", async () => {
    const original = await makeTestPng(1200, 1200);
    await expect(compressImageToFit(original, 10)).rejects.toThrow(/Could not compress/);
  });
});
