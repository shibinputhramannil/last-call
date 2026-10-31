import { MECHANICS } from '../../shared/campaign.js';
import cipherWheel from './cipherWheel.js';
import deadLine from './deadLine.js';
import partyLine from './partyLine.js';
import patchBay from './patchBay.js';
import relayRack from './relayRack.js';
import teleprinter from './teleprinter.js';

/** Puzzle mechanics by type. Each matches an entry in shared/campaign.js MECHANICS. */
export const PUZZLES = Object.freeze({
  'dead-line': deadLine,
  'patch-bay': patchBay,
  teleprinter,
  'party-line': partyLine,
  'relay-rack': relayRack,
  'cipher-wheel': cipherWheel,
});

for (const [type, m] of Object.entries(MECHANICS)) {
  const def = PUZZLES[type];
  if (!def || def.levels.length - 1 !== m.maxLevel) throw new Error(`puzzle mechanic ${type} does not match the campaign`);
}
