'use strict';

const MAX_PATTERN_LENGTH = 256;

function compileSafeRegex(pattern) {
  const value = String(pattern);
  if (!value || value.length > MAX_PATTERN_LENGTH) throw new Error(`Regex patterns must be 1–${MAX_PATTERN_LENGTH} characters`);
  if (/\\[1-9]|\\k<|\(\?[=!<]/.test(value)) throw new Error('Regex backreferences and lookarounds are not supported');
  if (/\([^)]*\)[*+{]/.test(value)) throw new Error('Regex groups cannot be repeated; simplify this pattern to keep scans safe');
  const quantifiers = value.match(/(?<!\\)[*+]|(?<!\\)\{\d+(?:,\d*)?\}/g) || [];
  if (quantifiers.length > 8 || quantifiers.filter(q => q === '*' || q === '+').length > 3) throw new Error('Regex pattern uses too many repetitions');
  if (quantifiers.some(q => { const match = q.match(/\d+/); return match && Number(match[0]) > 1000; })) throw new Error('Regex repetition counts cannot exceed 1000');
  try { return new RegExp(value.normalize('NFC'), 'iu'); }
  catch (err) { throw new Error(`Invalid regex: ${err.message}`); }
}

function validateRegexList(patterns = []) {
  for (const pattern of patterns.filter(Boolean)) compileSafeRegex(pattern);
}

module.exports = { compileSafeRegex, validateRegexList };
