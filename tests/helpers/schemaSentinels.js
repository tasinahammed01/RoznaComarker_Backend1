'use strict';
// Puts a recognizable sentinel in every string, Mixed, array and number path of a mongoose schema that a document leaves empty, read from the
// schema itself, so a field added later is covered without being listed. Used by tests/studentSchemaNoLeak.test.js. Synthetic values only.
const isPlain = v => Boolean(v) && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const getAt = (object, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
function setAt(object, path, value) {
  const keys = path.split('.');
  let at = object;
  for (const key of keys.slice(0, -1)) { if (!isPlain(at[key])) at[key] = {}; at = at[key]; }
  at[keys.at(-1)] = value;
}

// Paths that decide who owns a document or whether it is processed: a sentinel here would stop the surface from answering at all.
const FUNCTIONAL = /^(_id|__v|id|createdAt|updatedAt|student|studentId|status)$/;
const BASE_NUMBER = 987000;

function sentinelFiller() {
  const numbers = new Map();
  let document = 0;
  const text = at => `LEAK_${at}~${document}`;
  const fill = (schema, doc, label) => schema.eachPath((path, type) => {
    if (FUNCTIONAL.test(path)) return;
    const at = `${label}.${path}`, current = getAt(doc, path);
    if (type.$isMongooseDocumentArray) {
      const list = Array.isArray(current) ? current : [];
      if (!list.length) list.push({});
      for (const item of list) if (isPlain(item)) fill(type.schema, item, `${at}[]`);
      setAt(doc, path, list);
    } else if (type.$isSingleNested) {
      const item = isPlain(current) ? current : {};
      fill(type.schema, item, at);
      setAt(doc, path, item);
    } else if (type.$isMongooseArray) {
      const list = Array.isArray(current) ? current : [];
      if (type.caster?.instance === 'String' && !list.length) list.push(text(`${at}[]`));
      if (type.caster?.instance === 'Mixed') {
        if (!list.length) list.push({ LEAK_key: text(`${at}[]`) });
        else for (const item of list) if (isPlain(item)) item.LEAK_extra = text(`${at}[].extra`);
      }
      setAt(doc, path, list);
    } else if (type.instance === 'Mixed') {
      if (current == null) setAt(doc, path, { LEAK_key: text(at) });
      else if (isPlain(current)) current.LEAK_extra = text(`${at}.extra`);
    } else if (type.instance === 'String' && !type.enumValues?.length && current == null) {
      setAt(doc, path, text(at));
    } else if (type.instance === 'Number' && current == null) {
      const number = BASE_NUMBER + numbers.size;
      numbers.set(number, at);
      setAt(doc, path, number);
    }
  });
  return {
    numbers,
    /** Every document of the model, through the raw collection so that no default or validator changes what is stored. */
    async fillModel(model, label = model.modelName) {
      for (const doc of await model.collection.find({}).toArray()) {
        document += 1;
        fill(model.schema, doc, label);
        await model.collection.replaceOne({ _id: doc._id }, doc);
      }
    },
  };
}

/** The sentinel names in a JSON response: `Model.path`, without the per-document suffix. */
function sentinelsIn(value, numbers, out = new Set()) {
  if (Array.isArray(value)) value.forEach(item => sentinelsIn(item, numbers, out));
  else if (isPlain(value)) Object.values(value).forEach(item => sentinelsIn(item, numbers, out));
  else if (typeof value === 'string') for (const match of value.match(/LEAK_[^\s~"']+/g) || []) out.add(match.slice('LEAK_'.length));
  else if (typeof value === 'number' && numbers.has(value)) out.add(numbers.get(value));
  return out;
}

module.exports = { sentinelFiller, sentinelsIn };
