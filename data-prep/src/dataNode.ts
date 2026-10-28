// Parser for the Endless Sky data format. Mirrors source/DataFile.cpp (LoadData):
// - one node per non-empty, non-comment line; indentation depth gives the parent
// - tokens are separated by whitespace; "..." or `...` tokens may contain spaces
// - '#' outside a token starts a comment
// The same format is used by the save files, so this is shared with the runtime save parser.

export interface DataNode {
	tokens: string[];
	children: DataNode[];
	line: number;
}

export function parseData(text: string): DataNode[] {
	const root: DataNode = { tokens: [], children: [], line: 0 };
	// Stack of [node, indentation]; the root sits at -1 so every line has a parent.
	const stack: Array<[DataNode, number]> = [[root, -1]];

	if(text.charCodeAt(0) === 0xFEFF)
		text = text.slice(1);

	const lines = text.split("\n");
	for(let i = 0; i < lines.length; ++i)
	{
		const raw = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];

		let pos = 0;
		while(pos < raw.length && raw.charCodeAt(pos) <= 32)
			++pos;
		if(pos === raw.length || raw[pos] === "#")
			continue;

		while(stack[stack.length - 1][1] >= pos)
			stack.pop();

		const node: DataNode = { tokens: tokenize(raw, pos), children: [], line: i + 1 };
		stack[stack.length - 1][0].children.push(node);
		stack.push([node, pos]);
	}
	return root.children;
}

function tokenize(line: string, start: number): string[] {
	const tokens: string[] = [];
	let pos = start;
	const end = line.length;
	while(pos < end)
	{
		const c = line[pos];
		if(c === "#")
			break;
		if(c === "\"" || c === "`")
		{
			// Quoted: everything up to the next matching quote (or end of line).
			const close = line.indexOf(c, pos + 1);
			const stop = close < 0 ? end : close;
			tokens.push(line.slice(pos + 1, stop));
			pos = close < 0 ? end : close + 1;
		}
		else
		{
			let stop = pos;
			while(stop < end && line.charCodeAt(stop) > 32)
				++stop;
			tokens.push(line.slice(pos, stop));
			pos = stop;
		}
		while(pos < end && line.charCodeAt(pos) <= 32)
			++pos;
	}
	return tokens;
}

export function numberAt(node: DataNode, index: number): number {
	const value = Number(node.tokens[index]);
	return Number.isNaN(value) ? 0 : value;
}
