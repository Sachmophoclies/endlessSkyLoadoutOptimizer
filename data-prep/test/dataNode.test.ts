import { test } from "node:test";
import assert from "node:assert/strict";
import { parseData } from "../src/dataNode.ts";

test("parses nesting, quotes, backticks and comments", () => {
	const nodes = parseData([
		"# a comment",
		"outfit \"Heavy Laser\"",
		"\tcategory \"Guns\"",
		"\tweapon",
		"\t\t\"lifetime\" 1  # trailing comment",
		"\t\treload 1",
		"outfit `\"Biroo\" Atomic Steering`",
		"\t\"mass\" 2",
		"",
	].join("\n"));

	assert.equal(nodes.length, 2);
	assert.deepEqual(nodes[0].tokens, ["outfit", "Heavy Laser"]);
	assert.deepEqual(nodes[0].children[0].tokens, ["category", "Guns"]);
	const weapon = nodes[0].children[1];
	assert.deepEqual(weapon.children.map(c => c.tokens), [["lifetime", "1"], ["reload", "1"]]);
	assert.deepEqual(nodes[1].tokens, ["outfit", "\"Biroo\" Atomic Steering"]);
});

test("handles CRLF and a BOM", () => {
	const nodes = parseData("﻿ship \"A\"\r\n\tattributes\r\n\t\thull 5\r\n");
	assert.deepEqual(nodes[0].tokens, ["ship", "A"]);
	assert.deepEqual(nodes[0].children[0].children[0].tokens, ["hull", "5"]);
});

test("dedent returns to the right parent", () => {
	const nodes = parseData("a\n\tb\n\t\tc\n\td\ne\n");
	assert.deepEqual(nodes.map(n => n.tokens[0]), ["a", "e"]);
	assert.deepEqual(nodes[0].children.map(n => n.tokens[0]), ["b", "d"]);
});
