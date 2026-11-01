'use strict';
/**
 * Loads the evaluation set: any <name>.jpg|.jpeg|.png with a matching <name>.txt (ground truth), plus an
 * optional <name>.mistakes.tsv, from a folder that lives OUTSIDE the repository.
 *
 * Read-only by design: nothing is written, copied or moved, and image bytes are not even read until
 * `readImageBytes` is called for a specific item.
 */
const fs = require('fs');
const path = require('path');
const { parseMistakes, parsePhrases } = require('./metrics.cjs');

const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png']);
// Optional files next to <name>.jpeg/<name>.txt. All are plain text; none is required.
//   <name>.mistakes.tsv    genuine student mistakes (over-correction metric)
//   <name>.answer.txt      the student's answer only: what the page says without the copied question
//   <name>.question.txt    the question as the student copied it, one line per line; empty = checked, none
//   <name>.struck.txt      crossed-out phrases, one per line; empty = checked, none
//   <name>.assignment.json the assignment text stored in the app ({title, instructions, ...}), sent as context
const SIDECARS = Object.freeze({ '.mistakes.tsv': 'mistakes', '.answer.txt': 'answer', '.question.txt': 'question', '.struck.txt': 'struck', '.assignment.json': 'assignment' });
const ASSIGNMENT_KEYS = Object.freeze(['title', 'prompt', 'question', 'instructions', 'description']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // the production OCR path rejects larger images
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

class DatasetError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'DatasetError';
    this.problems = problems;
  }
}

// Numeric-aware ordering: image2 sorts before image10. Ties fall back to a plain comparison.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function naturalCompare(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function isInsideDirectory(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveEvalDir(env = process.env) {
  const raw = env.OCR_EVAL_DIR;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new DatasetError('OCR_EVAL_DIR is not set. Point it at the folder holding the images and ground-truth .txt files (outside the repository).');
  }
  return path.resolve(raw.trim());
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function readText(file, problems) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    problems.push(`${path.basename(file)}: cannot be read (${error.code || 'read error'})`);
    return null;
  }
}

