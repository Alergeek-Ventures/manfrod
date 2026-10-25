import { describe, expect, it } from "vitest";
import { containsSecret, languageHint } from "../../lib/security/secrets.ts";

describe("containsSecret", () => {
  it("flags known-provider secret formats via the gitleaks ruleset", () => {
    expect(containsSecret(`stripe key ${"sk_liv"}e_4eC39HqLyjWDarjtT1zdp7dc`)).toBe(true);
    expect(containsSecret(`github token ${"gh"}p_wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx`)).toBe(true);
  });

  it("flags a labelled credential whose value mixes letters and digits", () => {
    expect(containsSecret("tutaj klucz: qX7pL2vR9zK4mN8wJ3hT6yB1cF5dS0gA-uE_oP")).toBe(true);
    expect(containsSecret("token=Zm9vYmFyLXJhbmRvbS1sb29raW5nLXRlc3QtdG9rZW4tMTIzNDU")).toBe(true);
    expect(containsSecret("ważne hasło: X9jo84N8LCpGpds!")).toBe(true);
    expect(containsSecret("api key: new1_890ca0d4ad79b01b02f9d6e835bd42bf")).toBe(true);
  });

  it("does not flag ordinary sentences", () => {
    expect(containsSecret("hej siema, jak leci? co u ciebie słychać dzisiaj")).toBe(false);
    expect(containsSecret("zwykle zdanie bez zadnych sekretow tylko slowa")).toBe(false);
  });

  it("does not flag sentences that merely mention keys, tokens or the API", () => {
    expect(
      containsSecret(
        "dalem mu pare poprawek na watki, obsluge ich, zapisywanie kontekstu, nieprzerywanie w srodku konwy, mam nadzieje ze bedzie troche lepiej",
      ),
    ).toBe(false);
    expect(containsSecret("token: wygenerowałem nowy dzisiaj, sprawdźcie")).toBe(false);
    expect(containsSecret("klucz do biura jest u recepcji, password do wifi na tablicy")).toBe(false);
    expect(containsSecret("the api key rotation is scheduled for friday")).toBe(false);
  });

  it("does not flag random-looking text without a provider format or a label", () => {
    expect(containsSecret("qX7pL2vR9zK4mN8wJ3hT6yB1cF5dS0gA")).toBe(false);
  });

  it("does not flag URLs, even high-entropy ones", () => {
    expect(containsSecret("sprawdz to na https://example.com/some/very/long/path/that/is/normal")).toBe(false);
    expect(containsSecret("link: https://example.com/r/aB3xQ9zK-mN7wJ2hT6yB1cF5dS0gA?token=Zm9vYmFyLXJhbmRvbQ")).toBe(false);
  });

  it("does not flag camelCase identifiers or product names", () => {
    expect(containsSecret("wywołaj getUserById na tym obiekcie")).toBe(false);
    expect(containsSecret("mam iPhone15ProMax, działa świetnie")).toBe(false);
  });

  it("flags the AWS-format example key", () => {
    expect(containsSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  it("ignores nil input", () => {
    expect(containsSecret(null)).toBe(false);
  });
});

describe("languageHint", () => {
  it("detects Polish from diacritics", () => expect(languageHint("cześć, jak się masz?")).toBe("pl"));
  it("detects Polish from common words", () => expect(languageHint("hej co tam jak leci")).toBe("pl"));
  it("falls back to English", () => expect(languageHint("hey what's up, how are you doing today")).toBe("en"));
});
