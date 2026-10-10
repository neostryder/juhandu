// A small tolerant XML reader for feeds. Real-world feeds are often malformed,
// so it never throws on bad markup: it recovers and keeps what it can read.

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1];
    if (key === undefined) continue;
    attrs[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attrs;
}

/** Parses an XML or HTML-ish document into a tree under a synthetic root. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: "#root", attrs: {}, children: [], text: "" };
  const stack: XmlNode[] = [root];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*(?:\[[\s\S]*?\])?>|<\/([^\s>]+)\s*>|<([^\s/>!?][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>|([^<]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source)) !== null) {
    const top = stack[stack.length - 1] as XmlNode;
    if (match[1] !== undefined) {
      top.text += match[1];
    } else if (match[2] !== undefined) {
      const closing = match[2];
      for (let i = stack.length - 1; i > 0; i--) {
        if ((stack[i] as XmlNode).name === closing) {
          stack.length = i;
          break;
        }
      }
    } else if (match[3] !== undefined) {
      const node: XmlNode = { name: match[3], attrs: parseAttributes(match[4] ?? ""), children: [], text: "" };
      top.children.push(node);
      if (match[5] !== "/") stack.push(node);
    } else if (match[6] !== undefined) {
      top.text += decodeEntities(match[6]);
    }
  }
  return root;
}

export function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find((c) => c.name === name);
}

export function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter((c) => c.name === name) : [];
}

export function textOf(node: XmlNode | undefined): string {
  return node ? node.text.trim() : "";
}

export function find(node: XmlNode, name: string): XmlNode | undefined {
  for (const c of node.children) {
    if (c.name === name) return c;
    const deeper = find(c, name);
    if (deeper) return deeper;
  }
  return undefined;
}
