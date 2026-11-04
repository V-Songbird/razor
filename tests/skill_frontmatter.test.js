"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const SKILLS = path.join(__dirname, "..", "skills");
const ALLOWED_KEYS = ["name", "description", "when_to_use", "argument-hint", "allowed-tools"];

describe("skill frontmatter", () => {
  for (const name of fs.readdirSync(SKILLS)) {
    test(`${name} uses only the keys every host accepts`, () => {
      const skill = fs.readFileSync(path.join(SKILLS, name, "SKILL.md"), "utf-8");
      const block = skill.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
      assert.ok(block, "missing frontmatter");
      const fields = {};
      for (const line of block[1].split(/\r?\n/)) {
        const m = line.match(/^([a-z_-]+): (.*)$/);
        assert.ok(m, `not a single-line key: ${line}`);
        fields[m[1]] = m[2];
      }
      assert.deepEqual(
        Object.keys(fields).filter((key) => !ALLOWED_KEYS.includes(key)),
        [],
        "unknown frontmatter key"
      );
      assert.equal(fields.name, name);
      assert.ok(fields.description, "missing description");
      assert.ok(fields.description.length <= 1024, "description too long for Codex");
      assert.doesNotMatch(fields.description, /[<>]/, "Codex rejects angle brackets in a description");
      // Codex parses the frontmatter as YAML; an unquoted value holding ": " is invalid there.
      if (!fields.description.startsWith('"')) {
        assert.doesNotMatch(fields.description, /: | #/, "unquoted description is not valid YAML");
      }
    });
  }

  // Codex attaches a plugin skill only for its <plugin>:<skill> mention.
  test("unused names itself with the plugin prefix for Codex", () => {
    const dir = path.join(SKILLS, "unused");
    const yaml = fs.readFileSync(path.join(dir, "agents", "openai.yaml"), "utf-8");
    const skill = fs.readFileSync(path.join(dir, "SKILL.md"), "utf-8");
    assert.match(yaml, /\$razor:unused/);
    assert.match(skill, /\$razor:unused/);
    assert.doesNotMatch(yaml + skill, /\$unused/);
  });

  // The skill is report-only, and section 3 expects cleanup-phrased requests
  // to reach it so it reports instead of uninstalling.
  test("unused does not tell the host to skip removal requests", () => {
    const skill = fs.readFileSync(path.join(SKILLS, "unused", "SKILL.md"), "utf-8");
    const description = skill.match(/^description: (.*)$/m)[1];
    assert.doesNotMatch(description, /Not for[^.]*\b(remov|uninstall|clean)/i);
  });
});
