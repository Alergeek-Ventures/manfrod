import { describe, expect, it } from "vitest";
import { matches, parse, rules } from "../../lib/security/gitleaks.ts";

const FIXTURE = `title = "gitleaks config"

[[rules]]
id = "adafruit-api-key"
description = "Adafruit API Key"
regex = '''(?i)adafruit[a-z0-9_-]{32}'''
keywords = ["adafruit"]

[[rules.allowlists]]
regexes = ['''sample-fake-adafruit-key''']

[[rules]]
id = "generic-password"
description = "Generic password assignment"
regex = '''password\\s*=\\s*"[a-z0-9]{8,}"'''
keywords = ["password"]

[[rules]]
id = "no-regex-rule"
description = "A rule with no regex (e.g. file-based)"
keywords = ["pkcs12"]
`;

describe("parse", () => {
  it("keeps rules with a regex, skipping generic ones", () => {
    const parsed = parse(FIXTURE);
    expect(parsed.map((rule) => rule.id)).toEqual(["adafruit-api-key"]);
    expect(parsed[0].keywords).toEqual(["adafruit"]);
    expect(parsed[0].regex.test(`ADAFRUIT${"a1".repeat(16)}`)).toBe(true);
  });

  it("scopes Go inline flags and named groups", () => {
    const [rule] = parse(`[[rules]]\nid = "x"\nregex = '''key-(?i:abc)(?P<v>[0-9]{4})'''\n`);
    expect(rule.regex.test("key-ABC1234")).toBe(true);
    expect(rule.regex.test("KEY-abc1234")).toBe(false);
  });
});

describe("matches (vendored ruleset)", () => {
  it("matches provider formats", () => {
    expect(matches(`${"sk_liv"}e_4eC39HqLyjWDarjtT1zdp7dc`)).not.toBeNull();
    expect(matches(`${"gh"}p_wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx`)).not.toBeNull();
  });

  it("does not match ordinary sentences", () => {
    expect(matches("hej, jak leci dzisiaj w pracy")).toBeNull();
    expect(matches("dalem mu pare poprawek na watki, obsluge ich, zapisywanie kontekstu, nieprzerywanie w srodku konwy")).toBeNull();
  });

  it("loads at least 200 rules", () => {
    expect(rules().length).toBeGreaterThan(200);
  });
});
