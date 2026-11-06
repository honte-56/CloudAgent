/**
 * Used by Commands routes to fill a custom command's `$ARGUMENTS` with `argumentsText` and `$1`, `$2`, …
 * with the matching `args` token; a `$N` with no token is left as written.
 * One pass with a replacer function, so the user's text is inserted literally:
 * `$&`/`$$` in it are not replacement patterns, and a `$1` it contains is not
 * substituted again.
 */
export function substituteCommandArguments(template: string, argumentsText: string, args: unknown[]): string {
  return template.replace(/\$ARGUMENTS|\$([1-9]\d*)\b/g, (placeholder, position?: string) => {
    if (position === undefined) {
      return argumentsText;
    }
    const value = args[Number(position) - 1];
    return value === undefined ? placeholder : String(value);
  });
}

