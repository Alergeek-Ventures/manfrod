import { describe, expect, it } from "vitest";
import { celsiusToFahrenheit } from "../../agent/lib/temperature.ts";

describe("celsiusToFahrenheit", () => {
  it("converts reference points", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
  });

  it("rounds to two decimals", () => {
    expect(celsiusToFahrenheit(36.6)).toBe(97.88);
    expect(celsiusToFahrenheit(21.123)).toBe(70.02);
  });
});
