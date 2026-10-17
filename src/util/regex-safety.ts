import v8 from "node:v8";

/**
 * User-written regular expressions run on the server against feed text, so a pattern like (a+)+$ must not be able to pin the process.
 * Two layers cover that. V8's linear-time fallback takes over once a pattern backtracks too much, which makes nested quantifiers, overlapping alternation and polynomial patterns finish in milliseconds.
 * The fallback cannot handle backreferences or lookaround, which stay exponential, so those constructs are refused.
 */
v8.setFlagsFromString("--enable-experimental-regexp-engine-on-excessive-backtracks");

/** Returns a readable reason when a pattern uses a construct that cannot be matched in bounded time, or null when it is fine. */
export function unsafeRegexReason(pattern: string): string | null {
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      const next = pattern[i + 1] ?? "";
      if (!inClass && /[1-9]/.test(next)) return "Backreferences such as \\1 are not allowed";
      if (!inClass && next === "k" && pattern[i + 2] === "<") return "Named backreferences are not allowed";
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(" && pattern[i + 1] === "?") {
      const kind = pattern.slice(i + 2, i + 4);
      if (kind[0] === "=" || kind[0] === "!" || kind === "<=" || kind === "<!") return "Lookahead and lookbehind are not allowed";
    }
  }
  return null;
}
