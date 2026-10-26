import { describe, expect, it } from "vitest";
import { celsiusToFahrenheit } from "../../agent/lib/temperature.ts";

describe("celsiusToFahrenheit", () => {
  it("converts reference points", () => {
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
    expect(celsiusToFahrenheit(37)).toBe(98.6);
  });

  it("rounds to two decimals", () => {
    expect(celsiusToFahrenheit(36.666)).toBe(98);
    expect(celsiusToFahrenheit(-17.7778)).toBe(0);
  });
});
