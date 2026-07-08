const fs = require('fs');
const path = require('path');

const CONFIG_FILENAME = 'rn-splitter.config.json';

/** Walks upward from a starting directory looking for a config file. */
function loadConfig(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = path.join(dir, CONFIG_FILENAME);
    if (fs.existsSync(candidate)) {
      try {
        return JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch (e) {
        console.warn(`Warning: found ${candidate} but couldn't parse it as JSON (${e.message}). Ignoring.`);
        return {};
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return {};
    dir = parent;
  }
}

module.exports = { loadConfig, CONFIG_FILENAME };
