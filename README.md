# RN Component Splitter v3 (project-aware)

v3 is a significant upgrade from v2. The core split logic is the same
AST-based approach, but the tool is now **project-aware**: it loads your
real `tsconfig.json` and installed types to get real prop types, and it
verifies its own output with the TypeScript compiler before committing to
disk — rolling back automatically if something's wrong.

## Setup

```bash
npm install   # pulls in `typescript`
```

Run it from anywhere inside a project that has a `tsconfig.json` (it
searches upward to find one, same as your editor would):

```bash
node index.js path/to/HomeScreen.tsx --dry-run
node index.js path/to/HomeScreen.tsx --with-tests
node index.js path/to/HomeScreen.tsx --max-lines=100 --min-block-lines=15
```

See `--help` for the full flag list, or drop an `rn-splitter.config.json`
(see `rn-splitter.config.example.json`) at your project root to set
defaults so you don't have to type flags every run.

## What's new in v3

### 1. Real prop types (not just heuristics)
If a `tsconfig.json` is found, the tool builds an actual `ts.Program` —
the same machinery your editor uses — and asks the real type checker what
each prop's type is. In testing this correctly produced things like
`posts: Post[]` and `handleProfilePress: () => void` instead of `any`.

If a prop's real type references a custom `interface`/`type` or an
imported type, the tool copies that declaration (or a path-corrected
import) into the new file so it's actually valid — and if it can't safely
resolve a dependency, it deliberately falls back to `any` for that one
prop rather than emitting a reference to something that doesn't exist.

**No tsconfig found?** It falls back to the same heuristic-based
inference v2 used (initializer-based guessing). Nothing breaks, it's just
less precise.

### 2. Self-check before writing (the big reliability upgrade)
After splitting, the tool runs a real type-check on exactly the files it
touched. If any of them have a syntax error, or a "cannot find name /
module" error, it **automatically rolls back** — restores the original
file and deletes the new component files — instead of leaving broken code
behind. This is the automated version of the manual check that caught a
real bug during development (see "Bugs this caught" below).

### 3. Automatic backup
Before rewriting your original file, it saves a literal `<file>.bak` copy
to disk, in addition to the in-memory rollback safety net.

### 4. Shared, project-wide style deduplication
Inline `style={{...}}` objects are extracted into a `styles/shared.ts`
file (relative to wherever your component lives). Identical style objects
— even across completely different components, even across separate runs
of the tool — get one shared entry instead of duplicates. Use
`--no-shared-styles` to instead get a separate `StyleSheet.create()` per
file, like v2 did.

### 5. Recursive splitting
If an extracted component is itself still too big, the tool automatically
runs itself again on that new file (up to `--max-depth`, default 2).

### 6. Basic test stub generation (`--with-tests`)
Generates a minimal render smoke-test per extracted component. It assumes
`@testing-library/react-native` (not installed automatically — the stub
says so), and is marked `// @ts-nocheck` so it doesn't interfere with the
self-check pass if that library isn't present yet.

### 7. Handles early-return / loading-state patterns
v2 only looked at a component's single `return`. v3 finds *every*
`return <JSX/>` in the component (e.g. `if (isLoading) return <Spinner/>`
followed by the main content), and splits whichever branch is actually
large enough — instead of getting confused or only handling the first one.

### 8. Consistent formatting
Output is re-printed through the TypeScript compiler's own printer for
consistent indentation, rather than raw text-splicing. (Not a substitute
for Prettier/your project's own formatter — it just avoids obviously ugly
output.)

## Bugs this development process actually caught

Being transparent about this since it's the whole point of the self-check
feature: while building v3, the automated self-check caught a real bug
I introduced — real type inference correctly found a prop's type was
`Post[]`, but the generated file didn't have access to the `Post` type
definition, so type-checking failed with "Cannot find name 'Post'". The
tool rolled back automatically instead of leaving broken code. I then
fixed the root cause (copying referenced type declarations/imports, with
a safe `any` fallback if a dependency can't be resolved) rather than
just suppressing the check.

## Tested against

A small but real Expo-style project (`test-project/`) with:
- A proper `tsconfig.json` and stub `.d.ts` files for `react`/`react-native`/`@react-navigation/native`
- A typed `Props` type and a custom `Post` type
- An early-return loading state before the main content

Verified by running an independent `tsc --noEmit` across the *entire*
resulting project after the tool ran — zero errors.

## Known limitations (still honest about these)

- **Type stubs, not real packages.** Testing used hand-written minimal
  `.d.ts` stubs rather than actual `npm install`ed `react-native`, since
  this sandbox has no network access. Real projects with real installed
  types should work the same way (the mechanism is identical), but this
  hasn't been verified against an actual `node_modules/react-native`.
- **Shared style dedup is exact-match only.** Two nearly-but-not-quite
  identical style objects won't be merged.
- **Recursive splitting can leave the root file's imports duplicated**
  if a nested split's naming collides with a name already used higher up
  — not observed in testing but not exhaustively fuzzed either.
- **Test stubs are minimal** — a smoke test, not real coverage.
- **Still assumes a single root JSX element per component.** Unusual
  return patterns beyond simple early-returns aren't handled.
- **Not yet run against actual Michelangelo-generated code** — still
  only tested against representative samples I built myself.