function loadDataset(directory, { maxImageBytes = MAX_IMAGE_BYTES } = {}) {
  const dir = path.resolve(directory);
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new DatasetError(`Folder not found: ${dir}`); }
  if (!stat.isDirectory()) throw new DatasetError(`Not a folder: ${dir}`);

  const warnings = [], problems = [];
  if (isInsideDirectory(dir, BACKEND_ROOT)) {
    warnings.push('The evaluation folder is inside the repository. Keep photos and ground truth outside it so they can never be committed.');
  }

  const images = new Map(), texts = new Map();
  const sidecars = Object.fromEntries(Object.values(SIDECARS).map(kind => [kind, new Map()]));
  for (const file of fs.readdirSync(dir).sort(naturalCompare)) {
    if (file.startsWith('.')) continue; // hidden and resource-fork files
    const full = path.join(dir, file);
    let info;
    try { info = fs.statSync(full); } catch { continue; }
    if (!info.isFile()) continue;
    const suffix = Object.keys(SIDECARS).find(s => file.toLowerCase().endsWith(s));
    if (suffix) { addTo(sidecars[SIDECARS[suffix]], file.slice(0, -suffix.length), file); continue; }
    const { name, ext } = path.parse(file);
    const extension = ext.toLowerCase();
    if (extension === '.txt') addTo(texts, name, file);
    else if (IMAGE_EXTENSIONS.includes(extension)) addTo(images, name, { file, extension, bytes: info.size });
  }

  const items = [];
  for (const name of [...images.keys()].sort(naturalCompare)) {
    const candidates = images.get(name);
    if (candidates.length > 1) {
      problems.push(`${name}: more than one image (${candidates.map(c => c.file).join(', ')}); keep exactly one`);
      continue;
    }
    const [image] = candidates;
    const truthFiles = texts.get(name);
    if (!truthFiles) { warnings.push(`${image.file}: skipped, there is no matching ${name}.txt`); continue; }
    if (truthFiles.length > 1) { problems.push(`${name}: more than one ground-truth file (${truthFiles.join(', ')})`); continue; }

    const groundTruthPath = path.join(dir, truthFiles[0]);
    const groundTruth = readText(groundTruthPath, problems);
    if (groundTruth === null) continue;
    if (!groundTruth.trim()) { problems.push(`${truthFiles[0]}: ground truth is empty`); continue; }
    if (groundTruth.includes('�')) warnings.push(`${truthFiles[0]}: contains replacement characters, it may not be valid UTF-8`);

    let mistakes = null, mistakesPath = null;
    const mistakeFiles = sidecars.mistakes.get(name);
    if (mistakeFiles?.length > 1) { problems.push(`${name}: more than one mistakes file (${mistakeFiles.join(', ')})`); continue; }
    if (mistakeFiles) {
      mistakesPath = path.join(dir, mistakeFiles[0]);
      const text = readText(mistakesPath, problems);
      if (text === null) continue;
      const parsed = parseMistakes(text);
      if (parsed.errors.length) {
        for (const error of parsed.errors) problems.push(`${mistakeFiles[0]} line ${error.line}: ${error.message}`);
        continue;
      }
      mistakes = { entries: parsed.entries };
    }

    // Optional answer / question / struck / assignment files. A missing file means "unknown" (null); an empty
    // question or struck file means "checked, none". Problems name the file and never repeat its content.
    const before = problems.length;
    const single = kind => {
      const files = sidecars[kind].get(name);
      if (!files) return null;
      if (files.length > 1) { problems.push(`${name}: more than one ${kind} file (${files.join(', ')})`); return null; }
      return { file: files[0], text: readText(path.join(dir, files[0]), problems) };
    };
    const answer = single('answer'), question = single('question'), struck = single('struck'), assignmentFile = single('assignment');
    let answerTruth = null, questionPhrases = null, struckPhrases = null, assignment = null;
    if (answer?.text != null) {
      if (!answer.text.trim()) problems.push(`${answer.file}: the answer file is empty`);
      else answerTruth = answer.text.replace(/\s+$/, '');
    }
    if (question?.text != null) {
      if (!answer) problems.push(`${question.file}: needs a matching ${name}.answer.txt (the answer without the copied question) to judge leaks`);
      questionPhrases = parsePhrases(question.text);
    }
    if (struck?.text != null) struckPhrases = parsePhrases(struck.text);
    if (assignmentFile?.text != null) {
      let parsed;
      try { parsed = JSON.parse(assignmentFile.text.replace(/^﻿/, '')); } catch { problems.push(`${assignmentFile.file}: is not valid JSON`); }
      if (parsed !== undefined) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) problems.push(`${assignmentFile.file}: must be a JSON object such as {"title": "...", "instructions": "..."}`);
        else {
          for (const [key, value] of Object.entries(parsed)) {
            if (!ASSIGNMENT_KEYS.includes(key)) problems.push(`${assignmentFile.file}: unknown key "${key.slice(0, 40)}" (allowed: ${ASSIGNMENT_KEYS.join(', ')})`);
            else if (typeof value !== 'string') problems.push(`${assignmentFile.file}: "${key}" must be text`);
          }
          assignment = parsed;
        }
      }
    }
    if (problems.length > before) continue;
    if (image.bytes > maxImageBytes) {
      warnings.push(`${image.file}: ${(image.bytes / 1048576).toFixed(1)} MB exceeds the ${(maxImageBytes / 1048576).toFixed(0)} MB production limit`);
    }
    items.push({
      name, imagePath: path.join(dir, image.file), imageExtension: image.extension, imageBytes: image.bytes,
      groundTruthPath, groundTruth, mistakesPath, mistakes, answerTruth, questionPhrases, struckPhrases, assignment,
    });
  }

  for (const [name, files] of [...texts].sort(([a], [b]) => naturalCompare(a, b))) {
    if (!images.has(name)) warnings.push(`${files.join(', ')}: skipped, there is no matching image (.jpg, .jpeg or .png)`);
  }
  for (const kind of Object.keys(sidecars)) {
    for (const [name, files] of [...sidecars[kind]].sort(([a], [b]) => naturalCompare(a, b))) {
      if (!images.has(name)) warnings.push(`${files.join(', ')}: ignored, there is no matching image`);
    }
  }

  if (problems.length) {
    throw new DatasetError(`The evaluation folder has ${problems.length} problem(s):\n - ${problems.join('\n - ')}`, problems);
  }
  if (!items.length) {
    throw new DatasetError(`No usable image + .txt pairs found in ${dir}. Expected files such as image1.jpeg with image1.txt.`);
  }
  return { directory: dir, items, warnings };
}

function readImageBytes(item) {
  return fs.readFileSync(item.imagePath);
}

module.exports = { DatasetError, IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, naturalCompare, isInsideDirectory, resolveEvalDir, loadDataset, readImageBytes };
