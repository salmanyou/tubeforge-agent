const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const HISTORY_PATH = path.join(DATA_DIR, 'history.jsonl');

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { lastRun: null, totalRuns: 0, totalUpdatesApplied: 0, videos: {}, channel: null, pendingReview: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function appendHistory(entry) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_PATH, JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n');
}

module.exports = { loadState, saveState, appendHistory, DATA_DIR };
