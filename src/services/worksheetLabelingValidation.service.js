const STOP_WORDS = new Set(['a', 'an', 'and', 'diagram', 'educational', 'for', 'image', 'label', 'labeling', 'of', 'photo', 'the', 'this', 'to', 'with']);

function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]+/g)?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) || []);
}

function overlaps(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  return [...a].some((word) => b.has(word));
}

const TOPIC_TERMS = {
  solar: ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'asteroid', 'orbit'],
  plant: ['root', 'roots', 'stem', 'leaf', 'leaves', 'flower', 'fruit', 'seed', 'petal', 'sepal', 'stamen', 'pistil'],
  animal: ['head', 'eye', 'ear', 'nose', 'mouth', 'leg', 'wing', 'tail', 'paw', 'fin', 'gill'],
  anatomy: ['brain', 'heart', 'lung', 'lungs', 'liver', 'stomach', 'kidney', 'bone', 'muscle'],
};

function labelsBelongToTopic(topic, labels) {
  const topicSet = tokens(topic);
  const group = Object.entries(TOPIC_TERMS).find(([key]) => topicSet.has(key));
  if (group) {
    const allowed = new Set(group[1]);
    return labels.every((label) => [...tokens(label?.text)].some((word) => allowed.has(word)));
  }
  return labels.some((label) => overlaps(topic, label?.text));
}

function validateLabelingActivity(activity, context = {}) {
  const data = activity?.data || {};
  const labels = Array.isArray(data.labels) ? data.labels : [];
  const topic = String(context.topic || activity?.title || '').trim();
  const imagePurpose = String(context.imagePurpose || data.imageDescription || data.imagePrompt || data.imageQuery || '').trim();
  const errors = [];

  if (!topic || !imagePurpose || !overlaps(`${activity?.title || ''} ${topic}`, imagePurpose)) errors.push('IMAGE_TOPIC_MISMATCH');
  if (!/(diagram|illustration|map|anatomy|schematic|chart)/i.test(imagePurpose)) errors.push('UNSUITABLE_IMAGE_TYPE');
  if (!labels.length || !labelsBelongToTopic(`${activity?.title || ''} ${topic} ${imagePurpose}`, labels)) errors.push('LABEL_TOPIC_MISMATCH');
  if (new Set(labels.map((label) => String(label?.text || '').trim().toLowerCase())).size !== labels.length) errors.push('DUPLICATE_LABELS');
  if (context.targetCount !== undefined && Number(context.targetCount) !== labels.length) errors.push('TARGET_COUNT_MISMATCH');
  if (labels.some((label) => !Number.isFinite(Number(label?.x)) || Number(label.x) < 5 || Number(label.x) > 95
    || !Number.isFinite(Number(label?.y)) || Number(label.y) < 5 || Number(label.y) > 95)) errors.push('INVALID_COORDINATES');
  const positions = new Set(labels.map((label) => `${Math.round(Number(label?.x))}:${Math.round(Number(label?.y))}`));
  if (positions.size !== labels.length) errors.push('IMPOSSIBLE_TARGET_PLACEMENT');

  return { valid: errors.length === 0, errors };
}

function buildLabelingImageQuery(activity, topic) {
  const labels = (activity?.data?.labels || []).map((label) => label.text).filter(Boolean).slice(0, 6).join(' ');
  return `educational diagram ${activity?.title || topic} ${labels}`.trim();
}

module.exports = { buildLabelingImageQuery, validateLabelingActivity };
