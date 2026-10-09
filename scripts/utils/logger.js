import { DEBUG } from '../constants.js';

export function ovLog(...args) {
  if (!DEBUG) return;
  console.log(...args);
}

export function ovDebug(...args) {
  if (!DEBUG) return;
  console.debug(...args);
}
