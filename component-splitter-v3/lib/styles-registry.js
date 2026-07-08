const fs = require('fs');
const path = require('path');

/** Normalizes a style object's text for comparison (whitespace-insensitive). */
function normalizeStyleText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Loads existing shared styles from `<stylesDir>/shared.ts`, if present.
 * Parses out `name: { ... }` entries with a simple brace-depth scan (kept
 * dependency-free, consistent with the rest of this tool). Returns a Map
 * of normalizedText -> name. */
function loadSharedStyles(stylesFilePath) {
  const map = new Map();
  if (!fs.existsSync(stylesFilePath)) return map;

  const text = fs.readFileSync(stylesFilePath, 'utf8');
  const entryRegex = /(\w+):\s*{/g;
  let m;
  while ((m = entryRegex.exec(text)) !== null) {
    const name = m[1];
    const braceStart = m.index + m[0].length - 1;
    let depth = 0;
    let j = braceStart;
    for (; j < text.length; j++) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    const objectText = text.slice(braceStart, j + 1);
    map.set(normalizeStyleText(objectText), name);
  }
  return map;
}

/** Writes the full shared styles file from a Map of normalizedText -> name,
 * plus the map of name -> original (unnormalized) object text. */
function saveSharedStyles(stylesFilePath, nameToObjectText) {
  fs.mkdirSync(path.dirname(stylesFilePath), { recursive: true });
  const entries = [...nameToObjectText.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, objText]) => `  ${name}: ${objText},`)
    .join('\n');

  const content = `import { StyleSheet } from 'react-native';

// Auto-generated / auto-maintained shared style registry.
// Styles that are identical across multiple components get a single
// shared entry here instead of being duplicated in every file.
export const sharedStyles = StyleSheet.create({
${entries}
});
`;
  fs.writeFileSync(stylesFilePath, content, 'utf8');
}

/**
 * A registry object used during a single tool run (and persisted to disk
 * at the end) to dedupe style objects both within this run and against
 * whatever was already in the shared styles file from previous runs.
 */
function createStylesRegistry(stylesFilePath) {
  const existingByNormalized = loadSharedStyles(stylesFilePath);
  const nameToObjectText = new Map();
  // seed with existing entries (we don't have their original text handy,
  // so re-derive it by reading the file's raw object text again)
  for (const [normalized, name] of existingByNormalized.entries()) {
    nameToObjectText.set(name, normalized);
  }
  let counter = nameToObjectText.size;
  let dirty = false;

  return {
    /** Returns the shared style name to use for this object text (reusing
     * an existing one if identical), registering a new one if needed. */
    getOrCreate(objectText) {
      const normalized = normalizeStyleText(objectText);
      if (existingByNormalized.has(normalized)) {
        return existingByNormalized.get(normalized);
      }
      counter += 1;
      const name = `shared${counter}`;
      existingByNormalized.set(normalized, name);
      nameToObjectText.set(name, objectText);
      dirty = true;
      return name;
    },
    /** Persists the registry to disk if anything new was added. */
    save() {
      if (dirty) saveSharedStyles(stylesFilePath, nameToObjectText);
    },
  };
}

module.exports = { createStylesRegistry, normalizeStyleText };
